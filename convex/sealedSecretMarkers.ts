// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Removal markers: when a person loses write access to a project, every active sealed set of the project marks
// that account's entries. Holders see the marker on their next read, and a person's next write on an owner device
// removes the entries and re-keys (design 5.5). The server opens nothing and changes no signed record. A direct
// removal (projectActorNames.retainMembership), a team change and a project trash (below) end here, in the same
// mutation. Ending one device's sign-in elsewhere (deviceCredentials.revoke) marks that device alone (Gate B2 M3).
// "Sign out everywhere" marks every device of the account; the device the person approves in the browser session
// that issued it clears its own mark where no owner device is left unmarked (clearSweptSignIn, sole-owner follow-up).
import { internalMutation, type MutationCtx } from './server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { equalBytes, forgeSecretId, hex } from '../src/sealed-portable';
import {
  clearSweptOwnerMark,
  markableAccountIds,
  markableAccounts,
  markersForEndedDevice,
  markersForRemovedAccount,
  nextMarkNotes,
  rememberResolved,
  unmarkedProposals,
} from './sealedSecretGate';
import { patchSetKeepingNeeds } from './sealedSecretNeeds';
import { hasWriteRole } from './projectRole';

/** The project's active sets: one indexed read per set kind (at most three rows). */
async function activeSets(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const sets = [];
  for (const kind of [1, 2, 3] as const) {
    const set = await ctx.db
      .query('sealedSecretSets')
      .withIndex('by_project_and_kind_and_active', q =>
        q.eq('projectId', projectId).eq('kind', kind).eq('active', true),
      )
      .unique();
    if (set) sets.push(set);
  }
  return sets;
}

async function mark(
  ctx: MutationCtx,
  sets: Doc<'sealedSecretSets'>[],
  accountIds: Uint8Array[],
  markers = (set: Doc<'sealedSecretSets'>) => markersForRemovedAccount(set, ...accountIds),
  /** Public Forge handles of people who left the project, by hex account id (slice 4: "after @handle left"). */
  handles: ReadonlyMap<string, string> = new Map(),
) {
  const at = Date.now();
  for (const set of sets) {
    const next = markers(set);
    if (!next) {
      // Nothing new to mark, but a computer signed out earlier may now belong to a person who left: its marker takes
      // their public handle, so the page says they left rather than that a computer was signed out.
      const notes = handles.size ? nextMarkNotes(set, set.revoked ?? [], handles, at) : null;
      if (notes) await ctx.db.patch(set._id, { revokedNotes: notes });
      continue;
    }
    // Review F2: a marked proposer's waiting proposals leave in the same mutation (at most 32 deletes, no read).
    const { proposals, dropped } = unmarkedProposals(set, next.revoked);
    for (const p of dropped) await ctx.db.delete(p.id);
    const notes = nextMarkNotes(set, next.revoked, handles, at);
    await patchSetKeepingNeeds(ctx, set, {
      revoked: next.revoked.length ? next.revoked : undefined,
      joinRequests: next.joinRequests.length ? next.joinRequests : undefined,
      ...(notes ? { revokedNotes: notes.length ? notes : undefined } : {}),
      ...(dropped.length
        ? {
            proposals: proposals.length ? proposals : undefined,
            resolvedProposals: rememberResolved(set, dropped),
          }
        : {}),
    });
  }
}

/** One indexed read per set kind (at most three rows) and one patch per set that changes; no other call. */
export async function markRemovedAccount(ctx: MutationCtx, projectId: Id<'hostedProjects'>, account: string) {
  const sets = await activeSets(ctx, projectId);
  if (!sets.length) return;
  const id = forgeSecretId('account', account);
  await mark(ctx, sets, [id], undefined, new Map(await handleOf(ctx, account, id)));
}
/** The public Forge handle of `account`, kept beside its markers so the Secrets page can say who left. One indexed
 * read, only when a set exists. A handle only; never a name or an email. */
async function handleOf(ctx: MutationCtx, account: string, id: Uint8Array): Promise<[string, string][]> {
  const row = await ctx.db
    .query('forgeAccounts')
    .withIndex('by_owner', q => q.eq('owner', account))
    .unique();
  return row?.handle ? [[hex(id), row.handle]] : [];
}

/** Trashing a project removes every grant but its owner's, and a restore brings none back (projectRetention
 * `revokedTables`): every other account an active set lists (an entry or a waiting join request) is marked, in the
 * trash mutation, so a restored project's owner removes and re-keys on their next write. Permanent deletion purges
 * the sets with the project (projectPurgeInventory). A project with no active set reads only its three empty set
 * ranges; one with sets reads no grant or member, and patches each set that changes. */
