import { scheduleAbandonedBatchReselection } from './projectHostedBatchAbandon';
// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { hostedWriteProject, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { saveExpectedSchema } from '../src/hosted-save';
import { hostedLaneSchema, hostedIntentSchema } from '../src/hosted-lane';
import { hostedLifecycleRequestSchema, hostedLifecycleResultSchema } from '../src/hosted-lifecycle';
import { canonicalPayload, hostedOperationSchema } from '../src/hosted-source-operation';
import { finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import { lifecycleGuard } from './projectHostedLifecycleOverlay';
import { invariant } from '../src/errors';
export type LifecyclePlan = Doc<'projectHostedLifecyclePlans'>;
export const lifecyclePlan = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; operationId: string },
) =>
  ctx.db
    .query('projectHostedLifecyclePlans')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', input.projectId).eq('actor', input.actor).eq('operationId', input.operationId),
    )
    .unique();
export function lifecycleResult(plan: LifecyclePlan) {
  const request = hostedLifecycleRequestSchema.parse(JSON.parse(plan.request));
  return hostedLifecycleResultSchema.parse({
    schema: 1,
    operationId: plan.operationId,
    receiptId: plan.receiptId,
    action: request.action,
    target: request.target.kind,
    id: request.target.kind === 'lane' ? request.target.laneId : request.target.intentId,
    status: plan.status,
    at: plan.at,
    children: plan.staged,
    saveOperationId: request.target.kind === 'lane' ? request.target.saveOperationId : null,
    cancellation: 'not-requested',
    lane:
      request.target.kind === 'lane' && plan.status === 'applied'
        ? {
            ...(plan.savedExpected
              ? saveExpectedSchema.parse(JSON.parse(plan.savedExpected))
              : request.target.expected),
            version:
              (plan.savedExpected
                ? saveExpectedSchema.parse(JSON.parse(plan.savedExpected))
                : request.target.expected
              ).version + 1,
            lifecycleVersion: request.target.expected.lifecycleVersion + 1,
            state: request.action === 'abandon' ? 'abandoned' : 'active',
          }
        : null,
  });
}
export async function lifecycleTarget(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  kind: 'intent' | 'lane',
  key: string,
) {
  const row = await readHostedRecord(ctx, { projectId, actor, kind, key });
  invariant(row, 'NOT_FOUND', 'Hosted lifecycle target not found on this project.');
  return {
    row,
    record:
      kind === 'lane'
        ? hostedLaneSchema.parse(JSON.parse(row.value))
        : hostedIntentSchema.parse(JSON.parse(row.value)),
  };
}
export async function lifecycleCurrent(ctx: MutationCtx, plan: LifecyclePlan) {
  await hostedWriteProject(ctx, plan.projectId, plan.actor, plan.authorityEpoch);
  const guard = await lifecycleGuard(ctx, plan.projectId, plan.intentId);
  const request = hostedLifecycleRequestSchema.parse(JSON.parse(plan.request));
  const current = await lifecycleTarget(
    ctx,
    plan.projectId,
    plan.actor,
    request.target.kind,
    request.target.kind === 'lane' ? request.target.laneId : request.target.intentId,
  );
  const valid =
    request.target.kind === 'intent' &&
    current.record.kind === 'intent' &&
    request.target.version === current.record.version &&
    guard?.planId === plan._id &&
    guard.revision === plan.revision;
  return { guard, current, valid };
}
export async function settleLifecycle(
  ctx: MutationCtx,
  plan: LifecyclePlan,
  status: 'applied' | 'stale' | 'failed',
  failure = {
    code: 'WORK_STALE',
    message: 'Selected work changed during the cascade; every child remains unchanged by this operation.',
  },
) {
  const result = lifecycleResult({ ...plan, status });
  const row = await hostedOperationRow(ctx, plan.projectId, plan.actor, plan.operationId);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original lifecycle operation is unavailable.');
  const op = hostedOperationSchema.parse(JSON.parse(row.value));
  await ctx.db.patch(plan._id, { status });
  await finishHostedOperation(ctx, {
    projectId: plan.projectId,
    actor: plan.actor,
    operationId: plan.operationId,
    receipt: {
      attemptId: op.firstAttempt.id,
      at: plan.at,
      outcome:
        status === 'applied'
          ? { status: 'completed', result }
          : {
              status: 'failed',
              error: failure,
            },
    },
  });
  return result;
}
export async function writeLifecycleEvent(
  ctx: MutationCtx,
  plan: LifecyclePlan,
  before: {
    kind: 'lane' | 'intent';
    id: string;
    version: number;
    state?: string;
    status?: string;
    head?: string;
    sourceVersion?: number;
  },
  index: number,
) {
  const request = hostedLifecycleRequestSchema.parse(JSON.parse(plan.request));
  const to = request.action === 'abandon' ? 'abandoned' : 'active';
  await ctx.db.insert('projectHostedLifecycleEvents', {
    projectId: plan.projectId,
    kind: before.kind,
    key: before.id,
    planId: plan._id,
    index,
    value: canonicalPayload({
      operationId: plan.operationId,
      receiptId: plan.receiptId,
      actor: plan.actor,
      at: plan.at,
      reason: request.reason,
      from: before.state ?? before.status,
      to,
      version: before.version + 1,
      ...(before.head ? { head: before.head, sourceVersion: before.sourceVersion } : {}),
    }),
  });
}
export async function applyLifecycleRecord(
  ctx: MutationCtx,
  plan: LifecyclePlan,
  before: Awaited<ReturnType<typeof lifecycleTarget>>['record'],
) {
  const request = hostedLifecycleRequestSchema.parse(JSON.parse(plan.request));
  const status = request.action === 'abandon' ? ('abandoned' as const) : ('active' as const);
  await writeHostedRecord(ctx, {
    projectId: plan.projectId,
    actor: plan.actor,
    authorityEpoch: plan.authorityEpoch,
    expectedVersion: before.version,
    record: {
      ...before,
      version: before.version + 1,
      at: plan.at,
      ...(before.kind === 'lane'
        ? { state: status, lifecycleVersion: before.lifecycleVersion + 1 }
        : { status }),
    },
  });
  if (request.action === 'abandon')
    await scheduleAbandonedBatchReselection(ctx, {
      projectId: plan.projectId,
      actor: plan.actor,
      operationId: plan.operationId,
      kind: before.kind,
      key: before.id,
      version: before.version + 1,
    });
  await writeLifecycleEvent(ctx, plan, before, -1);
}
export async function lifecycleCaller(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change hosted work.');
  await activeProject(ctx, projectId, user.subject);
  return user.subject;
}
