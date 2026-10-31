// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { mutation, query } from './cliServer';
import { internalMutation } from './_generated/server';
import { hostedWriteProject } from './projectHostedRecords';
import { beginHostedOperation, hostedOperationRow } from './projectHostedOperations';
import { lifecycleGuard } from './projectHostedLifecycleOverlay';
import { sameSaveLane, loadSave } from './projectHostedSaveStore';
import { hostedLifecycleRequestSchema } from '../src/hosted-lifecycle';
import { canonicalPayload, hostedPayloadHash, hostedOperationSchema } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import {
  lifecycleCaller,
  lifecyclePlan,
  lifecycleTarget,
  lifecycleResult,
  applyLifecycleRecord,
  settleLifecycle,
} from './projectHostedLifecycleStore';
import { advanceLifecycle, materializeLifecycle, scheduleLifecycle } from './projectHostedLifecycleCascade';
const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
/** Saved-work lifecycle only. Unknown/disconnected client bytes are never deleted
 * or claimed saved. The local API helper owns capture and retained save-first IDs. */
export const transition = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const parsed = hostedLifecycleRequestSchema.safeParse(JSON.parse(input.request));
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        'Send an original lifecycle UUID, reason for abandonment and exact resource pins.',
      );
      const request = parsed.data;
      const actor = await lifecycleCaller(ctx, input.projectId),
        target = request.target;
      const expected = {
        authorityEpoch: request.authorityEpoch,
        resourceId: target.kind === 'lane' ? target.laneId : target.intentId,
        resourceVersion: target.kind === 'lane' ? target.expected.version : target.version,
        ...(target.kind === 'lane'
          ? { head: target.expected.head, sourceRevision: target.expected.sourceVersion }
          : {}),
      };
      const auth = { projectId: input.projectId, actor, operationId: request.operationId };
      const prepared = await beginHostedOperation(ctx, {
        ...auth,
        ...(request.action === 'complete' ? {} : { metricAction: request.action }),
        payload: request,
        request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(request, expected) },
        firstAttempt: {
          projectId: input.projectId,
          operationId: request.operationId,
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          parentAttemptId: null,
          expected,
          ids: { receipt: crypto.randomUUID() },
        },
      });
      if (prepared.replayed) {
        const plan = await lifecyclePlan(ctx, auth);
        invariant(plan, 'SOURCE_UNAVAILABLE', 'The original lifecycle receipt is unavailable.');
        if (plan.status === 'pending') {
          await hostedWriteProject(ctx, input.projectId, actor, request.authorityEpoch);
          await scheduleLifecycle(ctx, plan._id);
        } else if (plan.status === 'applied' && !plan.materialized) {
          const project = await ctx.db.get(input.projectId);
          if (
            project?.sourceAuthority?.mode !== 'native-owner' &&
            project?.sourceAuthority?.epoch === request.authorityEpoch
          )
            await scheduleLifecycle(ctx, plan._id);
        }
        return canonicalPayload(lifecycleResult(plan));
      }
      const { record } = await lifecycleTarget(
        ctx,
        input.projectId,
        actor,
        target.kind,
        target.kind === 'lane' ? target.laneId : target.intentId,
      );
      if (target.kind === 'lane') {
        invariant(
          record.kind === 'lane' &&
            (target.saveOperationId !== null || sameSaveLane(record, target.expected)),
          'WORK_STALE',
          'Hosted Lane changed from its lifecycle pins.',
        );
        invariant(
          request.action !== 'complete' || record.kind !== 'lane' || record.state === 'active',
          'WORK_STALE',
          'Only an active Lane can be completed.',
        );
        invariant(
          !record.pinned || request.action === 'reopen',
          'LANE_PINNED',
          'The owner pinned this Lane. Unpin it (pin with pinned:false) before completing or abandoning it.',
        );
        invariant(
          request.action !== 'abandon' || !target.dirty || target.saveOperationId,
          'LANE_DIRTY',
          'Lane has unsaved edits. Use saveFirst:true to save before abandoning.',
        );
        if (target.saveOperationId) {
          const child = await loadSave(ctx, { ...auth, operationId: target.saveOperationId }, false);
          invariant(
            child.state.request.laneId === target.laneId &&
              child.state.request.authorityEpoch === request.authorityEpoch &&
              canonicalPayload(child.state.request.expected) === canonicalPayload(target.expected),
            'WORK_OPERATION_CHANGED',
            'The retained save-first child must bind this exact original Lane baseline.',
          );
        }
      } else
        invariant(
          record.version === target.version,
          'WORK_STALE',
          'Hosted Intent changed from its lifecycle pins.',
        );
      const intentId = record.kind === 'lane' ? record.intentId : record.id;
      let guard = await lifecycleGuard(ctx, input.projectId, intentId);
      if (!guard) {
        const id = await ctx.db.insert('projectHostedLifecycleGuards', {
          projectId: input.projectId,
          intentId,
          revision: 0,
          planId: null,
        });
        guard = (await ctx.db.get(id))!;
      }
      const first = prepared.operation.firstAttempt;
      const id = await ctx.db.insert('projectHostedLifecyclePlans', {
        ...auth,
        intentId,
        receiptId: first.ids.receipt!,
        authorityEpoch: request.authorityEpoch,
        request: canonicalPayload(request),
        at: first.at,
        revision: guard.revision,
        status: 'pending',
        cursor: null,
        staged: 0,
        ready: false,
        saveOperationId: target.kind === 'lane' ? target.saveOperationId : null,
        savedExpected: null,
        materialized: false,
        appliedThrough: 0,
        materializeCursor: null,
      });
      const plan = (await ctx.db.get(id))!;
      if (target.kind === 'lane' && target.saveOperationId) {
        return canonicalPayload(await advanceLifecycle(ctx, plan));
      }
      if (target.kind === 'intent' && target.cascade) {
        await ctx.db.patch(guard._id, { planId: id });
        await scheduleLifecycle(ctx, id);
        return canonicalPayload(lifecycleResult(plan));
      }
      await applyLifecycleRecord(ctx, plan, record);
      await ctx.db.patch(id, { materialized: true });
      return canonicalPayload(await settleLifecycle(ctx, plan, 'applied'));
    } catch (error) {
      return report(error);
    }
  },
});
export const progress = query({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await lifecycleCaller(ctx, input.projectId);
      const plan = await lifecyclePlan(ctx, { ...input, actor });
      invariant(plan, 'NOT_FOUND', 'Hosted lifecycle operation not found.');
      const operation = await hostedOperationRow(ctx, input.projectId, actor, input.operationId);
      invariant(operation, 'SOURCE_UNAVAILABLE', 'The original lifecycle operation is unavailable.');
      return canonicalPayload({
        ...lifecycleResult(plan),
        terminal: hostedOperationSchema.parse(JSON.parse(operation.value)).terminal,
        projection: { materialized: plan.materialized, appliedThrough: plan.appliedThrough },
      });
    } catch (error) {
      return report(error);
    }
  },
});
/** Explicit resume, with no idle polling. Scheduled ticks use the same primitive. */
export const advance = mutation({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await lifecycleCaller(ctx, input.projectId);
      const plan = await lifecyclePlan(ctx, { ...input, actor });
      invariant(plan, 'NOT_FOUND', 'Hosted lifecycle operation not found.');
      return canonicalPayload(
        plan.status === 'applied' ? await materializeLifecycle(ctx, plan) : await advanceLifecycle(ctx, plan),
      );
    } catch (error) {
      return report(error);
    }
  },
});
export const advanceInternal = internalMutation({
  args: { planId: v.id('projectHostedLifecyclePlans') },
  returns: v.string(),
  handler: async (ctx, input) => {
    const plan = await ctx.db.get(input.planId);
    invariant(plan, 'NOT_FOUND', 'Hosted lifecycle operation not found.');
    return canonicalPayload(
      plan.status === 'applied' ? await materializeLifecycle(ctx, plan) : await advanceLifecycle(ctx, plan),
    );
  },
});
/** Staged events remain private until their common marker applies. Empty pages
 * can contain pending/aborted preparation; keep the opaque continuation cursor. */
