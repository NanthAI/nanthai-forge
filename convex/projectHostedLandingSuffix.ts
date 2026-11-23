// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { batchRow, batchSchema } from './projectHostedLandingBatchState';
import { storedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';

/** Largest configurable pipeline (`checks.concurrency`), so the walk is bounded. */
const MAX_DEPTH = 16;
/** Never wait for work that waits for you (landing-queue model, `prequeue-suffix`).
 * True when `other` belongs to a cohort whose speculative predecessor chain reaches
 * `row`'s group: it can publish only after `row`, so its older place in the queue
 * must not hold `row` back. One batch read and one row read per pipeline step;
 * `other` outside a cohort costs nothing; callers consult it only for entries that
 * entered the queue after a pre-queue Lane check. */
export async function stackedBehind(
  ctx: QueryCtx | MutationCtx,
  row: Pick<Doc<'projectHostedLandingRequests'>, 'projectId'>,
  state: HostedLandingState,
  other: HostedLandingState,
) {
  let current = other;
  for (let depth = 0; depth < MAX_DEPTH && current.batchId; depth++) {
    const batch = await batchRow(ctx, { projectId: row.projectId, batchId: current.batchId });
    const predecessor = batch ? batchSchema.parse(JSON.parse(batch.value)).predecessor : undefined;
    if (!predecessor) return false;
    if (predecessor.submissionId === state.id) return true;
    const next = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_submission', q =>
        q.eq('projectId', row.projectId).eq('submissionId', predecessor.submissionId),
      )
      .unique();
    if (!next) return false;
    current = storedLandingStateSchema.parse(JSON.parse(next.value));
    if (state.batchId && current.batchId === state.batchId) return true;
  }
  return false;
}

/** The same rule through any chain of waits (Item 273650ab, queue sim 2026-11-23: 4 was composed on
 * younger 9's predicted head, 9 waited for older 7 and 7 for 4, with nothing scheduled until the stall
 * alarm). True when `other`'s waits lead back to `row` or its combined group: a parked Ready entry's
 * order wait (a handed link included) or a cohort's speculative predecessor (it publishes only after
 * that one). `other` then cannot take main before `row`. At most `budget.reads` indexed reads per
 * claim, spent only on the entry the claim would wait for, and only when that entry is itself parked
 * or in a cohort; a row the claim already holds (`loaded`, its older window) costs none. */
export async function waitsBackOn(
  ctx: QueryCtx | MutationCtx,
  row: Pick<Doc<'projectHostedLandingRequests'>, 'projectId' | 'submissionId'>,
  state: HostedLandingState,
  other: Doc<'projectHostedLandingRequests'>,
  value: HostedLandingState,
  budget: { reads: number },
  loaded?: ReadonlyMap<string, Doc<'projectHostedLandingRequests'>>,
) {
  const seen = new Set([row.submissionId]);
  let at = other,
    current = value;
  while (!seen.has(at.submissionId)) {
    seen.add(at.submissionId);
    let next: string | undefined;
    if (at.phase === 'ready' && at.orderWait) next = at.orderWait;
    else if (current.batchId && budget.reads-- > 0) {
      const batch = await batchRow(ctx, { projectId: row.projectId, batchId: current.batchId });
      next = batch ? batchSchema.parse(JSON.parse(batch.value)).predecessor?.submissionId : undefined;
    }
    if (next === row.submissionId) return true;
    if (!next) return false;
    const known = loaded?.get(next);
    if (!known && budget.reads-- <= 0) return false;
    const found =
      known ??
      (await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_submission', q =>
          q.eq('projectId', row.projectId).eq('submissionId', next),
        )
        .unique());
    if (!found || found.phase === 'landed' || found.phase === 'terminal-failed') return false;
    at = found;
    current = storedLandingStateSchema.parse(JSON.parse(found.value));
    if (state.batchId && current.batchId === state.batchId) return true;
  }
  return false;
}
