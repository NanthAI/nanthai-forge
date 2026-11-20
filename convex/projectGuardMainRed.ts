// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { forgetMainRedFiles, withoutMainRed } from '../src/preflight-guard-learning';
import { recordGuardFailure } from './projectLandingSpeed';

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
