// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, getConvexSize } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { query, mutation, type QueryCtx } from './cliServer';
import { activeProject, memberProject } from './projectAuthority';
import { currentCredential } from './deviceFields';
import { sealedKind } from './sealedSecretFields';
import { invariant } from '../src/errors';
import { report } from './errors';
import { equalBytes, forgeSecretId } from '../src/sealed-portable';
import {
  extendsStored,
  isOwnDeviceEntry,
  nextHandles,
  nextJoinRequests,
  nextSealedState,
  proposalFacts,
  rejectableProposals,
  rememberResolved,
  SEALED_PROPOSALS,
  sealedWriteFacts,
  storedRoster,
} from './sealedSecretGate';
import { linkSealedDevice } from './sealedSecretMarkers';
import { storeMachineReaders } from './sealedMachines';
import { overviewFor } from './sealedSecretOverview';
import { overviewPart, overviewResult } from './sealedSecretOverviewFields';
import { moveSecretsNeeds, patchSetKeepingNeeds } from './sealedSecretNeeds';
import { setNeeds } from '../src/sealed-overview';

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
      /** Gate B2 M3: this CLI sign-in has no sealed device link in this project yet (sealedSecrets:link). */
      unlinked: v.optional(v.literal(true)),
      /** How many proposals wait for a holder (sealedSecrets:proposals lists them); absent when none. */
      proposals: v.optional(v.number()),
      /** Display only: the given names of removed CI machines, for the rotate list a terminal prints. */
      formerNames: v.optional(v.array(v.object({ id: v.bytes(), name: v.string() }))),
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
      // Server-owned side records reach every reader, including a cache hit; absent when empty. A CLI sign-in with
      // no sealed link here is told so from its own credential row, already read (Gate B2 M3).
      const device = ctx.forgeDevice;
      const sides = {
        ...(set.revoked?.length ? { revoked: set.revoked } : {}),
        ...(set.joinRequests?.length ? { joinRequests: set.joinRequests.map(j => j.request) } : {}),
        ...(set.proposals?.length ? { proposals: set.proposals.length } : {}),
        ...(set.formerHandles?.some(h => h.name)
          ? { formerNames: set.formerHandles.flatMap(h => (h.name ? [{ id: h.id, name: h.name }] : [])) }
          : {}),
        ...(device?.deviceKey && !device.sealed?.some(l => l.projectId === args.projectId)
          ? { unlinked: true as const }
          : {}),
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
    /** Waiting proposals this write resolves beyond its own proposal records (adopted, or rejected with it). */
    resolved: v.optional(v.array(v.bytes())),
    /** Slice 5: the read verifier of the machine this write's step adds (convex/sealedMachines.ts). */
    machineReader: v.optional(v.object({ machineId: v.bytes(), verifier: v.bytes() })),
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
        'Sealed secret writes need an unrestricted stable device from nforge login.',
      );
      // Gate B1 C24: current write access, re-read in this mutation, so a removed or lowered member is refused at once.
      const project = await activeProject(Object.assign(ctx, { forgeDevice }), args.projectId, user.subject);
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
      // Gate B1 C21: a genesis is the project owner's. A later head may come from any write member; it must extend the
      // stored head and pass the public verifier below (signer of the caller's own account, authority per shape).
      invariant(
        set || project.owner === user.subject,
        'SECRETS_NOT_SET_UP',
        'This set is not set up yet. The project owner runs nforge secret set NAME first.',
      );
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
      // Review M1: a Checks or Production genesis or step meets the cross-set owner rule on the stored Development
      // roster (one indexed read, only on those writes).
      const development =
        args.kind !== 1 && (args.transition || !set)
          ? await ctx.db
              .query('sealedSecretSets')
              .withIndex('by_project_and_kind_and_active', q =>
                q.eq('projectId', args.projectId).eq('kind', 1).eq('active', true),
              )
              .unique()
          : null;
      const state = nextSealedState({
        set,
        facts,
        genesis: args.genesis,
        transition: args.transition,
        stored: previous ? { genesis: previous.genesis, transitions: previous.transitions } : null,
        // The head signer must be a device of this sign-in's account (the CLI derives the same id from its token).
        accountId: forgeSecretId('account', user.subject),
        ...(development ? { development: storedRoster(development) } : {}),
        ...(args.resolved ? { resolved: args.resolved } : {}),
      });
      if (!state) return { accepted: false, replay: false };
      // Slice 5 (review F4): machine readers, one small row each, follow the roster this write stores. A refused
      // reader stops the write before any row changes.
      await storeMachineReaders(ctx, {
        projectId: args.projectId,
        kind: args.kind,
        setId,
        roster: facts.roster,
        stepped: args.transition !== null,
        genesis: !set,
        owner: project.owner === user.subject,
        reader: args.machineReader,
      });
      // Slice 4: the handles kept beside markers follow the entries they name, and this set's needs-you total moves with
      // the project counter in this same mutation (the head and roster are already decoded for the gate).
      const handles = nextHandles(set, state.revoked, facts.roster);
      const needs = setNeeds(
        facts.roster,
        facts.head,
        state.revoked.map(id => new Uint8Array(id)),
        state.proposals.length,
      );
      const needsBefore = set?.needs ?? 0;
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
        ...(handles.revokedNotes.length ? { revokedNotes: handles.revokedNotes } : {}),
        ...(handles.formerHandles.length ? { formerHandles: handles.formerHandles } : {}),
        needs,
        ...(state.joinRequests.length ? { joinRequests: state.joinRequests } : {}),
        // A sweep's later marking steps still skip the device its issuing browser kept, after this write too.
        ...(set?.sweptKept ? { sweptKept: set.sweptKept } : {}),
        // The gate returns the set row's own entries, unchanged, so their row ids keep their type.
        ...(state.proposals.length
          ? { proposals: state.proposals as NonNullable<typeof set>['proposals'] }
          : {}),
        ...(state.resolvedProposals.length ? { resolvedProposals: state.resolvedProposals } : {}),
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
      // The proposals this write applied, adopted, rejected or made stale go in the same mutation.
      for (const id of state.dropped) await ctx.db.delete(id as Id<'sealedSecretProposals'>);
      // The head's signer is this sign-in's sealed device; ending the sign-in elsewhere marks it here.
      await linkSealedDevice(ctx, forgeDevice, args.projectId, facts.head.signerId);
      await moveSecretsNeeds(ctx, args.projectId, needs - needsBefore, project);
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
      // The newest request is this device's (nextJoinRequests checked its signed binding).
      const joining = new Uint8Array(joinRequests[joinRequests.length - 1]!.deviceId);
      await linkSealedDevice(ctx, forgeDevice, args.projectId, joining);
      return { accepted: true, replay: false };
    } catch (error) {
      return report(error);
    }
  },
});
/** Gate B2 M3: a device that only reads (added with a code, or linked before links existed) records itself on its
 * sign-in once, so ending that sign-in elsewhere marks it. The id must be a device entry of the caller's own account
 * in the active set. One indexed set read and, the first time, one patch of the credential row. */
