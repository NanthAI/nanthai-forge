import {
  hostedDiffSchema,
  hostedPeersSchema,
  diffHostedSource,
  peersHostedSource,
  queueHostedSource,
  hostedQueueSchema,
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
import { AGENT_WAIT_SECONDS, operationWait } from './agent-operation-wait.js';
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
        'friction-triage',
        'decide',
        'peer-ack',
        'overlap-acks',
        'ack',
        'preflight',
      ],
      description:
        'pull {} refreshes a clean clone to main; Lane sync is unchanged. Verbs {action:start|save|land,mode?,...}: start open|reopen; save sync|candidate|overlap-answer|overlap-answers|friction|decision; land save (checkOnly:true checks only). Old names work; checkpoint=save. Unknown reply: replay original parameters/UUID; new UUID=new work. Finish always requests agent acceptance under current policy, including account auth. Pending is not accepted. Keep this turn active and follow the returned next/command wait on the original operation; repeat on IN PROGRESS and follow terminal recovery before reporting completion. finish priority:urgent and pin are owner-only; others retain normal priority with a reason. prioritize: urgent|normal; running checks continue. Pinned Lanes skip complete-merged, completeOnAccept, Intent cascade, prune and cache GC; unpin before explicit complete/abandon. ack answers pending Lane overlaps. preflight runs saved-head affected tests here and records evidence for land.',
    },
    {
      name: 'forge_check',
      actions: ['check', 'run', 'observe', 'tests', 'confirm-tests'],
      description:
        'save modes check|contract use check/confirm-tests fields; old names work, run=check. tests proposes proving tests; confirm-tests stores a <90s contract from complete exact-Candidate timings (runId,expectedHead,expectedVersion). Optional tests replaces that list; gates unchanged. Check a pinned Candidate or finitely read a run/source operation/submission. Reads start no compute/subscription; forge_wait observes live.',
    },
    {
      name: 'forge_work_overview',
      actions: ['status', 'capabilities', 'metrics', 'decisions', 'friction-list'],
      description:
        'Read paged metrics/decisions/friction-list, capabilities or one Lane/run/operation/submission. Decisions: target?, cursor?. friction-list: status?(default open),area?,laneId?,search?,limit?,cursor?; friction-triage (forge_task) dismisses (dropped+reason) or links an Issue (planned+planningItemId). No Work hydration, wakes or idle observer.',
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
    hostedAgentCommandSchemas[action].safeExtend({
      action: z.literal(action),
      operationId: z.uuid().optional(),
    }),
  );
  server.registerTool(
    'forge_planning',
    {
      description:
        'Planning: indexed title/body search; active by default, status:all includes history. Filter kind/status/initiativeId; cursor pages or id+comments. reconcile:false skips Intent updates. New Issues/friction return advisory likelyDuplicates. put-planning-item replaces at expectedVersion (0 creates); comment-planning-item adds discussion. Start via forge_task {action:start,planningItemId}.',
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
        'show: exact Lane/main/state/candidateId file; force permits binary/large bytes. diff: pinned Lane base to saved head, paths/byteBudget/cursor. peers: laneId/path/detail saved overlap evidence; incomplete coverage never proves independence. queue: landing queue entries (Lane, Intent, phase, failing tests, recompose count). Unsaved bytes excluded.',
      inputSchema: {
        command: z.union([
          hostedSourceShowSchema,
          hostedDiffSchema.extend({ action: z.literal('diff') }),
          hostedPeersSchema.extend({ action: z.literal('peers') }),
          hostedQueueSchema.extend({ action: z.literal('queue') }),
        ]),
      },
      annotations: read,
    },
    ({ command }) =>
      result(() => {
        if (command.action === 'show') return showHostedSource(transport, command);
        const { action, ...input } = command;
        if (action === 'queue') return queueHostedSource(transport, input);
        return action === 'diff' ? diffHostedSource(transport, input) : peersHostedSource(transport, input);
      }),
  );
  server.registerTool(
    'forge_wait',
    {
      description:
        'Block on the original run or landing operationIds for up to maxWaitMs (default 540000; set it under your client tool timeout). Unfinished work returns IN_PROGRESS with one resume command: call again; follow the terminal outcome and recovery before ending the turn. progressToken enables progress notifications. Only this call subscribes; no polling.',

      inputSchema: {
        ...hostedWaitSchema.shape,
        maxWaitMs: z.number().int().nonnegative().max(86_400_000).optional(),
      },
      annotations: read,
    },
    async ({ maxWaitMs, ...input }, extra) => {
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
          const budgetSeconds =
            maxWaitMs !== undefined ? maxWaitMs / 1000 : (input.timeoutSeconds ?? AGENT_WAIT_SECONDS);
          const observed = await (input.runId ? observeHostedRun : observeHostedSubmissions)(
            transport,
            { ...input, timeoutSeconds: budgetSeconds },
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
          const single =
            'submissions' in observed.result && observed.result.submissions.length === 1
              ? observed.result.submissions[0]
              : undefined;
          if (['timeout', 'cancelled'].includes(observed.result.status)) {
            const { next, command, waitCommand, inProgress } = operationWait(transport.root, {
              ...input,
              ...transport.address,
            });
            const resume = { next, command, waitCommand, inProgress };
            const run = 'run' in observed.result ? (observed.result.run as { status?: string } | null) : null;
            return {
              ...observed,
              result: {
                status: 'IN_PROGRESS',
                reason: observed.result.status === 'timeout' ? 'budget' : 'cancelled',
                budgetSeconds,
                phase: input.runId
                  ? (run?.status ?? 'unknown')
                  : ((single?.submission as { phase?: string } | undefined)?.phase ?? 'pending'),
                ...('cursor' in observed.result ? { cursor: observed.result.cursor } : {}),
                ...resume,
              },
            };
          }
          return { ...observed, result: { ...observed.result, ...single } };
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
