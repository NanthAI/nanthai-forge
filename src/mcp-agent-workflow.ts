import { callerOverlaps, withCallerOverlaps } from './agent-caller-overlaps.js';
import { drainAgentAdvisories } from './agent-advisory-worker.js';
import { registerAgentWait } from './mcp-agent-wait.js';
import { localActor } from './work-actor.js';
import { overlapNotifications } from './mcp-overlap-notifications.js';
import { candidateActionSchema } from './candidate-names.js';
// SPDX-License-Identifier: Apache-2.0
import { peersInputSchema } from './agent-peers.js';
import { controlQueue } from './queue-control.js';
import { registerHostedWorkTools } from './mcp-hosted-work.js';
import { registerExchangeTools } from './mcp-exchange.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentWorkflow, agentActionSchema } from './agent-workflow.js';
import { briefInputSchema } from './agent-brief-types.js';
import { agentBrief } from './agent-brief.js';
import { ForgeError } from './errors.js';
import { readPendingStatus, type PendingStatusOptions } from './pending-status-read.js';
import { hostedAgentAddress } from './hosted-agent-cli.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { registerHostedAgentWorkflow } from './mcp-hosted-agent.js';

export function registerAgentWorkflow(server: McpServer, root: string, hosted?: HostedAgentTransport) {
  const address = hosted ? null : hostedAgentAddress(root, {});
  if (hosted || address)
    return registerHostedAgentWorkflow(server, hosted ?? new HostedAgentTransport(root, address!));
  const agent = new AgentWorkflow(root, true);
  registerAgentWait(server, agent.work.store);
  const notifications = overlapNotifications(server, agent.work.store);
  server.registerTool(
    'forge_peers',
    {
      description:
        'Read local path overlaps, predictive region/export overlaps against peer checkpoints and landed-since-base dry sync. Predictive advice includes ranges, peer Intent and suggested landing order; never blocks. Advisory, no locks or hosted calls. detail:true includes low/disjoint regions and entries omitted by the compact lifecycle digest. scope.paths declares relevance for this read only.',
      inputSchema: peersInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async input => {
      notifications.select(input.laneId);
      const response = await agent.dispatch({ action: 'peers', ...input });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...(response.result as object),
              ...('unacknowledgedOverlaps' in response
                ? { unacknowledgedOverlaps: response.unacknowledgedOverlaps }
                : {}),
            }),
          },
        ],
      };
    },
  );
  server.registerTool(
    'forge_queue',
    {
      description:
        'List local finish/check queue positions, cancel a finish and its check process groups, or prioritize an operation. Repeated mutations reconcile the same ticket markers.',
      inputSchema: { action: z.enum(['list', 'cancel', 'prioritize']), operation: z.string().optional() },
    },
    async ({ action, operation }) => {
      try {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                withCallerOverlaps(root, controlQueue(action, operation, undefined, localActor('agent'))),
              ),
            },
            ...(action === 'list' && callerOverlaps(root)
              ? [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ unacknowledgedOverlaps: callerOverlaps(root) }),
                  },
                ]
              : []),
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                withCallerOverlaps(root, {
                  error: {
                    code: error instanceof ForgeError ? error.code : 'INTERNAL_ERROR',
                    message: error instanceof ForgeError ? error.message : 'Queue action failed.',
                  },
                }),
              ),
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    'forge_brief',
    {
      description:
        'Read a deterministic, current agent briefing for a Forge situation. Repository instruction paths take precedence; source contents are never included.',
      inputSchema: briefInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async input => {
      notifications.select(input.laneId);
      try {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                withCallerOverlaps(root, await agentBrief(agent.work.store, input, true), input.laneId),
              ),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                withCallerOverlaps(root, {
                  error: {
                    code: error instanceof ForgeError ? error.code : 'INTERNAL_ERROR',
                    message: error instanceof ForgeError ? error.message : 'Briefing could not be read.',
                  },
                }),
              ),
            },
          ],
        };
      }
    },
  );
  registerHostedWorkTools(server);
  registerExchangeTools(server, root);
  const groups = [
    {
      name: 'forge_task',
      actions: [
        'pre-edit',
        'install-hooks',
        'uninstall-hooks',
        'start',
        'friction',
        'decide',
        'friction-triage',
        'take',
        'checkpoint',
        'sync',
        'undo-sync',
        'undo-revert',
        'set-policy',
        'compose',
        'finish',
        'land-ready',
        'land',
        'accept',
        'complete',
        'abandon',
        'reopen',
        'complete-merged',
        'clean',
        'guidance',
        'peer-ack',
        'handoff',
      ],
      description:
        'decide {target:{kind:"project"}|{kind:"intent",intentId},decidedBy,what,why,decidedAt?,overrides?,supersedes?} records a decision with actor/requester attribution. overrides names a decisionId or a default description with an optional link; supersedes retains the old decision linked to its replacement. Decisions supply context and do not enforce policy. friction captures structured workflow cost in append-only owner Work; friction-triage marks ids planned, fixed (laneId), dropped or open with a reason; start/finish frictionIds close on landing. handoff {laneId,summary,changes?,tests?,unrun?,next?,evidence?} stores an optional portable delivery note. Test counts remain self-reported; saved-head check operation IDs are linked automatically as Forge-recorded evidence. Start/checkpoint return durable source/Work receipts with queued hosted activity, indexed peers and pending overlaps without the owner writer lock; incomplete indexes report local-incomplete. Saved predictions, committed contract notices, repair/sync lineage and locally resolvable URLs are included; unavailable local identity returns links.error without a network wait. Source refresh, overlap recomputation and previews remain detached and MCP shutdown joins its refreshes. Other lifecycle receipts include local peers, saved high-overlap inbox notices and pre-compose conflict notices; peers detail:true returns exact hunks, intents, messages and known owner sessions. peer-ack records accept-order, swap or split advisory choices using noticeId and laneId; it never pauses or resolves source. start scope.paths retains planned claims; other calls add relevance for that call. take transfers an open Lane with context; takeover:true is required for another actor’s Lane, and ownership remains advisory. Clean checkpoints reuse the unchanged head. Start isolated work (intentId adds a sibling Lane; after records a landing dependency), checkpoint edits, sync a Lane with main, undo-sync, set-policy, compose Lane heads, finish (checkpoint, sync, compose, check, optional accept:true) or accept a Candidate; finish with:[laneId] uses saved sibling heads; acceptance separates high overlaps into ordered Candidates on current main; land-ready resumes dependency waits. Acceptance follows project policy and completes input Lanes when completeOnAccept is enabled unless keepOpen:true. Finish retries CHANNEL_CHANGED up to maxRetries (default 3), checking without Work/Lane/Channel locks and queuing only acceptance; receipts list attempts and waiting positions. land returns a durable handle by default; wait:true watches it without driving or cancelling work. landing {operationId} reads that handle without mutation. finish wait:false returns after durable enqueue; the owner worker drives pending work and an offline worker is reported. Observe status, pending-status or forge_wait; changing wait observes the same operation. land {operationId,laneIds,message?} submits selected saved heads without checkpointing and returns a handle, current phase and replay command; a fresh operation for the same heads reuses existing entries; keep operationId after an unknown reply. Supervised finish stops at awaiting-review. Automatic sync/acceptance records undo instructions. abandon a Lane or Intent with a reason (saveFirst saves dirty edits; cascade closes open child Lanes); complete/reopen a Lane or Intent; complete-merged completes Lanes already in main. clean lists (default) or with apply:true deletes regenerable local disk: finished check workspaces, build dirs and fully captured directories of completed Lanes (reopen restores them). Work/Lane locks wait FIFO (default ten minutes; lockWaitMs or FORGE_WORK_LOCK_WAIT_MS), with periodic stderr phase/run/queue/holder progress; start/checkpoint/sync also accept waitMs. Omitted pins are filled and returned as resolved; retry an unknown outcome with them.',
    },
    {
      name: 'forge_check',
      actions: ['tests', 'confirm-tests', 'define-check', 'run', 'observe', 'log', 'cancel'],
      description:
        'confirm-tests stores an Intent proving-test contract for candidateId using completed exact-Candidate timing runId, expectedHead, expectedVersion and operationId. tests proposes the contract; optional tests replaces the proposed list. No gate changes. Read the scoped landing test selection for a Lane saved head versus main with tests {laneId} (scope, reason, tests, shell command and source pins; no check started). Configure and run exact-Candidate local checks, observe the original run, read a log page or cancel. Runs use a clean environment with private HOME/XDG/temp. Define env/credentials variable names for explicit passthrough; values are not retained. Runs are local OS processes, not sandboxes.',
    },
    {
      name: 'forge_work_overview',
      actions: [
        'handoff-read',
        'improve',
        'metrics',
        'decisions',
        'pending-status',
        'peers',
        'status',
        'landing',
        'records',
        'policy',
        'link',
        'making-of',
        'report',
      ],
      description:
        'metrics {from?,to?} reports all self-metrics per UTC day and window with source counts and named partial gaps. decisions {target?} lists all retained decisions or one project/Intent target with status and replacement links. handoff-read {laneId} reads the latest portable delivery note. pending-status reads indexed local pending-work/recovery summary pages from one pinned revision without the writer lock. offset/limit page records; detail:true includes submission journals, evidence-file metadata and overlap planning. Skipped sections are named. No remote calls, process recovery or archive export. Read Forge URLs with link (laneId, viewId or save; optional path/line), policy, concise Work pins and counts, or page one retained collection directly with records without reconstructing all Work history. making-of reads one Intent’s derived record: Lanes, saves, check runs with queued/running time, landings, sessions, wall clock and active time. report records cumulative self-reported harness, model and token totals for a Lane session (advisory). All source and history remain retained.',
    },
    {
      name: 'forge_review',
      actions: ['review', 'diff', 'show', 'view', 'provenance', 'views'],
      description:
        'diff reads a live Lane or from/to pinned States using the review budgets and paths filter; show reads a pinned State file (laneId selects its saved head), returning content with utf8 or base64 encoding; force:true permits binary or over-1-MiB files. Read an exact Lane or Candidate changed-path summary or selected contextual hunks. Use candidate and candidates; view and views are deprecated aliases. JSON fields (viewId, views) are unchanged. Truncation and unknown coverage stay explicit.',
    },
  ];
  for (const group of groups) {
    const options = agentActionSchema.options
      .filter(option => group.actions.includes(option.shape.action.value))
      .map(option => candidateActionSchema(option, option.shape.action.value));
    const extended =
      group.name === 'forge_work_overview'
        ? [
            ...options,
            z.object({
              action: z.literal('pending-status'),
              detail: z.boolean().optional(),
              offset: z.number().int().nonnegative().optional(),
              limit: z.number().int().positive().optional(),
            }),
          ]
        : options;
    const schema =
      extended.length === 1 ? extended[0]! : z.union([extended[0]!, extended[1]!, ...extended.slice(2)]);
    server.registerTool(
      group.name,
      {
        description: group.description,
        inputSchema: { command: schema },
        annotations: {
          readOnlyHint: group.actions.every(action =>
            [
              'pending-status',
              'improve',
              'metrics',
              'tests',
              'link',
              'review',
              'diff',
              'show',
              'records',
              'view',
              'provenance',
              'views',
            ].includes(action),
          ),
          destructiveHint: group.actions.includes('clean'),
          idempotentHint: group.actions.every(action =>
            [
              'pending-status',
              'improve',
              'metrics',
              'tests',
              'link',
              'status',
              'policy',
              'records',
              'making-of',
              'report',
              'review',
              'diff',
              'show',
              'view',
              'provenance',
              'views',
              'observe',
              'log',
            ].includes(action),
          ),
          openWorldHint:
            group.actions.includes('run') ||
            group.actions.includes('finish') ||
            group.actions.includes('land'),
        },
      },
      async ({ command }) => {
        try {
          notifications.select(
            'laneId' in command && typeof command.laneId === 'string' ? command.laneId : undefined,
          );
          const response =
            command.action === 'pending-status'
              ? readPendingStatus(agent.work.store, undefined, undefined, command as PendingStatusOptions)
              : await agent.dispatch(command);
          if (command.action === 'start')
            notifications.select((response as { result: { laneId: string } }).result.laneId);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(withCallerOverlaps(root, response)),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  withCallerOverlaps(root, {
                    error: {
                      code: error instanceof ForgeError ? error.code : 'INTERNAL_ERROR',
                      message:
                        error instanceof ForgeError
                          ? error.message
                          : 'Forge could not complete the agent action.',
                    },
                  }),
                ),
              },
            ],
          };
        }
      },
    );
  }
  return async () => {
    notifications.close();
    await drainAgentAdvisories(root);
  };
}
