// SPDX-License-Identifier: Apache-2.0
// Removal markers: when a person loses write access to a project, every active sealed set of the project marks
// that account's entries. Holders see the marker on their next read, and a person's next write on an owner device
// removes the entries and re-keys (design 5.5). The server opens nothing and changes no signed record. A direct
// removal (projectActorNames.retainMembership), a team change and a project trash (below) end here, in the same
// mutation.
import { internalMutation, type MutationCtx } from './server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { forgeSecretId, hex } from '../src/sealed-portable';
import { markableAccountIds, markableAccounts, markersForRemovedAccount } from './sealedSecretGate';
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

async function mark(ctx: MutationCtx, sets: Doc<'sealedSecretSets'>[], accountIds: Uint8Array[]) {
  for (const set of sets) {
    const next = markersForRemovedAccount(set, ...accountIds);
    if (next)
      await ctx.db.patch(set._id, {
        revoked: next.revoked.length ? next.revoked : undefined,
        joinRequests: next.joinRequests.length ? next.joinRequests : undefined,
      });
  }
}

/** One indexed read per set kind (at most three rows) and one patch per set that changes; no other call. */
export async function markRemovedAccount(ctx: MutationCtx, projectId: Id<'hostedProjects'>, account: string) {
  await mark(ctx, await activeSets(ctx, projectId), [forgeSecretId('account', account)]);
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
  const lost: Uint8Array[] = [];
  let seen = 0;
  for (const member of members) {
    if (seen === listed.size) break;
    const id = forgeSecretId('account', member);
    if (!listed.has(hex(id))) continue;
    seen++;
    if (!(await hasWriteRole(ctx, project, member))) lost.push(id);
  }
  if (lost.length) await mark(ctx, sets, lost);
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
