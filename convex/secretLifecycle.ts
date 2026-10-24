// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, mutation, internalMutation, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id, Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { secretFields, secretVersionFields, secretEventFields, secretCapability } from './schema';
import { secretOperation } from './secrets';
import { invariant } from '../src/errors';
import { report } from './errors';

const pins = { version: v.number(), policyRevision: v.number(), archiveRevision: v.number() };
const objectDocument = v.object({ _id: v.id('secretObjects'), _creationTime: v.number(), ...secretFields });
const versionDocument = v.object({
  _id: v.id('secretVersions'),
  _creationTime: v.number(),
  ...secretVersionFields,
});
const eventDocument = v.object({
  _id: v.id('secretEvents'),
  _creationTime: v.number(),
  ...secretEventFields,
});
const grantDocument = v.object({
  _id: v.id('secretGrants'),
  _creationTime: v.number(),
  secretId: v.id('secretObjects'),
  principal: v.string(),
  capabilities: v.array(secretCapability),
  expiresAt: v.optional(v.number()),
  discover: v.boolean(),
  activeUntil: v.number(),
  grantedBy: v.optional(v.string()),
  parentGrantId: v.optional(v.id('secretGrants')),
  revokedAt: v.optional(v.number()),
});
const receipt = v.object({
  id: v.id('secretObjects'),
  operationId: v.string(),
  at: v.number(),
  status: v.union(v.literal('deleting'), v.literal('deleted')),
});
async function owner(ctx: QueryCtx | MutationCtx, id: Id<'secretObjects'>) {
  const actor = (await ctx.auth.getUserIdentity())?.subject,
    object = await ctx.db.get(id);
  invariant(
    actor && object?.owner === actor && !object.deleting,
    'SECRET_UNAVAILABLE',
    'This Secret Object is unavailable with the current access.',
  );
  return object;
}
function pinned(
  object: Doc<'secretObjects'>,
  expected: { version: number; policyRevision: number; archiveRevision: number },
) {
  invariant(
    object.version === expected.version &&
      object.policyRevision === expected.policyRevision &&
      (object.archiveRevision ?? 0) === expected.archiveRevision,
    'SECRET_CHANGED',
    'This Secret Object changed during export or deletion. Refresh its metadata.',
  );
}
export const exportInfo = query({
  args: { id: v.id('secretObjects') },
  returns: v.object({
    schemaVersion: v.literal(1),
    kind: v.literal('forge-secret-object'),
    object: objectDocument,
    pins: v.object(pins),
    eventThrough: v.union(v.number(), v.null()),
    eventThroughId: v.union(v.id('secretEvents'), v.null()),
    grantsAuthority: v.literal('historical-only'),
  }),
  handler: async (ctx, { id }) => {
    try {
      const object = await owner(ctx, id),
        last = await ctx.db
          .query('secretEvents')
          .withIndex('by_secretId', q => q.eq('secretId', id))
          .order('desc')
          .take(1);
      return {
        schemaVersion: 1 as const,
        kind: 'forge-secret-object' as const,
        object,
        pins: {
          version: object.version,
          policyRevision: object.policyRevision,
          archiveRevision: object.archiveRevision ?? 0,
        },
        eventThrough: last[0]?._creationTime ?? null,
        eventThroughId: last[0]?._id ?? null,
        grantsAuthority: 'historical-only' as const,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const exportPage = query({
  args: {
    id: v.id('secretObjects'),
    ...pins,
    part: v.union(v.literal('versions'), v.literal('grants'), v.literal('events')),
    eventThrough: v.union(v.number(), v.null()),
    eventThroughId: v.union(v.id('secretEvents'), v.null()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(v.union(versionDocument, grantDocument, eventDocument)),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, input) => {
    try {
      pinned(await owner(ctx, input.id), input);
      const latest = await ctx.db
        .query('secretEvents')
        .withIndex('by_secretId', q => q.eq('secretId', input.id))
        .order('desc')
        .take(1);
      invariant(
        (latest[0]?._id ?? null) === input.eventThroughId &&
          (latest[0]?._creationTime ?? null) === input.eventThrough,
        'SECRET_CHANGED',
        'The audit changed during export. Retry its new recorded state.',
      );
      let result;
      if (input.part === 'versions')
        result = await ctx.db
          .query('secretVersions')
          .withIndex('by_secretId_and_version', q => q.eq('secretId', input.id))
          .paginate(input.paginationOpts);
      else if (input.part === 'grants')
        result = await ctx.db
          .query('secretGrants')
          .withIndex('by_secretId_and_principal', q => q.eq('secretId', input.id))
          .paginate(input.paginationOpts);
      else if (input.eventThrough === null) return { page: [], isDone: true, continueCursor: '' };
      else
        result = await ctx.db
          .query('secretEvents')
          .withIndex('by_secretId', q => q.eq('secretId', input.id).lte('_creationTime', input.eventThrough!))
          .paginate(input.paginationOpts);
      return { page: result.page, isDone: result.isDone, continueCursor: result.continueCursor };
    } catch (error) {
      return report(error);
    }
  },
});
export const deletions = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ ...receipt.fields, ...pins })),
  handler: async (ctx, { paginationOpts }) => {
    const actor = (await ctx.auth.getUserIdentity())?.subject;
    if (!actor) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('secretDeletions')
      .withIndex('by_owner', q => q.eq('owner', actor))
      .order('desc')
      .paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map(row => ({
        ...deletionReceipt(row),
        version: row.expectedVersion,
        policyRevision: row.expectedPolicyRevision,
        archiveRevision: row.expectedArchiveRevision,
      })),
    };
  },
});
function deletionReceipt(row: Doc<'secretDeletions'>) {
  return { id: row.secretId, operationId: row.operationId, at: row.at, status: row.status };
}
export const deletion = query({
  args: { id: v.id('secretObjects'), operationId: v.string() },
  returns: v.union(receipt, v.null()),
  handler: async (ctx, input) => {
    try {
      const actor = (await ctx.auth.getUserIdentity())?.subject;
      secretOperation(input.operationId);
      invariant(actor, 'SECRET_UNAVAILABLE', 'This Secret Object is unavailable with the current access.');
      const row = await ctx.db
        .query('secretDeletions')
        .withIndex('by_secretId', q => q.eq('secretId', input.id))
        .unique();
      return row?.owner === actor && row.operationId === input.operationId ? deletionReceipt(row) : null;
    } catch (error) {
      return report(error);
    }
  },
});
async function resume(ctx: MutationCtx, row: Doc<'secretDeletions'>) {
  if (row.status === 'deleted') return;
  const task = row.task ? await ctx.db.system.get(row.task) : null;
  if (task && ['pending', 'inProgress'].includes(task.state.kind)) return;
  const next = await ctx.scheduler.runAfter(0, internal.secretLifecycle.purge, { deletionId: row._id });
  await ctx.db.patch(row._id, { task: next });
}
export async function deleteSecret(
  ctx: MutationCtx,
  input: {
    id: Id<'secretObjects'>;
    operationId: string;
    version: number;
    policyRevision: number;
    archiveRevision: number;
  },
) {
  const actor = (await ctx.auth.getUserIdentity())?.subject;
  secretOperation(input.operationId);
  invariant(actor, 'SECRET_UNAVAILABLE', 'This Secret Object is unavailable with the current access.');
  const old = await ctx.db
    .query('secretDeletions')
    .withIndex('by_secretId', q => q.eq('secretId', input.id))
    .unique();
  if (old) {
    invariant(
      old.owner === actor,
      'SECRET_UNAVAILABLE',
      'This Secret Object is unavailable with the current access.',
    );
    invariant(
      old.operationId === input.operationId &&
        old.expectedVersion === input.version &&
        old.expectedPolicyRevision === input.policyRevision &&
        old.expectedArchiveRevision === input.archiveRevision,
      'SECRET_CHANGED',
      'Reconcile the original Secret Object deletion operation and its recorded inputs.',
    );
    await resume(ctx, old);
    return deletionReceipt(old);
  }
  const object = await owner(ctx, input.id);
  pinned(object, input);
  const deletionId = await ctx.db.insert('secretDeletions', {
    secretId: input.id,
    owner: actor,
    creationOperationId: object.operationId,
    operationId: input.operationId,
    expectedVersion: input.version,
    expectedPolicyRevision: input.policyRevision,
    expectedArchiveRevision: input.archiveRevision,
    at: Date.now(),
    status: 'deleting',
  });
  await ctx.db.patch(input.id, { deleting: true });
  const row = (await ctx.db.get(deletionId))!;
  await resume(ctx, row);
  return deletionReceipt(row);
}
export const permanentlyDelete = mutation({
  args: { id: v.id('secretObjects'), operationId: v.string(), ...pins },
  returns: receipt,
  handler: async (ctx, input) => {
    try {
      return await deleteSecret(ctx, input);
    } catch (error) {
      return report(error);
    }
  },
});
export const purge = internalMutation({
  args: { deletionId: v.id('secretDeletions') },
  returns: v.null(),
  handler: async (ctx, { deletionId }) => {
    const row = await ctx.db.get(deletionId);
    if (!row || row.status === 'deleted') return null;
    const object = await ctx.db.get(row.secretId);
    invariant(
      !object || (object.deleting && object.owner === row.owner),
      'SECRET_INVALID',
      'The retained deletion does not own this object.',
    );
    const versions = await ctx.db
      .query('secretVersions')
      .withIndex('by_secretId_and_version', q => q.eq('secretId', row.secretId))
      .take(1);
    const grants = await ctx.db
      .query('secretGrants')
      .withIndex('by_secretId_and_principal', q => q.eq('secretId', row.secretId))
      .take(50);
    const events = await ctx.db
      .query('secretEvents')
      .withIndex('by_secretId', q => q.eq('secretId', row.secretId))
      .take(50);
    for (const item of [...versions, ...grants, ...events]) await ctx.db.delete(item._id);
    if (versions.length === 1 || [grants, events].some(items => items.length === 50)) {
      const task = await ctx.scheduler.runAfter(0, internal.secretLifecycle.purge, { deletionId });
      await ctx.db.patch(deletionId, { task });
    } else {
      if (object) await ctx.db.delete(object._id);
      await ctx.db.patch(deletionId, { status: 'deleted', task: undefined });
    }
    return null;
  },
});
