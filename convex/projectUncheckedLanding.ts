// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { report } from './errors';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { AcceptanceActor, AutonomyPolicy } from '../src/autonomy-policy';
import { invariant } from '../src/errors';
import { hasWriteRole } from './projectRole';
type Ctx = QueryCtx | MutationCtx;
type Selection = NonNullable<AutonomyPolicy['acceptance']['withoutCheck']>;
/** Current write access, direct or through a linked team (`projectRole`). */
const writer = hasWriteRole;

/** The single unchecked-landing authority, called only without passing check evidence.
 * Current membership is read in the final publication transaction, never cached from a picker. */
export async function mayLandUnchecked(
  ctx: Ctx,
  project: Doc<'hostedProjects'>,
  policy: AutonomyPolicy,
  actor: AcceptanceActor,
): Promise<boolean> {
  if (actor.kind !== 'person') return false;
  if (actor.id === project.owner) return true;
  const selection = policy.acceptance.withoutCheck;
  if (!selection || selection.mode === 'owner') return false;
  if (!(await writer(ctx, project, actor.id))) return false;
  if (selection.mode === 'writers' || selection.people.includes(actor.id)) return true;
  for (const value of selection.teams) {
    const id = ctx.db.normalizeId('teams', value);
    if (!id) continue;
    const team = await ctx.db.get(id);
    if (!team || team.removal || team.owner !== project.owner) continue;
    if (
      await ctx.db
        .query('teamMembers')
        .withIndex('by_teamId_and_member', q => q.eq('teamId', id).eq('member', actor.id))
        .unique()
    )
      return true;
  }
  return false;
}

/** Handles are resolved to accounts before storage. Existing revoked selections may remain;
 * only newly picked people need current write access. They never retain bypass authority. */
export async function resolveUncheckedSelection(
  ctx: Ctx,
  project: Doc<'hostedProjects'>,
  value: Selection,
  previous?: Selection,
  validateNew = true,
): Promise<Selection> {
  const people: string[] = [];
  for (const raw of value.people) {
    const handle = raw.replace(/^@/, '').trim().toLowerCase();
    const account = await ctx.db
      .query('accountHandles')
      .withIndex('by_handle', q => q.eq('handle', handle))
      .unique();
    const person = account?.owner ?? raw;
    invariant(
      !validateNew ||
        previous?.people.includes(person) ||
        person === project.owner ||
        (await writer(ctx, project, person)),
      'BAD_ARGUMENT',
      'Choose a Forge handle with current project write access. Read-only people cannot land unchecked.',
    );
    people.push(person);
  }
  const teams: string[] = [];
  for (const raw of value.teams) {
    let id = ctx.db.normalizeId('teams', raw);
    if (!id) {
      const matches = await ctx.db
        .query('teams')
        .withIndex('by_owner_and_name', q => q.eq('owner', project.owner).eq('name', raw.trim()))
        .take(2);
      invariant(matches.length === 1, 'BAD_ARGUMENT', 'Choose a unique existing team name or its team id.');
      id = matches[0]!._id;
    }
    if (validateNew && !previous?.teams.includes(id)) {
      const team = await ctx.db.get(id);
      invariant(
        team && !team.removal && team.owner === project.owner,
        'BAD_ARGUMENT',
        'Choose an existing team managed by the project owner.',
      );
    }
    teams.push(id);
  }
  return { mode: value.mode, people: [...new Set(people)], teams: [...new Set(teams)] };
}

/** Picker validation adds no grant and returns only the chosen public handle. */
export const pickPerson = query({
  args: { projectId: v.id('hostedProjects'), handle: v.string() },
  returns: v.object({ handle: v.string() }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to choose a person.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      const handle = input.handle.replace(/^@/, '').trim().toLowerCase();
      const account = await ctx.db
        .query('accountHandles')
        .withIndex('by_handle', q => q.eq('handle', handle))
        .unique();
      invariant(account, 'BAD_ARGUMENT', 'Choose an existing Forge handle.');
      invariant(
        account.owner === project.owner || (await writer(ctx, project, account.owner)),
        'BAD_ARGUMENT',
        'Choose a person with current project write access.',
      );
      return { handle };
    } catch (error) {
      return report(error);
    }
  },
});