export const link = mutation({
  args: { projectId: v.id('hostedProjects'), kind: sealedKind, deviceId: v.bytes() },
  returns: v.object({ linked: v.boolean() }),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to use sealed secrets.');
      const { forgeDevice } = ctx;
      invariant(
        forgeDevice?.deviceKey &&
          currentCredential(forgeDevice, user.subject, user.forgeSignIn) &&
          forgeDevice.scope === 'cli',
        'AUTH_SCOPE_DENIED',
        'Sealed secrets need a stable device sign-in from nforge login.',
      );
      await memberProject(ctx, args.projectId, user.subject);
      const set = await ctx.db
        .query('sealedSecretSets')
        .withIndex('by_project_and_kind_and_active', q =>
          q.eq('projectId', args.projectId).eq('kind', args.kind).eq('active', true),
        )
        .unique();
      const deviceId = new Uint8Array(args.deviceId);
      if (!set || !isOwnDeviceEntry(set, forgeSecretId('account', user.subject), deviceId))
        return { linked: false };
      await linkSealedDevice(ctx, forgeDevice, args.projectId, deviceId);
      return { linked: true };
    } catch (error) {
      return report(error);
    }
  },
});

const proposalSet = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, kind: 1 | 2 | 3) =>
  ctx.db
    .query('sealedSecretSets')
    .withIndex('by_project_and_kind_and_active', q =>
      q.eq('projectId', projectId).eq('kind', kind).eq('active', true),
    )
    .unique();