export async function markTrashedProject(ctx: MutationCtx, projectId: Id<'hostedProjects'>, owner: string) {
  const sets = await activeSets(ctx, projectId);
  if (!sets.length) return;
  const self = hex(forgeSecretId('account', owner)),
    others = new Map<string, Uint8Array>();
  for (const id of sets.flatMap(markableAccountIds)) if (hex(id) !== self) others.set(hex(id), id);
  if (others.size) await mark(ctx, sets, [...others.values()]);
}

/** Team members one step reads: with the write check of each listed one (a direct grant read and the team lookup,
 * about a hundred documents at most), a step stays far inside a mutation's read limits for any team size. */
export const TEAM_MARK_PAGE = 100;

/** After a team change that can take write access from its members (applied before this call): one step over the
 * next `TEAM_MARK_PAGE` members of `teamId` after `after`. Marks each one who has an entry or a waiting join request
 * in a set and no longer writes the project (a direct grant or another write team keeps it). A project with no
 * active set reads only its three empty set ranges and no member. `next` is the last member read when more remain. */
export async function markTeamPage(
  ctx: MutationCtx,
  project: Project,
  teamId: Id<'teams'>,
  after: string | null,
) {
  const sets = await activeSets(ctx, project._id);
  if (!sets.length) return { sealed: false, next: null };
  const rows = await ctx.db
    .query('teamMembers')
    .withIndex('by_teamId_and_member', q =>
      after === null ? q.eq('teamId', teamId) : q.eq('teamId', teamId).gt('member', after),
    )
    .take(TEAM_MARK_PAGE);
  await markLost(
    ctx,
    project,
    sets,
    rows.map(row => row.member),
  );
  const last = rows.length === TEAM_MARK_PAGE ? rows[rows.length - 1] : undefined;
  return { sealed: true, next: last ? last.member : null };
}
type Project = Pick<Doc<'hostedProjects'>, '_id' | 'owner' | 'teamLinks'>;
async function markLost(
  ctx: MutationCtx,
  project: Project,
  sets: Doc<'sealedSecretSets'>[],
  members: string[],
) {
  const listed = new Set(sets.flatMap(markableAccounts));
  const lost: Uint8Array[] = [],
    handles = new Map<string, string>();
  let seen = 0;
  for (const member of members) {
    if (seen === listed.size) break;
    const id = forgeSecretId('account', member);
    if (!listed.has(hex(id))) continue;
    seen++;
    if (!(await hasWriteRole(ctx, project, member))) {
      lost.push(id);
      for (const [key, handle] of await handleOf(ctx, member, id)) handles.set(key, handle);
    }
  }
  if (lost.length) await mark(ctx, sets, lost, undefined, handles);
}

/** The rest of a team change's marking when the team has more members than one step reads (`projectTeamAccess.set`):
 * write already ended in that change, and a person without write cannot read a sealed set meanwhile. */
export const markTeam = internalMutation({
  args: { projectId: v.id('hostedProjects'), teamId: v.id('teams'), after: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, teamId, after }) => {
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    const step = await markTeamPage(ctx, project, teamId, after);
    if (step.next !== null) await continueMarking(ctx, projectId, teamId, step.next);
    return null;
  },
});
export async function continueMarking(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  teamId: Id<'teams'>,
  after: string,
) {
  await ctx.scheduler.runAfter(0, internal.sealedSecretMarkers.markTeam, { projectId, teamId, after });
}

/** `member` just left `team` (removed by its creator, or left it): every project the team gives write marks them
 * where they no longer write. One read of the team's links; per write link, the project's set ranges, and its row and
 * the member's grants only when it has a set. */
export async function markLeftTeam(ctx: MutationCtx, team: Doc<'teams'>, member: string) {
  for await (const link of ctx.db
    .query('projectTeams')
    .withIndex('by_teamId_and_projectId', q => q.eq('teamId', team._id))) {
    if (link.role !== 'write') continue;
    const sets = await activeSets(ctx, link.projectId);
    if (!sets.length) continue;
    const project = await ctx.db.get(link.projectId);
    if (project?.owner === team.owner) await markLost(ctx, project, sets, [member]);
  }
}

/** Gate B2 M3: the sealed devices a CLI sign-in acted as, per project, kept on its credential row (`sealed`). */
type SealedLink = NonNullable<Doc<'cliCredentials'>['sealed']>[number];
/** One sign-in acts as one sealed device; a new key store adds a second id. Bounds the credential row (read on every
 * call) at about 6 KB. */
