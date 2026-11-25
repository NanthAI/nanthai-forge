// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { acceptancePage, acceptancePlan } from './projectHostedAcceptanceStore';
import { dormantAfterDays } from '../src/agent-parallel-defaults';
import { composeLaneSchema, validateComposePage } from '../src/hosted-compose';
import { effectivePolicy } from '../src/autonomy-policy';
import { overlapLaneChanges } from './projectHostedOverlapChanges';

const DAY_MS = 24 * 3_600_000;
/** Peer window of every overlap read; one more row says the window is full. */
export const PEER_WINDOW = 51;
type Project = { autonomyPolicy?: unknown };

/** Epoch ms before which an open Lane is dormant, or null when the project turned dormancy off
 * (agentDefaults.dormantAfterDays 0). The project row is already read by the caller's access check. */
export function dormantCutoff(project: Project, now = Date.now()): number | null {
  const days = dormantAfterDays(
    effectivePolicy(project as Parameters<typeof effectivePolicy>[0]).agentDefaults,
  );
  return days > 0 ? now - days * DAY_MS : null;
}

/** Newest live open Lanes, at most `PEER_WINDOW`, from one indexed range on last activity. Dormant Lanes
 * are never read. With dormancy off this is the plain open-Lane read. */
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
  return ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_open_and_activity', q =>
      q.eq('projectId', projectId).eq('open', true).gt('lastActivityAt', cutoff),
    )
    .order('desc')
    .take(PEER_WINDOW);
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
export async function overlapEvidence(
  ctx: QueryCtx,
  lane: { head: string },
  row: Pick<
    Doc<'projectHostedOverlapLanes'>,
    'head' | 'complete' | 'projectId' | 'laneId' | 'pathSummary'
  > | null,
): Promise<{ path: string; after: { blob: string; mode: string } | null }[] | null> {
  if (!row || row.head !== lane.head || !row.complete) return null;
  // The row knows how many paths it holds: one too large to compare reads no bucket.
  if (row.pathSummary.pathCount > COMPARE_PATHS) return null;
  try {
    const changes = JSON.parse(await overlapLaneChanges(ctx, row)) as {
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
