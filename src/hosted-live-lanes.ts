// SPDX-License-Identifier: Apache-2.0
import { hostedActionError } from './hosted-action-error.js';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { planningIssueArguments } from './planning-issue-arguments.js';
// Static: both modules sit in the transport chunk; a dynamic import split planning into its own chunks (7b2ae8d8).
import { resolvePlanningId } from './hosted-agent-planning.js';
import { isPlanningRef, isPlanningUuid, planningIdHelp } from './planning-id.js';
const issueRef = z.string().refine(isPlanningRef, `expected ${planningIdHelp}`);
import { shellQuote } from './shell-quote.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
export const liveLanesInput = z
  .object({
    planningItemId: issueRef
      .describe(
        'Issue key (canonical): full UUID or the 8-character id. Selects its current execution Intent.',
      )
      .optional(),
    id: issueRef.describe('Alias for planningItemId.').optional(),
    itemId: issueRef.describe('Alias for planningItemId.').optional(),
    /** Exact execution Intent; planningItemId selects the Issue's current execution Intent. */
    intentId: z.uuid().optional(),
    /** `open` (default) lists open Lanes; `all` (with planningItemId) lists the Issue's Lanes in every state, landed
     * ones with their receipt, through the same read as `planning {id}` `work`. */
    state: z.enum(['open', 'all']).optional(),
    cursor: z
      .string()
      .refine(value => value.startsWith('forge-lanes-v1:') || value.startsWith('forge-item-work-v1:'))
      .nullable()
      .default(null),
    /** Page size: 50 by default (20 for state "all"), at most 100 (50 for state "all"). */
    limit: z.number().int().min(1).max(100).optional(),
    /** `live` hides dormant Lanes; `dormant` lists only them, each with `abandonable`; default lists all.
     * `loose-ends` is one compact read of five groups (dormant, stopped, checked never landed, leftover projects,
     * dated checks), each listed or marked not reported with the reason; a quiet Lane beside a live Lane of the same
     * Issue carries `replacedBy` and the abandon command as `next`. `tree` adds a compact text `tree`: which Lanes
     * stack on which, which overlap, and each Lane's state and next step, from the same one page read. */
    // A checked string, not an enum, so the per-session MCP tool listing names `view` without its values
    // (tests/mcp-tool-list.test.mjs budget); help and docs list them.
    view: z
      .string()
      .refine(value => ['all', 'live', 'dormant', 'loose-ends', 'tree'].includes(value), {
        message: 'view: all, live, dormant, loose-ends or tree.',
      })
      .optional(),
  })
  .strict()
  .refine(input => input.state !== 'all' || (input.planningItemId && !input.intentId && !input.view), {
    message: 'state "all" reads one Issue: pass planningItemId (no intentId or view).',
  });
/** The read returns canonical JSON text; the hosted transport already decodes JSON replies, so the reply may arrive as
 * the object itself (a second JSON.parse made every `view:"loose-ends"` read fail). */
const looseEnds = (reply: unknown) => (typeof reply === 'string' ? JSON.parse(reply) : reply);

/** Every Lane of one Issue in any state: one page of the shared Item work read, in the `lanes` page shape. */
async function itemLanes(
  transport: HostedAgentTransport,
  itemId: string,
  page: { limit?: number | undefined; cursor: string | null },
) {
  invariant(
    page.cursor === null || page.cursor.startsWith('forge-item-work-v1:'),
    'BAD_ARGUMENT',
    'cursor: state "all" pages with its own nextCursor. Restart without a cursor.',
  );
  // Loaded only for this read: `lanes` sits on the status path, which must not load more modules (7b2ae8d8).
  const { readItemWork } = await import('./item-work.js');
  const work = await readItemWork(transport, itemId, {
    ...(page.limit ? { limit: Math.min(page.limit, 50) } : {}),
    cursor: page.cursor,
  });
  invariant(
    work,
    'HOSTED_ACTION_UNSUPPORTED',
    'This deployment does not offer the Item work read yet. Run lanes without state "all" for open Lanes.',
  );
  return {
    page: work.lanes ?? [],
    total: work.total ?? 0,
    ...(work.atLeast ? { atLeast: true } : {}),
    isDone: !work.nextCursor,
    continueCursor: work.nextCursor ?? null,
  };
}

