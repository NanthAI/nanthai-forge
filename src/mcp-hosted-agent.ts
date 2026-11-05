import {
  hostedDiffSchema,
  hostedPeersSchema,
  diffHostedSource,
  peersHostedSource,
} from './hosted-agent-reads.js';
import { hostedOverlapNotifications } from './mcp-hosted-overlaps.js';
// SPDX-License-Identifier: Apache-2.0
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AGENT_DEFAULTS,
  agentDefaultLines,
  effectiveAgentDefaults,
  type EffectiveAgentDefaults,
} from './agent-parallel-defaults.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { z } from 'zod';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { lowerMcpCommand, verbInputSchemas } from './mcp-verbs.js';
import { hostedAgentCli } from './hosted-agent-cli.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { observeHostedRun, hostedWaitSchema, type HostedRunSubscription } from './hosted-agent-observe.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { operationWait } from './agent-operation-wait.js';
import {
  hostedSourceSelectionSchema,
  hostedSourceShowSchema,
  hostedSourceLinesSchema,
  selectExactHostedSource,
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
            error: {
              code: safe.code,
              message: safe.message,
              ...(safe.recovery ? { recovery: safe.recovery } : {}),
            },
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
        'recover-apply',
        'pull',
        'finish',
        'prioritize',
        'pin',
        'cancel',
        'revert',
        'abandon',
        'reopen',
        'friction',
        'decide',
        'peer-ack',
        'overlap-acks',
        'ack',
        'preflight',
      ],
      description:
        "Hosted actions use CLI transport/journal. pull {} refreshes clone root to main, refusing local edits; Lane sync unchanged. {action:start|save|land,mode?,...legacy fields}: start open|reopen; save sync|candidate|overlap-answer|overlap-answers|friction|decision; land save (checkOnly:true checks without landing). Legacy names work; checkpoint=save. Replay original parameters/operationId after unknown replies; new UUID=new work. Finish requests agent acceptance under project policy, also with account credentials. Pending is not accepted: keep the turn active, use next/command on the original operation, repeat IN PROGRESS, then terminal recovery. finish priority:urgent is owner-only; others retain normal with a reason. prioritize updates queued priority:urgent|normal, never running checks. Owner pin {laneId?,pinned?:true|false} skips complete-merged, completeOnAccept, Intent cascade, prune and cache GC; explicit complete/abandon refuses until unpinned. ack answers all pending Lane overlaps. preflight runs the saved head's affected tests here and records the result for land.",
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
        'Read paged metrics/decisions, capabilities or one Lane/run/operation/submission. Decisions: target?, cursor?. No Work hydration, wakes or idle observer.',
    },
  ];
  // Project rules: defaults until the first call reads the live policy, then regenerated from it.
  const rules = (defaults: EffectiveAgentDefaults) =>
    `\nProject rules:\n${agentDefaultLines(defaults)
      .map(line => `- ${line}`)
      .join('\n')}`;
  let applied = canonicalPayload(AGENT_DEFAULTS);
  const task = { description: groups[0]!.description, tool: undefined as RegisteredTool | undefined };
  const refreshRules = <T>(value: T) => {
    const live = transport.agentDefaults;
    if (live && canonicalPayload(live) !== applied && task.tool) {
      applied = canonicalPayload(live);
      task.tool.update({ description: task.description + rules(live) });
    }
    return value;
  };
  groups[0]!.description += rules(effectiveAgentDefaults(undefined));
  for (const group of groups) {
    const options = group.actions.map(action => {
      const canonical = action === 'checkpoint' ? 'save' : action === 'run' ? 'check' : action;
      const body = hostedAgentCommandSchemas[canonical as keyof typeof hostedAgentCommandSchemas];
      return body.extend({ action: z.literal(action), operationId: z.uuid().optional() }).strict();
    });
    // New verb forms come first: the older action objects strip unknown keys such as `mode`.
    const all = [...verbInputSchemas(true, group.actions, false), ...options];
    const tool = server.registerTool(
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
          )
            .then(notifyOverlaps)
            .then(refreshRules);
        }),
    );
    if (group.name === 'forge_task') task.tool = tool;
  }
  const planning = (['planning', 'put-planning-item', 'comment-planning-item'] as const).map(action =>
    hostedAgentCommandSchemas[action].extend({ action: z.literal(action), operationId: z.uuid().optional() }),
  );
  server.registerTool(
    'forge_planning',
    {
      description:
        'The backlog: Initiatives and Issues. planning {id?,kind?,status?,initiativeId?,limit?,cursor?} reads a page or one item with comments (closes Issues whose Intent finished unless reconcile:false). put-planning-item replaces an item at expectedVersion (0 creates). comment-planning-item records a decision. Start work with forge_task start {planningItemId}.',
      inputSchema: { command: z.union([planning[0]!, planning[1]!, planning[2]!]) },
      annotations: { ...read, readOnlyHint: false },
    },
    ({ command }, extra) =>
      result(() => {
        const { action, ...body } = command;
        return hostedAgentCli(transport.root, action, body, transport.address, transport, extra?.signal);
      }),
  );
  server.registerTool(
    'forge_current',
    {
      description: 'Select exact Lane, main, State or Candidate source pins; excludes local drafts.',
      inputSchema: hostedSourceSelectionSchema.shape,
      annotations: read,
    },
    input => result(async () => ({ sourceContext: await selectExactHostedSource(transport, input) })),
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
        'show: exact Lane/main/state/candidateId file; force permits binary/large bytes. diff: pinned Lane base to saved head, paths/byteBudget/cursor. peers: laneId/path/detail saved overlap evidence; incomplete coverage never proves independence. Unsaved bytes excluded.',
      inputSchema: {
        command: z.union([
          hostedSourceShowSchema,
          hostedDiffSchema.extend({ action: z.literal('diff') }),
          hostedPeersSchema.extend({ action: z.literal('peers') }),
        ]),
      },
      annotations: read,
    },
    ({ command }) =>
      result(() => {
        if (command.action === 'show') return showHostedSource(transport, command);
        const { action, ...input } = command;
        return action === 'diff' ? diffHostedSource(transport, input) : peersHostedSource(transport, input);
      }),
  );
  server.registerTool(
    'forge_wait',
    {
      description:
        'Block on original run/landing operationIds; keep the turn active. Timeout/cancellation returns same-target next/command; repeat IN PROGRESS, then terminal recovery. Cursor binds project, actor, operations. Only this call subscribes; disconnect closes it. progressToken enables progress notifications. No polling or compute wake.',
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
        const response = await result(async () => {
          const observed = await (input.runId ? observeHostedRun : observeHostedSubmissions)(
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
          );
          return {
            ...observed,
            result: {
              ...observed.result,
              ...('submissions' in observed.result && observed.result.submissions.length === 1
                ? observed.result.submissions[0]
                : {}),
              ...(['timeout', 'cancelled'].includes(observed.result.status)
                ? operationWait(transport.root, { ...input, ...transport.address })
                : {}),
            },
          };
        });
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
