// SPDX-License-Identifier: Apache-2.0
import { v, getConvexSize } from 'convex/values';
import { query, mutation } from './cliServer';
import { activeOwnedProject, activeProject, memberProject } from './projectAuthority';
import { currentCredential } from './deviceFields';
import { sealedKind } from './sealedSecretFields';
import { invariant } from '../src/errors';
import { report } from './errors';
import { equalBytes } from '../src/sealed-portable';
import { extendsStored, nextJoinRequests, nextSealedState, sealedWriteFacts } from './sealedSecretGate';

const history = v.object({
  genesis: v.bytes(),
  transitions: v.array(v.bytes()),
});
const same = (a: ArrayBuffer, b: ArrayBuffer) => equalBytes(new Uint8Array(a), new Uint8Array(b));
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    kind: sealedKind,
    rosterVersion: v.optional(v.number()),
    headHash: v.optional(v.bytes()),
  },
  returns: v.union(
    v.null(),
    v.object({
      payload: v.union(v.bytes(), v.null()),
      history: v.union(history, v.null()),
      revoked: v.optional(v.array(v.bytes())),
      joinRequests: v.optional(v.array(v.bytes())),
    }),
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
      // Server-owned side records reach every reader, including a cache hit; absent when empty.
      const sides = {
        ...(set.revoked?.length ? { revoked: set.revoked } : {}),
        ...(set.joinRequests?.length ? { joinRequests: set.joinRequests.map(j => j.request) } : {}),
      };
      if (args.headHash && same(args.headHash, set.headHash))
        return { payload: null, history: null, ...sides };
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
        history: row ? { genesis: row.genesis, transitions: row.transitions } : null,
        ...sides,
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
    payload: v.bytes(),
    genesis: v.union(v.bytes(), v.null()),
    transition: v.union(v.bytes(), v.null()),
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
      invariant(
        (args.genesis?.byteLength ?? 0) <= 128 * 1024 && (args.transition?.byteLength ?? 0) <= 128 * 1024,
        'SECRETS_FORMAT_REFUSED',
        'Sealed record exceeds format bounds.',
      );
      // Hash, versions and set id come from the signed payload, never from arguments.
      const facts = sealedWriteFacts(args.projectId, args.kind, args.payload);
      const setId = Uint8Array.from(facts.head.setId).buffer,
        headHash = Uint8Array.from(facts.headHash).buffer;
      const set = await ctx.db
        .query('sealedSecretSets')
        .withIndex('by_project_and_kind_and_active', q =>
          q.eq('projectId', args.projectId).eq('kind', args.kind).eq('active', true),
        )
        .unique();
      const previous = await ctx.db
        .query('sealedSecretHistory')
        .withIndex('by_project_and_setId', q => q.eq('projectId', args.projectId).eq('setId', setId))
        .unique();
      const replay = previous?.events.find(e => e.operationId === args.operationId);
      if (replay) {
        invariant(
          same(replay.headHash, headHash),
          'WORK_OPERATION_REUSED',
          'This operation already names a different signed head.',
        );
        return { accepted: true, replay: true };
      }
      if (!extendsStored(set, facts)) return { accepted: false, replay: false };
      const state = nextSealedState({
        set,
        facts,
        genesis: args.genesis,
        transition: args.transition,
        stored: previous ? { genesis: previous.genesis, transitions: previous.transitions } : null,
      });
      if (!state) return { accepted: false, replay: false };
      const next = {
        projectId: args.projectId,
        kind: args.kind,
        v: 1 as const,
        active: true,
        supersededAt: null,
        setId,
        headHash,
        headVersion: facts.head.headVersion,
        rosterVersion: facts.roster.rosterVersion,
        payload: args.payload,
        ...(state.revoked.length ? { revoked: state.revoked } : {}),
        ...(state.joinRequests.length ? { joinRequests: state.joinRequests } : {}),
      };
      const events = [
        ...(previous?.events ?? []),
        { operationId: args.operationId, headHash, at: Date.now() },
      ].slice(-50);
      const nextHistory = {
        projectId: args.projectId,
        kind: args.kind,
        setId,
        v: 1 as const,
        genesis: state.genesis,
        transitions: state.transitions.slice(-64),
        events,
      };
      // The ring keeps the newest steps that fit its record; a reader past it needs a holder code.
      while (nextHistory.transitions.length > 1 && getConvexSize(nextHistory) + 128 > 128 * 1024)
        nextHistory.transitions.shift();
      invariant(
        getConvexSize(next) + 128 <= 512 * 1024 && getConvexSize(nextHistory) + 128 <= 128 * 1024,
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
/** Design 5.1: a write member's new device asks to be shared Development. One small patch of the set row; the
 * next holder device that runs wraps the key for it in its own signed write. Idempotent by request bytes. */
export const join = mutation({
  args: { projectId: v.id('hostedProjects'), kind: sealedKind, request: v.bytes() },
  returns: v.object({ accepted: v.boolean(), replay: v.boolean() }),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to join sealed secrets.');
      const { forgeDevice } = ctx;
      invariant(
        forgeDevice?.deviceKey &&
          currentCredential(forgeDevice, user.subject, user.forgeSignIn) &&
          forgeDevice.scope === 'cli',
        'AUTH_SCOPE_DENIED',
        'Sealed secrets need a stable device sign-in from nforge login.',
      );
      await activeProject(Object.assign(ctx, { forgeDevice }), args.projectId, user.subject);
      const set = await ctx.db
        .query('sealedSecretSets')
        .withIndex('by_project_and_kind_and_active', q =>
          q.eq('projectId', args.projectId).eq('kind', args.kind).eq('active', true),
        )
        .unique();
      const joinRequests = nextJoinRequests({
        projectId: args.projectId,
        account: user.subject,
        kind: args.kind,
        set,
        request: args.request,
        at: Date.now(),
      });
      if (!joinRequests) return { accepted: true, replay: true };
      await ctx.db.patch(set!._id, { joinRequests });
      return { accepted: true, replay: false };
    } catch (error) {
      return report(error);
    }
  },
});
