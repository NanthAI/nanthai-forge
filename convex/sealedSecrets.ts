// SPDX-License-Identifier: Apache-2.0
import { v, getConvexSize } from 'convex/values';
import { query, mutation } from './cliServer';
import { activeOwnedProject, memberProject } from './projectAuthority';
import { currentCredential } from './deviceFields';
import { sealedKind } from './sealedSecretFields';
import { invariant } from '../src/errors';
import { report } from './errors';

const history = v.object({
  genesis: v.bytes(),
  transitions: v.array(v.bytes()),
  rotateLists: v.array(v.bytes()),
});
const same = (a: ArrayBuffer, b: ArrayBuffer) =>
  a.byteLength === b.byteLength && new Uint8Array(a).every((byte, i) => byte === new Uint8Array(b)[i]);
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    kind: sealedKind,
    rosterVersion: v.optional(v.number()),
    headHash: v.optional(v.bytes()),
  },
  returns: v.union(
    v.null(),
    v.object({ payload: v.union(v.bytes(), v.null()), history: v.union(history, v.null()) }),
  ),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to read sealed secrets.');
      await memberProject(ctx, args.projectId, user.subject);
      const set = await ctx.db
        .query('sealedSecretSets')
        .withIndex('by_project_and_kind_and_active', q =>
          q.eq('projectId', args.projectId).eq('kind', args.kind).eq('active', true),
        )
        .unique();
      if (!set) return null;
      if (args.headHash && same(args.headHash, set.headHash)) return { payload: null, history: null };
      const row =
        args.rosterVersion === set.rosterVersion
          ? null
          : await ctx.db
              .query('sealedSecretHistory')
              .withIndex('by_project_and_setId', q =>
                q.eq('projectId', args.projectId).eq('setId', set.setId),
              )
              .unique();
      return {
        payload: set.payload,
        history: row
          ? { genesis: row.genesis, transitions: row.transitions, rotateLists: row.rotateLists }
          : null,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const write = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    kind: sealedKind,
    operationId: v.string(),
    prevHeadHash: v.union(v.bytes(), v.null()),
    setId: v.bytes(),
    headHash: v.bytes(),
    headVersion: v.number(),
    rosterVersion: v.number(),
    payload: v.bytes(),
    history: v.union(history, v.null()),
  },
  returns: v.object({ accepted: v.boolean(), replay: v.boolean() }),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to store sealed secrets.');
      const { forgeDevice } = ctx;
      invariant(
        forgeDevice?.deviceKey &&
          currentCredential(forgeDevice, user.subject, user.forgeSignIn) &&
          forgeDevice.scope === 'cli' &&
          forgeDevice.settings?.projects.kind === 'all' &&
          forgeDevice.settings.source === 'write',
        'AUTH_SCOPE_DENIED',
        'Sealed secret writes need an unrestricted stable owner device from nforge login.',
      );
      await activeOwnedProject(Object.assign(ctx, { forgeDevice }), args.projectId, user.subject);
      const set = await ctx.db
        .query('sealedSecretSets')
        .withIndex('by_project_and_kind_and_active', q =>
          q.eq('projectId', args.projectId).eq('kind', args.kind).eq('active', true),
        )
        .unique();
      const previous = await ctx.db
        .query('sealedSecretHistory')
        .withIndex('by_project_and_setId', q => q.eq('projectId', args.projectId).eq('setId', args.setId))
        .unique();
      const replay = previous?.events.find(e => e.operationId === args.operationId);
      if (replay) {
        invariant(
          same(replay.headHash, args.headHash),
          'WORK_OPERATION_REUSED',
          'This operation already names a different signed head.',
        );
        return { accepted: true, replay: true };
      }
      const matches = set
        ? args.prevHeadHash && same(set.headHash, args.prevHeadHash)
        : args.prevHeadHash === null;
      if (!matches) return { accepted: false, replay: false };
      invariant(
        args.setId.byteLength === 16 &&
          args.headHash.byteLength === 32 &&
          args.headVersion === (set?.headVersion ?? 0) + 1 &&
          args.rosterVersion >= (set?.rosterVersion ?? 1) &&
          args.payload.byteLength <= 512 * 1024,
        'SECRETS_FORMAT_REFUSED',
        'Sealed record exceeds format bounds.',
      );
      if (set)
        invariant(
          same(args.setId, set.setId),
          'SECRETS_SET_REPLACED',
          'Replace a set through its signed replacement flow.',
        );
      const retained =
        args.history ??
        (previous
          ? {
              genesis: previous.genesis,
              transitions: previous.transitions,
              rotateLists: previous.rotateLists,
            }
          : null);
      invariant(retained, 'SECRETS_FORMAT_REFUSED', 'Genesis history is required.');
      const next = {
        projectId: args.projectId,
        kind: args.kind,
        v: 1 as const,
        active: true,
        supersededAt: null,
        setId: args.setId,
        headHash: args.headHash,
        headVersion: args.headVersion,
        rosterVersion: args.rosterVersion,
        payload: args.payload,
      };
      const events = [
        ...(previous?.events ?? []),
        { operationId: args.operationId, headHash: args.headHash, at: Date.now() },
      ].slice(-50);
      invariant(
        !previous || same(retained.genesis, previous.genesis),
        'SECRETS_FORMAT_REFUSED',
        'A set keeps its first genesis permanently.',
      );
      const nextHistory = {
        projectId: args.projectId,
        kind: args.kind,
        setId: args.setId,
        v: 1 as const,
        ...retained,
        transitions: retained.transitions.slice(-64),
        events,
      };
      invariant(
        getConvexSize(next) + 128 <= 512 * 1024 &&
          getConvexSize(nextHistory) + 128 <= 128 * 1024 &&
          retained.rotateLists.length <= 20,
        'SECRETS_FORMAT_REFUSED',
        'Sealed set or history exceeds its record cap.',
      );
      if (set) await ctx.db.replace(set._id, next);
      else await ctx.db.insert('sealedSecretSets', next);
      if (previous) await ctx.db.replace(previous._id, nextHistory);
      else await ctx.db.insert('sealedSecretHistory', nextHistory);
      return { accepted: true, replay: false };
    } catch (error) {
      return report(error);
    }
  },
});
