// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { protectSourceUnion } from './projectCheckLogCleanupSource';
import { internalQuery, internalMutation } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { projectGuard } from './projectCheckLogCleanupGuard';
import { invariant } from '../src/errors';
import type { Identity, PlanState, Node, PlanWrite } from './projectCheckLogCleanupTypes';
const identity = { projectId: v.id('hostedProjects'), actor: v.string(), operationId: v.string() };
async function ledger(ctx: QueryCtx | MutationCtx, input: Identity) {
  return ctx.db
    .query('projectCheckLogCleanups')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', input.projectId).eq('operationId', input.operationId),
    )
    .unique();
}
async function page(ctx: QueryCtx | MutationCtx, input: Identity, part: string, position: number) {
  return ctx.db
    .query('projectCheckLogCleanupPages')
    .withIndex('by_project_and_operation_and_part_and_position', q =>
      q
        .eq('projectId', input.projectId)
        .eq('operationId', input.operationId)
        .eq('part', part)
        .eq('position', position),
    )
    .unique();
}
async function put(ctx: MutationCtx, input: Identity, write: PlanWrite) {
  const prior = await page(ctx, input, write.part, write.position);
  if (prior) await ctx.db.patch(prior._id, { value: write.value });
  else
    await ctx.db.insert('projectCheckLogCleanupPages', {
      projectId: input.projectId,
      operationId: input.operationId,
      ...write,
    });
}
export const read = internalQuery({
  args: identity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const row = await ledger(ctx, input);
    if (row) {
      const state = JSON.parse(row.value);
      const project = await activeOwnedProject(ctx, input.projectId, input.actor);
      invariant(
        (state.phase === 'ready' &&
          state.offset === state.counts?.objects &&
          state.outputOffset === state.counts?.hostedOutputs) ||
          state.guard === (await projectGuard(ctx, project)),
        'WORK_STALE',
        'Project changed after cleanup planning; prepare a fresh plan file.',
      );
    }
    return row?.value ?? null;
  },
});
export const begin = internalMutation({
  args: { ...identity, value: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.actor);
    const prior = await ledger(ctx, input);
    if (prior) return prior.value;
    const state: PlanState = JSON.parse(input.value);
    state.guard = await projectGuard(ctx, project);
    const value = JSON.stringify(state);
    await ctx.db.insert('projectCheckLogCleanups', {
      projectId: input.projectId,
      operationId: input.operationId,
      value,
    });
    return value;
  },
});
export const lookup = internalQuery({
  args: { ...identity, part: v.string(), position: v.number() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    return (await page(ctx, input, input.part, input.position))?.value ?? null;
  },
});
export const nodes = internalQuery({
  args: { ...identity, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const result = await ctx.db
      .query('projectCheckLogCleanupPages')
      .withIndex('by_project_and_operation_and_part_and_position', q =>
        q
          .eq('projectId', input.projectId)
          .eq('operationId', input.operationId)
          .gte('part', 'node:')
          .lt('part', 'node;'),
      )
      .paginate({ cursor: input.cursor, numItems: 25 });
    const rows = [];
    for (const row of result.page) {
      const node: Node = JSON.parse(row.value);
      const object =
        node.candidate && !node.protected ? await page(ctx, input, `object:${node.key}`, 0) : null;
      rows.push({ ...row, object: object ? JSON.parse(object.value) : null });
    }
    return JSON.stringify({ ...result, page: rows });
  },
});
/** Cursor, scratch effects, propagation queues and reviewed pages commit together.
 * A concurrent/lost step reply re-observes the winner without repeating effects. */
export const step = internalMutation({
  args: { ...identity, expected: v.string(), value: v.string(), nodes: v.string(), writes: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.actor),
      row = await ledger(ctx, input);
    invariant(row, 'NOT_FOUND', 'Prepare this cleanup first.');
    if (row.value !== input.expected) return row.value;
    const state: PlanState = JSON.parse(input.value);
    invariant(
      state.guard === (await projectGuard(ctx, project)),
      'WORK_STALE',
      'Project changed after cleanup planning; prepare a fresh plan file.',
    );
    for (const change of JSON.parse(input.nodes) as Node[]) {
      const part = `node:${change.key}`,
        prior = await page(ctx, input, part, 0);
      const before: Node = prior ? JSON.parse(prior.value) : { key: change.key };
      for (const flag of ['candidate', 'protected', 'state', 'tree'] as const) {
        const propagation = flag === 'candidate' || flag === 'protected';
        const hasChildren = (change.children ?? before.children)?.length;
        const newChildren = change.children?.length && !before.children?.length;
        if (
          !(change[flag] || before[flag]) ||
          (before[flag] && !(propagation && newChildren)) ||
          (propagation && !hasChildren)
        )
          continue;
        const tree = flag === 'tree';
        await put(ctx, input, {
          part: tree ? 'treeQueue' : 'queue',
          position: tree ? state.treeCount++ : state.queueCount++,
          value: JSON.stringify({ key: change.key, kind: flag }),
        });
      }
      const value = JSON.stringify({
        ...before,
        ...change,
        candidate: before.candidate || change.candidate,
        protected: before.protected || change.protected,
        state: before.state || change.state,
      });
      if (prior?.value !== value) await put(ctx, input, { part, position: 0, value });
    }
    for (const write of JSON.parse(input.writes) as PlanWrite[]) {
      if (write.part === 'sourceProtection') await protectSourceUnion(ctx, input, JSON.parse(write.value));
      else await put(ctx, input, write);
    }
    const value = JSON.stringify(state);
    await ctx.db.patch(row._id, { value });
    return value;
  },
});

export const queue = internalQuery({
  args: { ...identity, offset: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const entries = await ctx.db
      .query('projectCheckLogCleanupPages')
      .withIndex('by_project_and_operation_and_part_and_position', q =>
        q
          .eq('projectId', input.projectId)
          .eq('operationId', input.operationId)
          .eq('part', 'queue')
          .gte('position', input.offset),
      )
      .take(25);
    const result = [];
    for (const row of entries) {
      const entry = JSON.parse(row.value),
        saved = await page(ctx, input, `node:${entry.key}`, 0);
      result.push({ ...entry, node: saved ? JSON.parse(saved.value) : null });
    }
    return JSON.stringify(result);
  },
});

export const sources = internalQuery({
  args: { ...identity, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const result = await ctx.db
      .query('projectCheckLogCleanupPages')
      .withIndex('by_project_and_operation_and_part_and_position', q =>
        q
          .eq('projectId', input.projectId)
          .eq('operationId', input.operationId)
          .gte('part', 'sourceUnion:')
          .lt('part', 'sourceUnion;'),
      )
      .paginate({ cursor: input.cursor, numItems: 1 });
    return JSON.stringify({ ...result, page: result.page.flatMap(row => JSON.parse(row.value).pins) });
  },
});
