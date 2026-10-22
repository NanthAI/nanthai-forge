import { candidateActionSchema } from './candidate-names.js';
// SPDX-License-Identifier: Apache-2.0
import { agentPeers, peersInputSchema } from './agent-peers.js';
import { controlQueue } from './queue-control.js';
import { registerHostedWorkTools } from './mcp-hosted-work.js';
import { registerExchangeTools } from './mcp-exchange.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentWorkflow, agentActionSchema } from './agent-workflow.js';
import { briefInputSchema } from './agent-brief-types.js';
import { agentBrief } from './agent-brief.js';
import { ForgeError } from './errors.js';
import { readPendingStatus } from './pending-status-read.js';

export function registerAgentWorkflow(server: McpServer, root: string) {
  const agent = new AgentWorkflow(root, true);
  server.registerTool(
    'forge_peers',
    {
      description:
        'Read local path overlaps, predictive region/export overlaps against peer checkpoints and landed-since-base dry sync. Predictive advice includes ranges, peer Intent and suggested landing order; never blocks. Advisory, no locks or hosted calls. detail:true includes low/disjoint regions and entries omitted by the 1.5 KB lifecycle digest. scope.paths declares relevance for this read only.',
      inputSchema: peersInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async input => ({
      content: [{ type: 'text' as const, text: JSON.stringify(agentPeers(agent.work.store, input)) }],
    }),
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
          content: [{ type: 'text' as const, text: JSON.stringify(controlQueue(action, operation)) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: {
                  code: error instanceof ForgeError ? error.code : 'INTERNAL_ERROR',
                  message: error instanceof ForgeError ? error.message : 'Queue action failed.',
                },
              }),
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
      try {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(await agentBrief(agent.work.store, input, true)) },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: {
                  code: error instanceof ForgeError ? error.code : 'INTERNAL_ERROR',
                  message: error instanceof ForgeError ? error.message : 'Briefing could not be read.',
                },
              }),
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
        'start',
        'friction',
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
        'friction captures structured workflow cost in append-only owner Work; friction-triage marks ids planned, fixed (laneId), dropped or open with a reason; start/finish frictionIds close on landing. handoff {laneId,summary,changes?,tests?,unrun?,next?,evidence?} stores an optional portable delivery note. Test counts remain self-reported; saved-head check operation IDs are linked automatically as Forge-recorded evidence. Receipts include local peers and pre-compose conflict notices; peers detail:true returns exact hunks, intents, messages and known owner sessions. peer-ack records accept-order, swap or split advisory choices using noticeId and laneId; it never pauses or resolves source. start scope.paths retains planned claims; other calls add relevance for that call. take transfers an open Lane with context; takeover:true is required for another actor’s Lane, and ownership remains advisory. Clean checkpoints reuse the unchanged head. Start isolated work (intentId adds a sibling Lane; after records a landing dependency), checkpoint edits, sync a Lane with main, undo-sync, set-policy, compose Lane heads, finish (checkpoint, sync, compose, check, optional accept:true) or accept a Candidate; finish with:[laneId] composes sibling recorded heads together; land-ready resumes dependency waits. Acceptance follows project policy and completes input Lanes when completeOnAccept is enabled unless keepOpen:true. Finish retries CHANNEL_CHANGED up to maxRetries (default 3), checking without Work/Lane/Channel locks and queuing only acceptance; receipts list attempts and waiting positions. land {operationId,laneIds,message?} lands selected saved heads without checkpointing, queues compatible entries before checking, and returns aggregate outcomes plus a replay command; keep operationId after an unknown reply. Supervised finish stops at awaiting-review. Automatic sync/acceptance records undo instructions. abandon a Lane or Intent with a reason (saveFirst saves dirty edits; cascade closes open child Lanes); complete/reopen a Lane or Intent; complete-merged completes Lanes already in main. clean lists (default) or with apply:true deletes regenerable local disk: finished check workspaces, build dirs and fully captured directories of completed Lanes (reopen restores them). Work/Lane locks wait FIFO (default ten minutes; lockWaitMs or FORGE_WORK_LOCK_WAIT_MS), with periodic stderr phase/run/queue/holder progress; start/checkpoint/sync also accept waitMs. Omitted pins are filled and returned as resolved; retry an unknown outcome with them.',
    },
    {
      name: 'forge_check',
      actions: ['tests', 'define-check', 'run', 'observe', 'log', 'cancel'],
      description:
        'Read the scoped landing test selection for a Lane saved head versus main with tests {laneId} (scope, reason, tests, shell command and source pins; no check started). Configure and run exact-Candidate local checks, observe the original run, read a log page or cancel. Runs use a clean environment with private HOME/XDG/temp. Define env/credentials variable names for explicit passthrough; values are not retained. Runs are local OS processes, not sandboxes.',
    },
    {
      name: 'forge_work_overview',
      actions: [
        'handoff-read',
        'improve',
        'pending-status',
        'peers',
        'status',
        'records',
        'policy',
        'link',
        'making-of',
        'report',
      ],
      description:
        'handoff-read {laneId} reads the latest portable delivery note. pending-status reads one pinned local pending-work/recovery summary without remote calls, process recovery or archive export. Read Forge URLs with link (laneId, viewId or save; optional path/line), policy, concise Work pins and counts, or page one retained collection directly with records without reconstructing all Work history. making-of reads one Intent’s derived record: Lanes, saves, check runs with queued/running time, landings, sessions, wall clock and active time. report records cumulative self-reported harness, model and token totals for a Lane session (advisory). All source and history remain retained.',
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
        ? [...options, z.object({ action: z.literal('pending-status') })]
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
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  command.action === 'pending-status'
                    ? readPendingStatus(agent.work.store)
                    : await agent.dispatch(command),
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
                text: JSON.stringify({
                  error: {
                    code: error instanceof ForgeError ? error.code : 'INTERNAL_ERROR',
                    message:
                      error instanceof ForgeError
                        ? error.message
                        : 'Forge could not complete the agent action.',
                  },
                }),
              },
            ],
          };
        }
      },
    );
  }
}