/** Item 6466c6a5: a device on the Development roster that may not change a value directly asks a holder to. The
 * server checks the record's schema, epoch, author (a device of this sign-in's account, not marked) and signature
 * on the stored set, as a holder will, and stores it; it opens nothing. One indexed set read, one insert and one
 * set-row patch. A newer proposal from the same device for the same name replaces its older one. Idempotent by
 * proposal id: the same bytes again is a replay, other bytes under that id are refused. */
export const propose = mutation({
  args: { projectId: v.id('hostedProjects'), kind: sealedKind, proposal: v.bytes() },
  returns: v.object({ accepted: v.boolean(), replay: v.boolean() }),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to propose a secret change.');
      const { forgeDevice } = ctx;
      invariant(
        forgeDevice?.deviceKey &&
          currentCredential(forgeDevice, user.subject, user.forgeSignIn) &&
          forgeDevice.scope === 'cli',
        'AUTH_SCOPE_DENIED',
        'Sealed secrets need a stable device sign-in from nforge login.',
      );
      await activeProject(Object.assign(ctx, { forgeDevice }), args.projectId, user.subject);
      invariant(args.kind === 1, 'SECRETS_NOT_ALLOWED', 'Only Development takes proposals for now.');
      const set = await proposalSet(ctx, args.projectId, args.kind);
      invariant(
        set,
        'SECRETS_NOT_SET_UP',
        'Development is not set up yet. The owner runs nforge secret set NAME.',
      );
      const at = Date.now(),
        facts = proposalFacts(set, args.proposal, forgeSecretId('account', user.subject), at);
      const pending = set.proposals ?? [],
        existing = pending.find(p =>
          equalBytes(new Uint8Array(p.proposalId), new Uint8Array(facts.proposalId)),
        );
      if (existing) {
        const row = await ctx.db.get(existing.id);
        invariant(
          row && same(row.proposal, args.proposal),
          'WORK_OPERATION_REUSED',
          'This proposal id already names a different proposal.',
        );
        return { accepted: true, replay: true };
      }
      // Review F4: a proposal applied, adopted or rejected recently is not stored again.
      invariant(
        !(set.resolvedProposals ?? []).some(id =>
          equalBytes(new Uint8Array(id), new Uint8Array(facts.proposalId)),
        ),
        'WORK_CONFLICT',
        'This proposal was already applied or rejected. Make a new proposal.',
      );
      const replaced = pending.filter(
        p =>
          p.name === facts.name && equalBytes(new Uint8Array(p.proposerId), new Uint8Array(facts.proposerId)),
      );
      const kept = pending.filter(p => !replaced.includes(p));
      const mine = kept.filter(p =>
        equalBytes(new Uint8Array(p.proposerId), new Uint8Array(facts.proposerId)),
      ).length;
      invariant(
        kept.length < SEALED_PROPOSALS.count &&
          mine < SEALED_PROPOSALS.perProposer &&
          kept.reduce((total, p) => total + p.size, facts.size) <= SEALED_PROPOSALS.bytes,
        'SECRETS_NOT_ALLOWED',
        'Too many proposals are waiting for Development. A holder applies or rejects them first.',
      );
      const id = await ctx.db.insert('sealedSecretProposals', {
        projectId: args.projectId,
        kind: args.kind,
        setId: set.setId,
        proposal: args.proposal,
        at,
      });
      const proposals = [...kept, { id, ...facts }];
      // The set row keeps room under its cap for the facts it now lists, so the next head write still fits.
      invariant(
        getConvexSize({ ...set, proposals }) + 128 <= 512 * 1024,
        'SECRETS_NOT_ALLOWED',
        'Too many proposals are waiting for Development. A holder applies or rejects them first.',
      );
      for (const p of replaced) await ctx.db.delete(p.id);
      await patchSetKeepingNeeds(ctx, set, { proposals });
      return { accepted: true, replay: false };
    } catch (error) {
      return report(error);
    }
  },
});
/** The waiting proposals' records, for a holder to open and apply or reject. Read access, like read; at most 32
 * records and 256 KiB. Called only when read reported waiting proposals. */
