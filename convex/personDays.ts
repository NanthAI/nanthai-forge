// SPDX-License-Identifier: Apache-2.0
// A person's contributions (Item 6a251b23; docs/people.md). The project's day close writes its entry into each
// active person's day row (one read and one write per person active that day, nothing per landing). The profile reads
// at most PERSON_DAYS_READ rows of one person once per page view and keeps only the projects the viewer may open:
// signed out (or a device) sees public projects; a signed-in person also sees private projects both are in; the
// person themself sees all. Rows of a removed project are dropped on read; nothing else is ever sent.
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { query, isDeviceIdentity } from './cliServer';
import { accountFor } from './urlIdentity';
import { isPublicProject } from './publicVisibility';
import { projectRole } from './projectRole';
import { report } from './errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  PERSON_DAYS_READ,
  PERSON_PROJECTS_READ,
  personDaySchema,
  profileRead,
  projectDays,
  withProjectDay,
  type Contribution,
  type PersonDay,
  type ProfileScope,
  type Seen,
} from '../src/person-days';

/** Called by the project's day close: replaces this project's entry in each active person's row for that day. */
export async function recordPersonDays(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  day: string,
  contributions: readonly Contribution[],
) {
  for (const [person, entry] of projectDays(contributions)) {
    const row = await ctx.db
      .query('personDays')
      .withIndex('by_person_and_day', q => q.eq('person', person).eq('day', day))
      .unique();
    const value = canonicalPayload(
      withProjectDay(row ? personDaySchema.parse(JSON.parse(row.value)) : null, projectId, entry),
    );
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert('personDays', { person, day, value });
  }
}

/** The profile for one viewer: `viewer` is an account id, or null when signed out. */
export async function readProfile(
  ctx: QueryCtx,
  input: { owner: string; handle: string; viewer: string | null; agentsFrom: number },
) {
  const self = input.viewer === input.owner;
  const rows = await ctx.db
    .query('personDays')
    .withIndex('by_person_and_day', q => q.eq('person', input.owner))
    .order('desc')
    .take(PERSON_DAYS_READ);
  const parsed = rows.map(row => ({
    day: row.day,
    value: personDaySchema.parse(JSON.parse(row.value)) as PersonDay,
  }));
  // Newest first, so a person on many projects keeps the ones they worked on lately.
  const ids: string[] = [];
  for (const row of parsed) for (const id of Object.keys(row.value.p)) if (!ids.includes(id)) ids.push(id);
  const seen = new Map<string, Seen>();
  const handles = new Map<string, string | null>();
  for (const id of ids.slice(0, PERSON_PROJECTS_READ)) {
    const projectId = ctx.db.normalizeId('hostedProjects', id);
    const project = projectId ? await ctx.db.get(projectId) : null;
    if (!project || project.removal || !project.slug) continue;
    const open = isPublicProject(project);
    const shared =
      !self && !open && input.viewer ? (await projectRole(ctx, project, input.viewer)) !== null : false;
    if (!self && !open && !shared) continue;
    if (!handles.has(project.owner))
      handles.set(project.owner, (await accountFor(ctx, project.owner))?.handle ?? null);
    const handle = handles.get(project.owner);
    if (!handle) continue;
    seen.set(id, { visibility: open ? 'public' : 'private', shared, handle, slug: project.slug });
  }
  const scope: ProfileScope = self ? 'all' : [...seen.values()].some(p => p.shared) ? 'shared' : 'public';
  return profileRead({
    handle: input.handle,
    self,
    scope,
    rows: parsed,
    seen,
    // Only the person themself is told about projects past the cap: for anyone else it could hint at a private one.
    projectsLeftOut: self ? Math.max(0, ids.length - PERSON_PROJECTS_READ) : 0,
    agentsFrom: input.agentsFrom,
  });
}

/** One read per profile view, asked once when the page opens (never a live subscription on the page). */
export const profile = query({
  args: { handle: v.string(), agentsFrom: v.optional(v.number()) },
  returns: v.string(),
  handler: async (ctx, { handle, agentsFrom }) => {
    try {
      const alias = await ctx.db
        .query('accountHandles')
        .withIndex('by_handle', q => q.eq('handle', handle.toLowerCase()))
        .unique();
      const account = alias ? await accountFor(ctx, alias.owner) : null;
      if (!alias || !account?.handle) return canonicalPayload({ missing: true });
      const user = await ctx.auth.getUserIdentity();
      const viewer = user && !isDeviceIdentity(user) ? user.subject : null;
      return canonicalPayload(
        await readProfile(ctx, {
          owner: alias.owner,
          handle: account.handle,
          viewer,
          agentsFrom: Math.max(0, Math.floor(agentsFrom ?? 0)),
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
