// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { acceptancePage, acceptancePlan } from './projectHostedAcceptanceStore';
import { dormantAfterDays } from '../src/agent-parallel-defaults';
import { composeLaneSchema, validateComposePage } from '../src/hosted-compose';
import { effectivePolicy } from '../src/autonomy-policy';
import { PEER_WINDOW } from './projectHostedOverlapPeers';

// Defined beside the peer read (a cycle otherwise); re-exported for existing callers.
export { PEER_WINDOW };

const DAY_MS = 24 * 3_600_000;
type Project = { autonomyPolicy?: unknown };

/** Epoch ms before which an open Lane is dormant, or null when the project turned dormancy off
 * (agentDefaults.dormantAfterDays 0). The project row is already read by the caller's access check. */
export function dormantCutoff(project: Project, now = Date.now()): number | null {
  const days = dormantAfterDays(
    effectivePolicy(project as Parameters<typeof effectivePolicy>[0]).agentDefaults,
  );
  return days > 0 ? now - days * DAY_MS : null;
}

/** Last time a Lane's record was written: the overlap row's own field, else the presence time it
 * carried before the field existed. A row with neither is unknown, and unknown counts as live: missing
 * evidence never hides a Lane. Landing completions and `abandon-dormant` stamp such rows from the Lane record. */
export const rowActivity = (row: Pick<Doc<'projectHostedOverlapLanes'>, 'lastActivityAt' | 'presenceRow'>) =>
  row.lastActivityAt ?? row.presenceRow?.at ?? Infinity;

/** Newest live open Lanes, at most `PEER_WINDOW`, from one indexed range on last activity. Dormant Lanes
 * are never read. Rows written before `lastActivityAt` existed sit in their own small range and are
 * filtered by the presence time they already hold, so a deployment needs no backfill; each leaves that
 * range at its Lane's next record write or, for a Lane that never writes again, when a landing completion
 * stamps it (`stampLegacyOverlapActivity`). With dormancy off this is the plain open-Lane read. */
export async function liveOpenOverlapLanes(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  cutoff: number | null,
) {
  if (cutoff === null)
    return ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true))
      .order('desc')
      .take(PEER_WINDOW);
  const [live, legacy] = await Promise.all([
    ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open_and_activity', q =>
        q.eq('projectId', projectId).eq('open', true).gt('lastActivityAt', cutoff),
      )
      .order('desc')
      .take(PEER_WINDOW),
    ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open_and_activity', q =>
        q.eq('projectId', projectId).eq('open', true).eq('lastActivityAt', undefined),
      )
      .order('desc')
      .take(PEER_WINDOW),
  ]);
  return [...live, ...legacy.filter(row => rowActivity(row) > cutoff)]
    .sort((a, b) => (rowActivity(a) === rowActivity(b) ? 0 : rowActivity(b) > rowActivity(a) ? 1 : -1))
    .slice(0, PEER_WINDOW);
}

/** Input pages of one receipt read to find a Lane; a receipt past this is not searched further. */
const RECEIPT_PAGES = 3;
/** The accepted receipt whose inputs carry this Lane's exact saved head, found through the Lane's
 * Intent: its newest Candidate, that Candidate's landed request, the receipt's input pages. At most
 * 4 indexed reads plus RECEIPT_PAGES page reads, no scan. It covers a Lane whose own completion tick
 * never ran (nothing stamped the overlap row), so the Lane still reads as unfinished work. */
export async function landedByReceipt(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  lane: { id: string; intentId: string; head: string },
): Promise<string | null> {
  const [candidate] = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent', q =>
      q.eq('projectId', projectId).eq('kind', 'candidate').eq('parent', lane.intentId),
    )
    .order('desc')
    .take(1);
  if (!candidate) return null;
  const [landed] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_candidate_and_phase_and_sequence', q =>
      q.eq('projectId', projectId).eq('candidateId', candidate.key).eq('phase', 'landed'),
    )
    .order('desc')
    .take(1);
  let receiptId: unknown;
  try {
    receiptId = (JSON.parse(landed?.value ?? 'null') as { acceptance?: { receiptId?: unknown } } | null)
      ?.acceptance?.receiptId;
  } catch {
    return null;
  }
  if (typeof receiptId !== 'string') return null;
  const plan = await acceptancePlan(ctx, { projectId, receiptId });
  for (let index = 0; plan && index < Math.min(plan.inputPages, RECEIPT_PAGES); index++) {
    const page = await acceptancePage(ctx, { projectId, receiptId, kind: 'inputs', index });
    if (!page) return null;
    for (const entry of validateComposePage(JSON.parse(page.value)).entries) {
      const input = composeLaneSchema.safeParse(entry);
      if (input.success && input.data.laneId === lane.id && input.data.head === lane.head) return receiptId;
    }
  }
  return null;
}

/** What a Lane's overlap row says it changed, when the row holds the complete list for its current
 * head and the list is small enough to compare: one entry per path with the bytes it ends with
 * (`after`, null = deleted). Null when the evidence is partial, stale or too large to send. */
export const COMPARE_PATHS = 200;
export function overlapEvidence(
  lane: { head: string },
  row: Pick<Doc<'projectHostedOverlapLanes'>, 'head' | 'complete' | 'changes'> | null,
): { path: string; after: { blob: string; mode: string } | null }[] | null {
  if (!row || row.head !== lane.head || !row.complete) return null;
  try {
    const changes = JSON.parse(row.changes) as {
      path: string;
      after: { blob: string; mode: string } | null;
    }[];
    return changes.length <= COMPARE_PATHS
      ? changes.map(change => ({ path: change.path, after: change.after }))
      : null;
  } catch {
    return null;
  }
}

/** Why a dormant open Lane can be abandoned without losing saved work, or null when it cannot:
 * `empty` nothing was ever saved (head is still its base); `landed` an accepted receipt landed this
 * exact saved head (the overlap row's landing stamp; `landedByReceipt` finds the same through the
 * receipt when the stamp is missing). Any other saved head may hold unlanded work; the CLI can still
 * prove it is on main (`on-main`). */
export function abandonClass(
  lane: { head: string; base: { head: string } },
  overlap: Pick<Doc<'projectHostedOverlapLanes'>, 'landed' | 'head'> | null,
): 'empty' | 'landed' | null {
  if (lane.head === lane.base.head) return 'empty';
  return overlap && overlap.head === lane.head && overlap.landed?.laneHead === lane.head ? 'landed' : null;
}
