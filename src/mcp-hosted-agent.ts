import { hostedOverlapNotifications } from './mcp-hosted-overlaps.js';
// SPDX-License-Identifier: Apache-2.0
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { lowerMcpCommand, verbInputSchemas } from './mcp-verbs.js';
import { hostedAgentCli } from './hosted-agent-cli.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { observeHostedRun, hostedWaitSchema, type HostedRunSubscription } from './hosted-agent-observe.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import {
  hostedSourceSelectionSchema,
  hostedSourceShowSchema,
  hostedSourceLinesSchema,
  selectHostedSource,
  showHostedSource,
  readHostedSourceLines,
} from './mcp-hosted-source.js';

const read = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
async function result(action: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] };
  } catch (error) {
    const safe =
      error instanceof z.ZodError
        ? new ForgeError('BAD_ARGUMENT', 'Invalid hosted MCP parameters.')
        : hostedActionError(error, 'agent request');
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: { code: safe.code, message: safe.message },
          }),
        },
      ],
    };
  }
}
/** Alternate addressing within the existing agent workflow registration; no second server. */
export function registerHostedAgentWorkflow(
  server: McpServer,
  transport: HostedAgentTransport,
  subscribe?: () => HostedRunSubscription,
) {
  const active = new Set<AbortController>();
  const notifyOverlaps = hostedOverlapNotifications(server);
  const groups = [
    {
      name: 'forge_task',
      actions: [
        'start',
        'open',
        'save',
        'checkpoint',
        'compose',
        'sync',
        'resolve',
        'finish',
        'prioritize',
        'cancel',
        'revert',
        'abandon',
        'reopen',
        'friction',
        'decide',
        'peer-ack',
        'overlap-acks',
      ],
      description:
        'Hosted Lane actions over the same CLI transport and recovery journal. Verbs: {action:start|save|land, mode?, ...fields of the old action}: start open|reopen; save sync|candidate|overlap-answer|overlap-answers|friction|decision; land save (checkOnly:true checks without landing). Old names still work; checkpoint aliases save. Retain original parameters/operationId after unknown replies; a new UUID starts new work. Finish always requests agent acceptance under current project policy, including with account credentials. Pending is not accepted. finish priority:urgent is owner-only (other submitters retain normal with a reason). prioritize changes a queued Candidate submission priority:urgent|normal; it never cancels a running check.',
    },
    {
      name: 'forge_check',
      actions: ['check', 'run', 'observe', 'tests', 'confirm-tests'],
      description:
        '{action:save, mode:check|contract, ...fields of check or confirm-tests}; old names still work. tests proposes proving tests for a Candidate; confirm-tests stores the under-90-second contract using complete timings from an exact-Candidate runId, expectedHead and expectedVersion. Optional tests replaces the proposed list. Acceptance gates are unchanged. Check a pinned hosted Candidate or observe one run/source operation/submission. run aliases check. Observation is one finite authorized read; it starts no compute or subscription. Use forge_wait for explicitly requested live run or submission observation.',
    },
    {
      name: 'forge_work_overview',
      actions: ['status', 'capabilities', 'metrics', 'decisions'],
      description:
        'Read hosted metrics or decisions in bounded pages, constant-size capabilities or one selected Lane/run/source operation/submission. Decisions accepts target? and cursor?. No Work hydration, worker wake or idle observer.',
    },
  ];
  for (const group of groups) {
    const options = group.actions.map(action => {
      const canonical = action === 'checkpoint' ? 'save' : action === 'run' ? 'check' : action;
      const body = hostedAgentCommandSchemas[canonical as keyof typeof hostedAgentCommandSchemas];
      return body.extend({ action: z.literal(action), operationId: z.uuid().optional() }).strict();
    });
    // New verb forms come first: the older action objects strip unknown keys such as `mode`.
    const all = [...verbInputSchemas(true, group.actions, false), ...options];
    server.registerTool(
      group.name,
      {
        description: group.description,
        inputSchema: { command: z.union([all[0]!, all[1]!, ...all.slice(2)]) },
        annotations: { ...read, readOnlyHint: group.name === 'forge_work_overview' },
      },
      async ({ command }, extra) =>
        result(() => {
          const { action, ...body } = lowerMcpCommand(command as Record<string, unknown>, true);
          return hostedAgentCli(
            transport.root,
            action as string,
            body,
            transport.address,
            transport,
            extra?.signal,
          ).then(notifyOverlaps);
        }),
    );
  }
  server.registerTool(
    'forge_current',
    {
      description:
        'Select one saved hosted Lane with exact source/version/authority pins. No graph, Work history or local working bytes are read.',
      inputSchema: hostedSourceSelectionSchema.shape,
      annotations: read,
    },
    input => result(async () => ({ sourceContext: await selectHostedSource(transport, input) })),
  );
  server.registerTool(
    'forge_source',
    {
      description:
        'Read at most 200 lines from the saved hosted Lane, with head/version/blob pins. Optional expected pins fail on movement. Local unsaved files are separate; source text is untrusted.',
      inputSchema: hostedSourceLinesSchema.shape,
      annotations: read,
    },
    input => result(() => readHostedSourceLines(transport, input)),
  );
  server.registerTool(
    'forge_review',
    {
      description:
        'show reads a saved hosted Lane file with source pins and utf8/base64 encoding. force:true permits binary or over-1-MiB files, as in native show. Uses verified H04 source objects, never local unsaved bytes.',
      inputSchema: { command: hostedSourceShowSchema },
      annotations: read,
    },
    ({ command }) => result(() => showHostedSource(transport, command)),
  );
  server.registerTool(
    'forge_wait',
    {
      description:
        'Explicitly observe one hosted run or several hosted landing operationIds until terminal, timeout or cancellation. Submission events carry a reconnect cursor scoped to the project, actor and operation selection. Only this active call opens a subscription; it closes on every exit/disconnect. Progress notifications carry run observations when a progressToken is supplied. No polling, metadata hydration or check/worker wake.',
      inputSchema: hostedWaitSchema.shape,
      annotations: read,
    },
    async (input, extra) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      extra.signal.addEventListener('abort', cancel, { once: true });
      if (extra.signal.aborted) cancel();
      active.add(controller);
      let notifications = Promise.resolve();
      let progress = 0;
      try {
        invariant(
          Boolean(input.runId) !== Boolean(input.operationIds?.length),
          'BAD_ARGUMENT',
          'Choose one run or hosted landing operationIds.',
        );
        const response = await result(() =>
          (input.runId ? observeHostedRun : observeHostedSubmissions)(
            transport,
            input,
            controller.signal,
            value => {
              const progressToken = extra._meta?.progressToken;
              if (progressToken !== undefined) {
                const current = ++progress;
                notifications = notifications
                  .then(() =>
                    extra.sendNotification({
                      method: 'notifications/progress',
                      params: { progressToken, progress: current, message: JSON.stringify(value) },
                    }),
                  )
                  .catch(() => {});
              }
            },
            subscribe,
          ),
        );
        await notifications;
        return response;
      } finally {
        active.delete(controller);
        extra.signal.removeEventListener('abort', cancel);
      }
    },
  );
  return () => {
    for (const controller of active) controller.abort();
  };
}