export const SEALED_LINKS = 100;
/** Projects one end-of-sign-in step marks: three bounded set reads each (512 KiB at most per set). */
export const DEVICE_MARK_PAGE = 4;

/** Records that `device` (the caller's credential row, already read by the guard) acts as sealed device `deviceId`
 * in `projectId`, so ending that sign-in marks it there. Called from a sealed write (the head's signer) and a join
 * request (the joining device). No read; one patch of the credential row the first time per project and device. */
export async function linkSealedDevice(
  ctx: MutationCtx,
  device: Doc<'cliCredentials'>,
  projectId: Id<'hostedProjects'>,
  deviceId: Uint8Array,
) {
  let links = device.sealed ?? [];
  if (links.some(l => l.projectId === projectId && equalBytes(new Uint8Array(l.deviceId), deviceId))) return;
  // At the bound only, links to purged projects go first: one read per linked project, at most once per refusal.
  if (links.length >= SEALED_LINKS) {
    const live = new Set<string>();
    for (const id of new Set(links.map(l => l.projectId))) {
      const project = ctx.db.normalizeId('hostedProjects', id);
      if (project && (await ctx.db.get(project))) live.add(id);
    }
    links = links.filter(l => live.has(l.projectId));
  }
  invariant(
    links.length < SEALED_LINKS,
    'SECRETS_NOT_ALLOWED',
    `This device sign-in already holds sealed secrets in ${SEALED_LINKS} projects, the most one sign-in tracks for device removal.`,
  );
  const sealed = [...links, { projectId, deviceId: Uint8Array.from(deviceId).buffer }];
  await ctx.db.patch(device._id, { sealed });
  device.sealed = sealed;
}

/** Gate B2 M3: a sign-in ended (signed out from elsewhere, or removed), so each linked project marks its sealed
 * device: a lost laptop is removed and re-keyed on the next owner write, with its rotate list. The first
 * `DEVICE_MARK_PAGE` projects mark in the ending mutation and the rest in scheduled steps; the sign-in already
 * ended, so the device cannot read a set meanwhile. A sign-in with no link reads nothing. `sweep`: this sign-in is one
 * of the account's "Sign out everywhere" (convex/deviceEndAll.ts, markersForEndedDevice), at that sign-out epoch; a
 * device the sweep's issuing browser already kept in a set (`sweptKept`, clearSweptSignIn) is not marked again. */
export async function markEndedSignIn(
  ctx: MutationCtx,
  owner: string,
  links: readonly SealedLink[],
  sweep: number | null = null,
) {
  const projects = [...new Set(links.map(l => l.projectId))];
  if (!projects.length) return;
  const page = projects.slice(0, DEVICE_MARK_PAGE),
    accountId = forgeSecretId('account', owner);
  for (const projectId of page) {
    const project = ctx.db.normalizeId('hostedProjects', projectId);
    if (!project) continue;
    const deviceIds = links.filter(l => l.projectId === projectId).map(l => new Uint8Array(l.deviceId));
    await mark(ctx, await activeSets(ctx, project), [], set =>
      markersForEndedDevice(set, accountId, deviceIds, {
        everywhere: sweep !== null,
        kept:
          sweep !== null && set.sweptKept?.epoch === sweep
            ? set.sweptKept.ids.map(id => new Uint8Array(id))
            : [],
      }),
    );
  }
  const rest = links.filter(l => !page.includes(l.projectId));
  if (rest.length) await scheduleSignInMarks(ctx, owner, rest, sweep);
}
/** One "Sign out everywhere" page's sealed links (convex/deviceEndAll.ts), at sign-out epoch `sweep`: the account's
 * signed-out sign-ins often repeat one device in one project, so each (project, device) pair is marked once, in steps
 * of `SEALED_LINKS` pairs sorted by project (at most one step per swept row). The everywhere rule is order
 * independent, so how the pairs are split does not change what is marked. */