export const history = query({
  args: {
    projectId: v.id('hostedProjects'),
    kind: v.union(v.literal('lane'), v.literal('intent')),
    key: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted lifecycle history.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const page = await ctx.db
        .query('projectHostedLifecycleEvents')
        .withIndex('by_project_and_kind_and_key', q =>
          q.eq('projectId', input.projectId).eq('kind', input.kind).eq('key', input.key),
        )
        .paginate({
          cursor: input.cursor,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 128 * 1024,
        });
      const events = [];
      for (const event of page.page)
        if ((await ctx.db.get(event.planId))?.status === 'applied') events.push(JSON.parse(event.value));
      return canonicalPayload({ page: events, isDone: page.isDone, continueCursor: page.continueCursor });
    } catch (error) {
      return report(error);
    }
  },
});

export const saveWake = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    saveOperationId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const page = await ctx.db
      .query('projectHostedLifecyclePlans')
      .withIndex('by_project_and_actor_and_save', q =>
        q
          .eq('projectId', input.projectId)
          .eq('actor', input.actor)
          .eq('saveOperationId', input.saveOperationId),
      )
      .paginate({ cursor: input.cursor, numItems: 20, maximumRowsRead: 20, maximumBytesRead: 128 * 1024 });
    for (const plan of page.page) if (plan.status === 'pending') await scheduleLifecycle(ctx, plan._id);
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedLifecycle:saveWake'), {
        ...input,
        cursor: page.continueCursor,
      });
    return null;
  },
});
