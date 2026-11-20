// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { hostedLifecycleRequestSchema } from '../src/hosted-lifecycle';
import { purgedLifecycleReason } from '../src/work-planning-purge';
import { canonicalPayload } from '../src/hosted-source-operation';

type Cursor = { plans: string | null; offset: number; event?: number };
const PAGE = 32;

/** A cascade copies the request's reason into its parent event and every child event. The original request hash,
 * resource pins and terminal receipt still reconcile against the caller's unchanged request. */
export async function purgeLifecyclePlans(
  ctx: QueryCtx,
  write: MutationCtx['db'] | undefined,
  projectId: Id<'hostedProjects'>,
  intentKeys: readonly string[],
  after: string | null,
) {
  if (!intentKeys.length) return { changes: 0, after: null };
  const cursor: Cursor = after ? JSON.parse(after) : { plans: null, offset: 0 };
  const plans = await ctx.db
    .query('projectHostedLifecyclePlans')
    .withIndex('by_project_and_actor_and_operation', q => q.eq('projectId', projectId))
    .paginate({ cursor: cursor.plans, numItems: PAGE });
  let changes = 0,
    remaining = PAGE;
  for (let offset = cursor.offset; offset < plans.page.length; offset++) {
    const plan = plans.page[offset]!;
    if (!intentKeys.includes(plan.intentId)) continue;
    const request = hostedLifecycleRequestSchema.parse(JSON.parse(plan.request));
    const reason = purgedLifecycleReason(request.action);
    if (request.reason !== reason) {
      changes++;
      if (write) await write.patch(plan._id, { request: canonicalPayload({ ...request, reason }) });
    }
    const eventAfter = offset === cursor.offset ? cursor.event : undefined;
    const events = await ctx.db
      .query('projectHostedLifecycleEvents')
      .withIndex('by_plan_and_index', q => q.eq('planId', plan._id).gt('index', eventAfter ?? -2))
      .take(remaining);
    for (const event of events) changes += await scrubEvent(write, event, reason);
    remaining -= events.length;
    if (!remaining)
      return { changes, after: JSON.stringify({ plans: cursor.plans, offset, event: events.at(-1)!.index }) };
  }
  return {
    changes,
    after: plans.isDone ? null : JSON.stringify({ plans: plans.continueCursor, offset: 0 }),
  };
}

async function scrubEvent(
  write: MutationCtx['db'] | undefined,
  row: Doc<'projectHostedLifecycleEvents'>,
  reason: string,
) {
  const value = JSON.parse(row.value);
  if (value.reason === reason) return 0;
  if (write) await write.patch(row._id, { value: canonicalPayload({ ...value, reason }) });
  return 1;
}
