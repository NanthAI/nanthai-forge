// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from './cliServer';
import type { Id } from './_generated/dataModel';
import {
  secretCapability,
  secretFields,
  secretVersionFields,
  secretEventFields,
  sealedSecret,
} from './schema';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { report } from './errors';
import {
  affectedGrant,
  descendantGrants,
  grantAuthority,
  grantSummary,
  granter,
  principalGrant,
  revokeDescendants,
} from './secretGrantAuthority';

export type SecretCapability = Infer<typeof secretCapability>;
const all: SecretCapability[] = ['discover', 'names', 'use', 'reveal', 'modify', 'delegate'];
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
const view = v.object({
  id: v.id('secretObjects'),
  name: v.union(v.string(), v.null()),
  repository: v.union(v.string(), v.null()),
  ref: v.union(v.string(), v.null()),
  owned: v.boolean(),
  version: v.number(),
  policyRevision: v.number(),
  disabled: v.boolean(),
  capabilities: v.array(secretCapability),
  expiresAt: v.union(v.number(), v.null()),
  archived: v.boolean(),
  archiveRevision: v.union(v.number(), v.null()),
});
export function secretOperation(value: string) {
  invariant(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    'BAD_ARGUMENT',
    'Use an operation UUID.',
  );
}
async function authority(
  ctx: QueryCtx | MutationCtx,
  id: Id<'secretObjects'>,
  actor: string | undefined,
  capability: SecretCapability,
) {
  invariant(actor, 'SECRET_UNAVAILABLE', 'This Secret Object is unavailable with the current access.');
  const object = await ctx.db.get(id);
  invariant(
    object && !object.deleting,
    'SECRET_UNAVAILABLE',
    'This Secret Object is unavailable with the current access.',
  );
  const { capabilities, expiresAt } = await grantAuthority(ctx, object, actor);
  invariant(
    capabilities.includes(capability) && !(capability === 'use' && object.disabled),
    'SECRET_UNAVAILABLE',
    'This Secret Object is unavailable with the current access.',
  );
  return { object, capabilities, expiresAt };
}
function metadata(auth: Awaited<ReturnType<typeof authority>>, actor: string) {
  const { object, capabilities, expiresAt } = auth,
    names = capabilities.includes('names');
  return {
    id: object._id,
    name: names ? object.name : null,
    repository: names ? object.repository : null,
    ref: names ? object.ref : null,
    owned: object.owner === actor,
    version: object.version,
    policyRevision: object.policyRevision,
    disabled: object.disabled,
    capabilities,
    expiresAt,
    archived: object.owner === actor && Boolean(object.archived),
    archiveRevision: object.owner === actor ? (object.archiveRevision ?? 0) : null,
  };
}
async function event(
  ctx: QueryCtx | MutationCtx,
  id: Id<'secretObjects'>,
  actor: string,
  operationId: string,
) {
  secretOperation(operationId);
  return ctx.db
    .query('secretEvents')
    .withIndex('by_secretId_and_actor_and_operationId', q =>
      q.eq('secretId', id).eq('actor', actor).eq('operationId', operationId),
    )
    .unique();
}
export const list = query({
  args: { paginationOpts: paginationOptsValidator, archived: v.optional(v.boolean()) },
  returns: v.object({ ...paginationResultValidator(view).fields, archiveSupported: v.boolean() }),
  handler: async (ctx, { paginationOpts, archived }) => {
    try {
      const actor = (await ctx.auth.getUserIdentity())?.subject;
      if (!actor) return { page: [], isDone: true, continueCursor: '', archiveSupported: true };
      invariant(
        Number.isSafeInteger(paginationOpts.numItems) && paginationOpts.numItems > 0,
        'BAD_ARGUMENT',
        'Use a positive page size.',
      );
      const cursor = paginationOpts.cursor as Id<'secretObjects'> | null,
        page = [];
      const rows = ctx.db.query('secretGrants').withIndex('by_principal_and_discover_and_secretId', q => {
        const range = q.eq('principal', actor).eq('discover', true);
        return cursor ? range.gt('secretId', cursor) : range;
      });
      // ponytail: indexed seek pages skip expired grants; scheduled pruning if expired-grant scans become material.
      for await (const grant of rows) {
        if (
          !grant.capabilities.includes('discover') ||
          (grant.expiresAt !== undefined && grant.expiresAt <= Date.now())
        )
          continue;
        const object = await ctx.db.get(grant.secretId);
        if (!object || object.deleting) continue;
        if (object.owner === actor ? Boolean(object.archived) !== Boolean(archived) : archived) continue;
        const auth = await grantAuthority(ctx, object, actor);
        if (!auth.capabilities.includes('discover')) continue;
        if (page.length === paginationOpts.numItems)
          return { page, isDone: false, continueCursor: page.at(-1)!.id, archiveSupported: true };
        page.push(metadata({ object, ...auth }, actor));
      }
      return { page, isDone: true, continueCursor: page.at(-1)?.id ?? '', archiveSupported: true };
    } catch (error) {
      return report(error);
    }
  },
});
export const details = query({
  args: { id: v.id('secretObjects') },
  returns: view,
  handler: async (ctx, { id }) => {
    try {
      const actor = (await ctx.auth.getUserIdentity())?.subject;
      return metadata(await authority(ctx, id, actor, 'discover'), actor!);
    } catch (error) {
      return report(error);
    }
  },
});
export const archive = mutation({
  args: {
    id: v.id('secretObjects'),
    archived: v.boolean(),
    expectedArchiveRevision: v.number(),
    operationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const actor = (await ctx.auth.getUserIdentity())?.subject,
        { object } = await authority(ctx, input.id, actor, 'discover');
      invariant(
        object.owner === actor,
        'SECRET_UNAVAILABLE',
        'Only the owner can organize this Secret Object.',
      );
      invariant(
        Number.isSafeInteger(input.expectedArchiveRevision) &&
          input.expectedArchiveRevision >= 0 &&
          input.expectedArchiveRevision < Number.MAX_SAFE_INTEGER,
        'BAD_ARGUMENT',
        'Use the recorded archive revision.',
      );
      const old = await event(ctx, input.id, actor!, input.operationId),
        kind = input.archived ? 'archive' : 'unarchive';
      if (old) {
        invariant(
          old.kind === kind && old.archiveRevision === input.expectedArchiveRevision + 1,
          'BAD_ARGUMENT',
          'This archive operation already has different inputs.',
        );
        return null;
      }
      invariant(
        (object.archiveRevision ?? 0) === input.expectedArchiveRevision,
        'SECRET_CHANGED',
        'Your Secret Object list changed. Refresh its metadata.',
      );
      const archiveRevision = input.expectedArchiveRevision + 1;
      await ctx.db.patch(input.id, { archived: input.archived, archiveRevision });
      await ctx.db.insert('secretEvents', {
        secretId: input.id,
        actor: actor!,
        operationId: input.operationId,
        kind,
        archiveRevision,
        version: object.version,
        policyRevision: object.policyRevision,
        at: Date.now(),
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
// An action's authorization must observe the current clock, never a cached query's earlier time.
export const authorize = internalMutation({
  args: { id: v.id('secretObjects'), actor: v.string(), capability: secretCapability },
  returns: v.object({ object: objectDocument, version: versionDocument }),
  handler: async (ctx, { id, actor, capability }) => {
    try {
      const { object } = await authority(ctx, id, actor, capability);
      const version = await ctx.db
        .query('secretVersions')
        .withIndex('by_secretId_and_version', q => q.eq('secretId', id).eq('version', object.version))
        .unique();
      invariant(version, 'SECRET_INVALID', 'The stored Secret Object version is unavailable.');
      return { object, version };
    } catch (error) {
      return report(error);
    }
  },
});
export const created = internalQuery({
  args: { owner: v.string(), operationId: v.string() },
  returns: v.union(v.object({ object: objectDocument, version: versionDocument }), v.null()),
  handler: async (ctx, { owner, operationId }) => {
    try {
      secretOperation(operationId);
      invariant(
        !(await ctx.db
          .query('secretDeletions')
          .withIndex('by_owner_and_creationOperationId', q =>
            q.eq('owner', owner).eq('creationOperationId', operationId),
          )
          .unique()),
        'SECRET_UNAVAILABLE',
        'This original Secret Object was deleted. Its creation operation cannot recreate it.',
      );
      const object = await ctx.db
        .query('secretObjects')
        .withIndex('by_owner_and_operationId', q => q.eq('owner', owner).eq('operationId', operationId))
        .unique();
      if (!object) return null;
      const version = await ctx.db
        .query('secretVersions')
        .withIndex('by_secretId_and_version', q => q.eq('secretId', object._id).eq('version', 1))
        .unique();
      invariant(version, 'SECRET_INVALID', 'The original Secret Object version is unavailable.');
      return { object, version };
    } catch (error) {
      return report(error);
    }
  },
});
export const rotation = internalQuery({
  args: { id: v.id('secretObjects'), actor: v.string(), operationId: v.string() },
  returns: v.union(versionDocument, v.null()),
  handler: async (ctx, { id, actor, operationId }) => {
    try {
      await authority(ctx, id, actor, 'modify');
      secretOperation(operationId);
      return ctx.db
        .query('secretVersions')
        .withIndex('by_secretId_and_operationId', q => q.eq('secretId', id).eq('operationId', operationId))
        .unique();
    } catch (error) {
      return report(error);
    }
  },
});
export const create = internalMutation({
  args: {
    owner: v.string(),
    name: v.string(),
    operationId: v.string(),
    repository: v.string(),
    ref: v.string(),
    inputTag: v.string(),
    sealed: sealedSecret,
  },
  returns: v.id('secretObjects'),
  handler: async (ctx, input) => {
    try {
      secretOperation(input.operationId);
      invariant(
        !(await ctx.db
          .query('secretDeletions')
          .withIndex('by_owner_and_creationOperationId', q =>
            q.eq('owner', input.owner).eq('creationOperationId', input.operationId),
          )
          .unique()),
        'SECRET_UNAVAILABLE',
        'This original Secret Object was deleted. Its creation operation cannot recreate it.',
      );
      const old = await ctx.db
        .query('secretObjects')
        .withIndex('by_owner_and_operationId', q =>
          q.eq('owner', input.owner).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(!old.deleting, 'SECRET_UNAVAILABLE', 'This Secret Object is being deleted.');
        const version = await ctx.db
          .query('secretVersions')
          .withIndex('by_secretId_and_version', q => q.eq('secretId', old._id).eq('version', 1))
          .unique();
        invariant(
          version?.inputTag === input.inputTag &&
            old.name === input.name &&
            old.repository === input.repository &&
            old.ref === input.ref,
          'BAD_ARGUMENT',
          'This operation already has different Secret Object inputs.',
        );
        return old._id;
      }
      const id = await ctx.db.insert('secretObjects', {
        owner: input.owner,
        name: input.name,
        operationId: input.operationId,
        repository: input.repository,
        ref: input.ref,
        version: 1,
        disabled: false,
        policyRevision: 1,
      });
      await ctx.db.insert('secretVersions', {
        secretId: id,
        version: 1,
        previousVersion: 0,
        operationId: input.operationId,
        inputTag: input.inputTag,
        sealed: input.sealed,
      });
      await ctx.db.insert('secretGrants', {
        secretId: id,
        principal: input.owner,
        capabilities: all,
        discover: true,
        activeUntil: Number.MAX_VALUE,
      });
      await ctx.db.insert('secretEvents', {
        secretId: id,
        actor: input.owner,
        operationId: input.operationId,
        kind: 'create',
        version: 1,
        policyRevision: 1,
        at: Date.now(),
      });
      return id;
    } catch (error) {
      return report(error);
    }
  },
});
export const rotate = internalMutation({
  args: {
    id: v.id('secretObjects'),
    actor: v.string(),
    operationId: v.string(),
    expectedVersion: v.number(),
    inputTag: v.string(),
    sealed: sealedSecret,
  },
  returns: v.number(),
  handler: async (ctx, input) => {
    try {
      const { object } = await authority(ctx, input.id, input.actor, 'modify');
      secretOperation(input.operationId);
      const old = await ctx.db
        .query('secretVersions')
        .withIndex('by_secretId_and_operationId', q =>
          q.eq('secretId', input.id).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(
          old.previousVersion === input.expectedVersion && old.inputTag === input.inputTag,
          'BAD_ARGUMENT',
          'This rotation already has different inputs.',
        );
        return old.version;
      }
      invariant(
        Number.isSafeInteger(input.expectedVersion) && input.expectedVersion === object.version,
        'SECRET_CHANGED',
        'The Secret Object version changed. Refresh its metadata.',
      );
      const version = object.version + 1;
      await ctx.db.insert('secretVersions', {
        secretId: input.id,
        version,
        previousVersion: object.version,
        operationId: input.operationId,
        inputTag: input.inputTag,
        sealed: input.sealed,
      });
      await ctx.db.patch(input.id, { version });
      await ctx.db.insert('secretEvents', {
        secretId: input.id,
        actor: input.actor,
        operationId: input.operationId,
        kind: 'rotate',
        version,
        policyRevision: object.policyRevision,
        at: Date.now(),
      });
      return version;
    } catch (error) {
      return report(error);
    }
  },
});
export const grant = internalMutation({
  args: {
    id: v.id('secretObjects'),
    actor: v.string(),
    principal: v.string(),
    capabilities: v.array(secretCapability),
    expiresAt: v.optional(v.number()),
    expectedPolicyRevision: v.number(),
    operationId: v.string(),
  },
  returns: v.array(affectedGrant),
  handler: async (ctx, input) => {
    try {
      const auth = await authority(ctx, input.id, input.actor, 'delegate'),
        { object } = auth;
      const capabilities = all.filter(cap => input.capabilities.includes(cap));
      invariant(
        input.principal !== object.owner && capabilities.every(cap => auth.capabilities.includes(cap)),
        'SECRET_UNAVAILABLE',
        'Delegation cannot expand your Secret Object capabilities or change its owner.',
      );
      invariant(
        input.expiresAt === undefined || Number.isSafeInteger(input.expiresAt),
        'BAD_ARGUMENT',
        'Use an expiry timestamp or leave it unset.',
      );
      invariant(
        auth.expiresAt === null || (input.expiresAt !== undefined && input.expiresAt <= auth.expiresAt),
        'SECRET_UNAVAILABLE',
        'Delegation cannot outlive your authority.',
      );
      const old = await event(ctx, input.id, input.actor, input.operationId);
      if (old) {
        invariant(
          old.kind === 'grant' &&
            old.principal === input.principal &&
            JSON.stringify(old.capabilities) === JSON.stringify(capabilities) &&
            old.expiresAt === input.expiresAt &&
            old.policyRevision === input.expectedPolicyRevision + 1,
          'BAD_ARGUMENT',
          'This grant operation already has different inputs.',
        );
        return old.affectedGrants ?? [];
      }
      invariant(
        object.policyRevision === input.expectedPolicyRevision,
        'SECRET_CHANGED',
        'The Secret Object policy changed. Refresh its metadata.',
      );
      const row = await ctx.db
        .query('secretGrants')
        .withIndex('by_secretId_and_principal', q =>
          q.eq('secretId', input.id).eq('principal', input.principal),
        )
        .unique();
      const previousAuthority = row ? await grantAuthority(ctx, object, input.principal) : null;
      const affected =
        !capabilities.length || (previousAuthority !== null && !previousAuthority.capabilities.length)
          ? await revokeDescendants(ctx, object, input.principal, input.actor, input.operationId)
          : [];
      const parent = input.actor === object.owner ? null : await principalGrant(ctx, input.id, input.actor);
      const values = {
        secretId: input.id,
        principal: input.principal,
        capabilities,
        grantedBy:
          input.actor === input.principal && row ? ((await granter(ctx, row)) ?? input.actor) : input.actor,
        ...(parent && input.actor !== input.principal ? { parentGrantId: parent._id } : {}),
        discover: capabilities.includes('discover'),
        activeUntil: input.expiresAt ?? Number.MAX_VALUE,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      };
      if (!capabilities.length) {
        if (row) await ctx.db.delete(row._id);
      } else if (row)
        await ctx.db.patch(row._id, {
          ...values,
          expiresAt: input.expiresAt,
          revokedAt: undefined,
          parentGrantId: input.actor === input.principal ? row.parentGrantId : parent?._id,
        });
      else await ctx.db.insert('secretGrants', values);
      if (capabilities.length && input.expiresAt !== undefined)
        await ctx.scheduler.runAt(Math.max(Date.now(), input.expiresAt), internal.secrets.expire, {
          id: input.id,
          principal: input.principal,
          expiresAt: input.expiresAt,
          operationId: input.operationId,
        });
      await ctx.db.patch(input.id, { policyRevision: object.policyRevision + 1 });
      await ctx.db.insert('secretEvents', {
        secretId: input.id,
        actor: input.actor,
        operationId: input.operationId,
        kind: 'grant',
        affectedGrants: affected,
        version: object.version,
        policyRevision: object.policyRevision + 1,
        at: Date.now(),
        principal: input.principal,
        capabilities,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });
      return affected;
    } catch (error) {
      return report(error);
    }
  },
});
export const expire = internalMutation({
  args: { id: v.id('secretObjects'), principal: v.string(), expiresAt: v.number(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const object = await ctx.db.get(input.id),
        grant = await ctx.db
          .query('secretGrants')
          .withIndex('by_secretId_and_principal', q =>
            q.eq('secretId', input.id).eq('principal', input.principal),
          )
          .unique();
      if (
        !object ||
        object.deleting ||
        !grant ||
        grant.expiresAt !== input.expiresAt ||
        object.owner === input.principal
      )
        return null;
      if (Date.now() < input.expiresAt) {
        await ctx.scheduler.runAt(input.expiresAt, internal.secrets.expire, input);
        return null;
      }
      const source = await ctx.db
        .query('secretEvents')
        .withIndex('by_secretId_and_principal_and_policyRevision', q =>
          q.eq('secretId', input.id).eq('principal', input.principal),
        )
        .order('desc')
        .take(1);
      if (source[0]?.operationId !== input.operationId) return null;
      const affected = await revokeDescendants(
        ctx,
        object,
        input.principal,
        'forge:expiry',
        input.operationId,
      );
      await ctx.db.delete(grant._id);
      await ctx.db.patch(input.id, { policyRevision: object.policyRevision + 1 });
      await ctx.db.insert('secretEvents', {
        secretId: input.id,
        actor: 'forge:expiry',
        operationId: input.operationId,
        kind: 'expire',
        affectedGrants: affected,
        version: object.version,
        policyRevision: object.policyRevision + 1,
        principal: input.principal,
        capabilities: [],
        expiresAt: input.expiresAt,
        at: Date.now(),
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const enabled = mutation({
  args: {
    id: v.id('secretObjects'),
    enabled: v.boolean(),
    expectedPolicyRevision: v.number(),
    operationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const actor = (await ctx.auth.getUserIdentity())?.subject,
        { object } = await authority(ctx, input.id, actor, 'delegate');
      invariant(
        object.owner === actor,
        'SECRET_UNAVAILABLE',
        'Only the owner can enable or disable this broker.',
      );
      const old = await event(ctx, input.id, actor!, input.operationId),
        kind = input.enabled ? 'enable' : 'disable';
      if (old) {
        invariant(
          old.kind === kind && old.policyRevision === input.expectedPolicyRevision + 1,
          'BAD_ARGUMENT',
          'This policy operation already has different inputs.',
        );
        return null;
      }
      invariant(
        object.policyRevision === input.expectedPolicyRevision,
        'SECRET_CHANGED',
        'The Secret Object policy changed. Refresh its metadata.',
      );
      await ctx.db.patch(input.id, { disabled: !input.enabled, policyRevision: object.policyRevision + 1 });
      await ctx.db.insert('secretEvents', {
        secretId: input.id,
        actor: actor!,
        operationId: input.operationId,
        kind,
        version: object.version,
        policyRevision: object.policyRevision + 1,
        at: Date.now(),
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const receipt = internalMutation({
  args: { id: v.id('secretObjects'), actor: v.string(), operationId: v.string() },
  returns: v.union(eventDocument, v.null()),
  handler: async (ctx, { id, actor, operationId }) => {
    try {
      await authority(ctx, id, actor, 'use');
      const old = await event(ctx, id, actor, operationId);
      invariant(!old || old.kind === 'use', 'BAD_ARGUMENT', 'This operation already records another action.');
      return old;
    } catch (error) {
      return report(error);
    }
  },
});
export const finish = internalMutation({
  args: {
    id: v.id('secretObjects'),
    actor: v.string(),
    operationId: v.string(),
    capability: v.union(v.literal('use'), v.literal('reveal')),
    version: v.number(),
    policyRevision: v.number(),
    sha: v.optional(v.string()),
  },
  returns: eventDocument,
  handler: async (ctx, input) => {
    try {
      const { object } = await authority(ctx, input.id, input.actor, input.capability),
        old = await event(ctx, input.id, input.actor, input.operationId);
      invariant(
        input.capability !== 'reveal' ||
          (object.version === input.version && object.policyRevision === input.policyRevision),
        'SECRET_CHANGED',
        'The Secret Object version or policy changed during this operation.',
      );
      if (old) {
        invariant(
          old.kind === input.capability && (input.capability === 'use' || old.version === input.version),
          'BAD_ARGUMENT',
          'This operation already records other inputs.',
        );
        return old;
      }
      invariant(
        object.version === input.version && object.policyRevision === input.policyRevision,
        'SECRET_CHANGED',
        'The Secret Object version or policy changed during this operation.',
      );
      invariant(
        input.capability !== 'use' || (input.sha && /^[a-f0-9]{40,64}$/.test(input.sha)),
        'GITHUB_RESPONSE',
        'GitHub returned an invalid commit.',
      );
      const id = await ctx.db.insert('secretEvents', {
        secretId: input.id,
        actor: input.actor,
        operationId: input.operationId,
        kind: input.capability,
        version: object.version,
        policyRevision: object.policyRevision,
        at: Date.now(),
        ...(input.sha ? { sha: input.sha } : {}),
      });
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const revocationPreview = query({
  args: { id: v.id('secretObjects'), principal: v.string() },
  returns: v.object({ policyRevision: v.number(), grants: v.array(affectedGrant) }),
  handler: async (ctx, { id, principal }) => {
    try {
      const { object } = await authority(ctx, id, (await ctx.auth.getUserIdentity())?.subject, 'delegate');
      invariant(
        principal !== object.owner,
        'SECRET_UNAVAILABLE',
        'The Secret Object owner cannot be revoked.',
      );
      return {
        policyRevision: object.policyRevision,
        grants: (await descendantGrants(ctx, id, principal)).map(grantSummary),
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const grants = query({
  args: { id: v.id('secretObjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      principal: v.string(),
      capabilities: v.array(secretCapability),
      expiresAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, { id, paginationOpts }) => {
    try {
      await authority(ctx, id, (await ctx.auth.getUserIdentity())?.subject, 'delegate');
      const result = await ctx.db
        .query('secretGrants')
        .withIndex('by_secretId_and_principal', q => q.eq('secretId', id))
        .paginate(paginationOpts);
      return {
        ...result,
        page: result.page
          .filter(row => row.revokedAt === undefined)
          .map(row => ({
            principal: row.principal,
            capabilities: row.capabilities,
            expiresAt: row.expiresAt ?? null,
          })),
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const audit = query({
  args: { id: v.id('secretObjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(eventDocument),
  handler: async (ctx, { id, paginationOpts }) => {
    try {
      const actor = (await ctx.auth.getUserIdentity())?.subject,
        { object } = await authority(ctx, id, actor, 'discover');
      invariant(
        object.owner === actor,
        'SECRET_UNAVAILABLE',
        'This audit is unavailable with the current access.',
      );
      return await ctx.db
        .query('secretEvents')
        .withIndex('by_secretId', q => q.eq('secretId', id))
        .order('desc')
        .paginate(paginationOpts);
    } catch (error) {
      return report(error);
    }
  },
});