/** The tree view: the same one `lanes` page with stack and overlap fields, rendered as text lines. */
async function laneTree(transport: HostedAgentTransport, input: Record<string, unknown>) {
  const reply = await transport.query<{ page: unknown[]; isDone: boolean; continueCursor: string | null }>(
    'projectHostedLiveLanes:list',
    { ...input, limit: input.limit ?? 50 },
  );
  // Loaded only for this view, like the Item work read: `lanes` sits on the status path (7b2ae8d8).
  const { renderLaneTree } = await import('./lanes-tree.js');
  const page = reply.page as Parameters<typeof renderLaneTree>[0];
  return { tree: renderLaneTree(page), page, isDone: reply.isDone, continueCursor: reply.continueCursor };
}

export async function liveLanes(transport: HostedAgentTransport, input: Record<string, unknown>) {
  const parsed = liveLanesInput.safeParse(planningIssueArguments('lanes', input));
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    `Invalid lanes parameters: ${parsed.success ? '' : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}. Run nforge agent ROOT lanes --help and retry with the returned cursor and a page size from 1 to 100.`,
  );
  try {
    const { state, ...input } = parsed.data;
    // The 8-character id `planning` accepts (friction 546def08): the same prefix read, only for a short id.
    if (input.planningItemId && !isPlanningUuid(input.planningItemId)) {
      input.planningItemId = await resolvePlanningId(transport, input.planningItemId);
    }
    return {
      schema: 1 as const,
      transport: 'hosted' as const,
      action: 'lanes' as const,
      operationId: null,
      resolved: null,
      result:
        state === 'all'
          ? await itemLanes(transport, input.planningItemId!, input)
          : input.view === 'loose-ends'
            ? looseEnds(await transport.query('projectLooseEnds:read', {}))
            : input.view === 'tree'
              ? await laneTree(transport, input)
              : {
                  ...(await transport.query<Record<string, unknown>>('projectHostedLiveLanes:list', {
                    ...input,
                    limit: input.limit ?? 50,
                  })),
                  // A Lane whose folder or land operation id is gone recovers its landing by laneId (7da396ed).
                  recover: `nforge agent ${shellQuote(hostedAgentRoot(transport.root))} status '{"laneId":"LANE_ID"}' names a Lane's landing in flight and its wait, even without its folder.`,
                },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (/(?:Could not find (?:public )?function|No (?:public )?function found|Function .* not found)/i.test(
        error.message,
      ) ||
        (parsed.data.view === 'tree' &&
          /ArgumentValidationError|Value does not match validator/i.test(error.message)))
    )
      throw new ForgeError(
        'HOSTED_ACTION_UNSUPPORTED',
        parsed.data.view === 'tree'
          ? 'This deployment does not offer lanes view "tree" yet. Run nforge agent ROOT lanes {} for the flat list.'
          : 'This deployment does not offer the live Lane list. Deploy the matching projectHostedLiveLanes API, then rerun nforge agent ROOT lanes {}.',
      );
    const failure = hostedActionError(error, 'live Lane read');
    if (failure.code === 'HOSTED_ACTION_FAILED')
      throw new ForgeError(
        failure.code,
        'The live Lane read failed. Rerun nforge agent ROOT lanes with the original cursor to retry this page; if it persists, inspect the deployment query logs.',
      );
    if (failure.code === 'PROJECT_UNAVAILABLE')
      throw new ForgeError(
        failure.code,
        `${failure.message} Run nforge login for an account with project access, then rerun nforge agent ROOT lanes with the original cursor.`,
      );
    throw failure;
  }
}
