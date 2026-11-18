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
import { latestActions } from './personWork';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  PERSON_DAYS_PAGES,
  PERSON_DAYS_READ,
  PERSON_PROJECTS_PROBE,
  PERSON_PROJECTS_READ,
  personDaySchema,
  profileRead,
  projectDays,
  withProjectDay,
  keepPlanning,
  type Contribution,
  type PersonDay,
  type ProfileScope,
  type Seen,
} from '../src/person-days';

/** Called by the project's day close: replaces this project's entry in each active person's row for that day.
 * `partial`: the close could not count all of the day's planning work. `lanesOnly`: the contributions are a Lanes-only
 * recount (the Lane backfill), which keeps the planning counts already in the entry. */
export async function recordPersonDays(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  day: string,
  contributions: readonly Contribution[],
  options: { partial?: boolean; lanesOnly?: boolean } = {},
) {
  for (const [person, entry] of projectDays(contributions, options.partial)) {
    const row = await ctx.db
      .query('personDays')
      .withIndex('by_person_and_day', q => q.eq('person', person).eq('day', day))
      .unique();
    const current = row ? personDaySchema.parse(JSON.parse(row.value)) : null;
    const value = canonicalPayload(
      withProjectDay(
        current,
        projectId,
        options.lanesOnly ? keepPlanning(current?.p[projectId], entry) : entry,
      ),
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
  // Caps count what the viewer may see (Item a9ad21c9): a person active mostly in private projects still shows a full
  // year of days and 50 projects to a visitor. The scan stays bounded: PERSON_DAYS_SCAN rows and PERSON_PROJECTS_PROBE
  // projects at most, however private the history.
  const seen = new Map<string, Seen>();
  const handles = new Map<string, string | null>();
  // Private projects where the viewer may write (owner or writer): only there does Latest show the person's open Lanes
  // and comments, as presence and the agent page do. A reader gets landings only.
  const writes = new Set<string>();
  const tried = new Set<string>();
  let probed = 0,
    leftOut = 0;
  const resolve = async (id: string) => {
    if (tried.has(id)) return;
    tried.add(id);
    if (seen.size >= PERSON_PROJECTS_READ || probed >= PERSON_PROJECTS_PROBE) {
      leftOut++;
      return;
    }
    probed++;
    const projectId = ctx.db.normalizeId('hostedProjects', id);
    const project = projectId ? await ctx.db.get(projectId) : null;
    if (!project || project.removal || !project.slug) return;
    const open = isPublicProject(project);
    const role = !self && !open && input.viewer ? await projectRole(ctx, project, input.viewer) : null;
    const shared = role !== null;
    if (!self && !open && !shared) return;
    if (!handles.has(project.owner))
      handles.set(project.owner, (await accountFor(ctx, project.owner))?.handle ?? null);
    const handle = handles.get(project.owner);
    if (!handle) return;
    seen.set(id, { visibility: open ? 'public' : 'private', shared, handle, slug: project.slug });
    if (role === 'owner' || role === 'write') writes.add(id);
  };
  // Newest day first, so a person on many projects keeps the ones they worked on lately.
  const parsed: { day: string; value: PersonDay }[] = [];
  let before: string | undefined;
  scan: for (let page = 0; page < PERSON_DAYS_PAGES; page++) {
    const rows = await ctx.db
      .query('personDays')
      .withIndex('by_person_and_day', q =>
        before === undefined ? q.eq('person', input.owner) : q.eq('person', input.owner).lt('day', before),
      )
      .order('desc')
      .take(PERSON_DAYS_READ);
    for (const row of rows) {
      const value = personDaySchema.parse(JSON.parse(row.value)) as PersonDay;
      const ids = Object.keys(value.p);
      for (const id of ids) await resolve(id);
      if (ids.some(id => seen.has(id))) parsed.push({ day: row.day, value });
      if (parsed.length >= PERSON_DAYS_READ) break scan;
    }
    if (rows.length < PERSON_DAYS_READ) break;
    before = rows.at(-1)!.day;
  }
  const scope: ProfileScope = self ? 'all' : [...seen.values()].some(p => p.shared) ? 'shared' : 'public';
  // Latest reads only projects the viewer may open, newest activity first (`seen` fills in newest-row order); Lanes and
  // comments only for the person themself or where the viewer may write.
  const latest = await latestActions(
    ctx,
    input.owner,
    [...seen].flatMap(([id, project]) => {
      const projectId = ctx.db.normalizeId('hostedProjects', id);
      return projectId
        ? [{ id: projectId, handle: project.handle, slug: project.slug, member: self || writes.has(id) }]
        : [];
    }),
  );
  const read = profileRead({
    handle: input.handle,
    self,
    scope,
    rows: parsed,
    seen,
    // Only the person themself is told about projects past the cap: for anyone else it could hint at a private one.
    projectsLeftOut: self ? leftOut : 0,
    agentsFrom: input.agentsFrom,
  });
  return { ...read, latest };
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