export const proposals = query({
  args: { projectId: v.id('hostedProjects'), kind: sealedKind },
  returns: v.array(v.bytes()),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to read sealed secrets.');
      await memberProject(ctx, args.projectId, user.subject);
      const set = await proposalSet(ctx, args.projectId, args.kind);
      const rows = await Promise.all((set?.proposals ?? []).map(p => ctx.db.get(p.id)));
      return rows.flatMap(row => (row ? [row.proposal] : []));
    } catch (error) {
      return report(error);
    }
  },
});
/** Rejects waiting proposals without a head write (review F1): the proposer's own account withdraws its own from
 * any write-scoped device; another account's need a person's unmarked write device on the roster, from an
 * unrestricted sign-in. The whole call is refused if any known id is not allowed; unknown ids are ignored, so a
 * retry is harmless. Applying goes through write, which resolves its proposals in the same mutation. */
export const reject = mutation({
  args: { projectId: v.id('hostedProjects'), kind: sealedKind, proposalIds: v.array(v.bytes()) },
  returns: v.object({ rejected: v.number() }),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to reject a proposal.');
      const { forgeDevice } = ctx;
      invariant(
        forgeDevice?.deviceKey &&
          currentCredential(forgeDevice, user.subject, user.forgeSignIn) &&
          forgeDevice.scope === 'cli',
        'AUTH_SCOPE_DENIED',
        'Sealed secrets need a stable device sign-in from nforge login.',
      );
      const holderSignIn =
        forgeDevice.settings?.projects.kind === 'all' && forgeDevice.settings.source === 'write';
      await activeProject(Object.assign(ctx, { forgeDevice }), args.projectId, user.subject);
      invariant(
        args.proposalIds.length <= SEALED_PROPOSALS.count,
        'SECRETS_FORMAT_REFUSED',
        'Reject at most 32 proposals at once.',
      );
      const set = await proposalSet(ctx, args.projectId, args.kind);
      if (!set) return { rejected: 0 };
      const drop = rejectableProposals(
        set,
        forgeSecretId('account', user.subject),
        holderSignIn,
        args.proposalIds,
      );
      if (!drop.length) return { rejected: 0 };
      for (const p of drop) await ctx.db.delete(p.id);
      const left = (set.proposals ?? []).filter(p => !drop.includes(p));
      await patchSetKeepingNeeds(ctx, set, {
        proposals: left.length ? left : undefined,
        resolvedProposals: rememberResolved(set, drop),
      });
      return { rejected: drop.length };
    } catch (error) {
      return report(error);
    }
  },
});

/** The Secrets page's one read (Item 41a0df87, slice 4): names, kinds, versions, holder handles and codes, the rotate
 * list, take-out rows and waiting proposals, all derived from the stored sets without opening any value. Write role
 * only: a reader gets `{status:'reader'}`. The page calls it one-shot, never as a subscription. A page of one set
 * (`kind`, `part`, `after`) is one more call. See sealedSecretOverview.ts for what it reads. */
export const overview = query({
  args: {
    projectId: v.id('hostedProjects'),
    kind: v.optional(sealedKind),
    part: v.optional(overviewPart),
    after: v.optional(v.string()),
  },
  returns: overviewResult,
  handler: async (ctx, args) => {
    try {
      return await overviewFor(ctx, args);
    } catch (error) {
      return report(error);
    }
  },
});