export async function scheduleAccountMarks(
  ctx: MutationCtx,
  owner: string,
  links: readonly SealedLink[],
  sweep: number,
) {
  const unique = new Map<string, SealedLink>();
  for (const l of links) unique.set(`${l.projectId}:${hex(new Uint8Array(l.deviceId))}`, l);
  const sorted = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, l]) => l);
  for (let i = 0; i < sorted.length; i += SEALED_LINKS)
    await scheduleSignInMarks(ctx, owner, sorted.slice(i, i + SEALED_LINKS), sweep);
}
/** The rest of one ended sign-in's marking, in its own scheduled step. */
async function scheduleSignInMarks(
  ctx: MutationCtx,
  owner: string,
  links: readonly SealedLink[],
  sweep: number | null,
) {
  await ctx.scheduler.runAfter(0, internal.sealedSecretMarkers.markSignIn, {
    owner,
    links: [...links],
    ...(sweep !== null ? { everywhere: true as const, sweep } : {}),
  });
}
export const markSignIn = internalMutation({
  args: {
    owner: v.string(),
    links: v.array(v.object({ projectId: v.string(), deviceId: v.bytes() })),
    everywhere: v.optional(v.literal(true)),
    /** The sweep's sign-out epoch (steps scheduled before it was recorded carry `everywhere` alone). */
    sweep: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { owner, links, everywhere, sweep }) => {
    await markEndedSignIn(ctx, owner, links, everywhere ? (sweep ?? -1) : null);
    return null;
  },
});

/** Sole-owner follow-up (owner 2026-11-23): the account's latest "Sign out everywhere", as the users row records it
 * (`sealedSweep`). Its issuing browser session is the only one whose device approvals clear a sweep's marks: that
 * action ended every other browser session, the lost laptop's included. The role lasts `SWEEP_KEEP_MS`. */
/** The sweep is still the account's latest sign-out (a later sweep or an operator suspension moves the epoch on). */
export const currentSweep = (account: Doc<'users'> | null, now = Date.now()) =>
  account?.sealedSweep &&
  account.sealedSweep.epoch === (account.deviceSignOutEpoch ?? 0) &&
  account.sealedSweep.until > now
    ? account.sealedSweep
    : null;
/** How long the issuing browser keeps the role: long enough to reach the device at hand; then sweep again. */
export const SWEEP_KEEP_MS = 7 * 86400000;

/** A device sign-in was just approved in the sweep's issuing session with a fresh passkey or GitHub check
 * (deviceStore.decide). In each project its credential links, where the account still writes and no owner device is
 * left unmarked, its own owner-role entry is unmarked (clearSweptOwnerMark). The first `DEVICE_MARK_PAGE` projects
 * clear in the approving mutation, the rest in scheduled steps that re-check the sweep is still the latest. Per
 * project: the set kinds (at most three); the project row and its write check only when a set qualifies; one patch
 * per cleared set. */
export async function clearSweptSignIn(
  ctx: MutationCtx,
  owner: string,
  links: readonly SealedLink[],
  epoch: number,
) {
  const projects = [...new Set(links.map(l => l.projectId))];
  const page = projects.slice(0, DEVICE_MARK_PAGE),
    accountId = forgeSecretId('account', owner);
  for (const projectId of page) {
    const id = ctx.db.normalizeId('hostedProjects', projectId);
    if (!id) continue;
    const deviceIds = links.filter(l => l.projectId === projectId).map(l => new Uint8Array(l.deviceId));
    let writes: boolean | undefined;
    for (const set of await activeSets(ctx, id)) {
      const cleared = clearSweptOwnerMark(set, accountId, deviceIds);
      if (!cleared) continue;
      if (writes === undefined) {
        const project = await ctx.db.get(id);
        writes = Boolean(project && (await hasWriteRole(ctx, project, owner)));
      }
      if (!writes) break;
      // The sweep's later marking steps skip what this approval kept (an approval can run between them).
      const notes = nextMarkNotes(set, cleared.revoked, new Map(), Date.now());
      await patchSetKeepingNeeds(ctx, set, {
        revoked: cleared.revoked.length ? cleared.revoked : undefined,
        ...(notes ? { revokedNotes: notes.length ? notes : undefined } : {}),
        sweptKept: { epoch, ids: cleared.kept },
      });
    }
  }
  const rest = links.filter(l => !page.includes(l.projectId));
  if (rest.length)
    await ctx.scheduler.runAfter(0, internal.sealedSecretMarkers.clearSweptStep, {
      owner,
      links: [...rest],
      epoch,
    });
}
export const clearSweptStep = internalMutation({
  args: {
    owner: v.string(),
    links: v.array(v.object({ projectId: v.string(), deviceId: v.bytes() })),
    epoch: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { owner, links, epoch }) => {
    const account = await ctx.db
      .query('users')
      .withIndex('by_accountKey', q => q.eq('accountKey', owner))
      .unique();
    if (currentSweep(account)?.epoch === epoch) await clearSweptSignIn(ctx, owner, links, epoch);
    return null;
  },
});
