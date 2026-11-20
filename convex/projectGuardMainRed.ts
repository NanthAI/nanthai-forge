// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import type { HostedLandingState } from '../src/hosted-landing';
import { forgetMainRedFiles, withoutMainRed } from '../src/preflight-guard-learning';
import { recordGuardFailure } from './projectLandingSpeed';

/** Keep only the last red's guard evidence in the existing green write. An incomplete list
 * already means the learner must disregard the whole verdict, so keep only that signal. */
export function recoveredRed(
  red: NonNullable<Doc<'projectHostedMainAudits'>['red']>,
  greenHead: string,
  at: string,
) {
  // The time cutoff is needed when the same source goes green (a flake or rerun).
  // A stale retry on a red head that was replaced can still fail on the old bug.
  const pin = { head: red.head, ...(greenHead === red.head ? { passedAt: at } : {}) };
  if (red.moreTests || !red.tests?.length) return pin;
  const lastRed = { ...pin, tests: red.tests };
  return new TextEncoder().encode(JSON.stringify({ lastRed })).length <= 1000 ? lastRed : pin;
}

// Reuse the failing check that queue/admission settlement already read. The current
// attempt may carry an older reservation timestamp or a different base after recomposition.
const guardChecks = new WeakMap<MutationCtx, Map<string, { head: string; at: string }>>();
export function rememberGuardCheck(ctx: MutationCtx, submissionId: string, run: HostedCheckRun) {
  let checks = guardChecks.get(ctx);
  if (!checks) guardChecks.set(ctx, (checks = new Map()));
  checks.set(submissionId, { head: run.candidate.base.head, at: run.at });
}

/** Main's own failures are never a Lane's (13ea93bf main-red line). A failed check reads main's audit
 * row once (one indexed read, check failures only, about 1 landing in 10) and hands the guard learner
 * only the failing files main does not fail too; nothing when main explains them all or fails more
 * than it names. Inline, not projectHostedMainAuditState's auditRow: that module imports this one. */
export async function recordGuardFailureOffMainRed(ctx: MutationCtx, state: HostedLandingState) {
  let lane: HostedLandingState | null = state;
  try {
    const audit = await ctx.db
      .query('projectHostedMainAudits')
      .withIndex('by_project', q => q.eq('projectId', state.projectId as Id<'hostedProjects'>))
      .unique();
    lane = withoutMainRed(state, audit?.red);
    const last = audit?.lastRed;
    const check = guardChecks.get(ctx)?.get(state.id);
    if (
      lane &&
      last &&
      check?.head === last.head &&
      (!last.passedAt || Date.parse(check.at) <= Date.parse(last.passedAt))
    )
      lane = withoutMainRed(lane, last);
  } catch {
    // An unreadable audit row teaches nothing rather than main's failures.
    lane = null;
  }
  if (lane) await recordGuardFailure(ctx, lane);
}

/** Main's audit failed: failures learned before the audit could see main was red stop naming its
 * failing files (all files when it names not all of them), from `since` (the first unaudited
 * landing) on; with no `since`, from the start, erring toward forgetting. Once per failed audit: one
 * indexed read of the speed row and a patch only when a learned failure changes. A metric: it never
 * fails the audit. */
export async function forgetMainRedGuards(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  red: { tests: string[]; moreTests?: number },
  since: string | null | undefined,
) {
  try {
    const row = await ctx.db
      .query('projectLandingSpeed')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .unique();
    if (!row?.guards) return;
    const from = since ? Date.parse(since) : NaN;
    const guards = forgetMainRedFiles(row.guards, red, Number.isFinite(from) ? from : 0);
    if (guards !== null) await ctx.db.patch(row._id, { guards });
  } catch {
    // The audit verdict is already recorded; a stale learned file only costs local seconds.
  }
}
