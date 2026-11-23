// SPDX-License-Identifier: Apache-2.0
// The one audience rule for the board, agent coordination and Lane holders (Item b6588425; docs/access.md#audience).
// Every input is the caller's current role from `projectRole` (direct grants and linked teams) and the project row the
// caller already loaded, so the rule adds no read of its own.
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { ProjectRole } from './projectAccessContract';
import { accessibleProject, requireDeviceWrite } from './projectAuthority';
import { hasWriteRole, projectRole } from './projectRole';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';

type Project = Pick<Doc<'hostedProjects'>, 'visibility' | 'autonomyPolicy'>;
export const unavailable = 'This Forge project is unavailable with the current account.';

/** `team`: the owner and write members, direct or through a linked team; they read and post everything.
 * `follows`: also a private project's readers, who read coordination as they read the rest of the project; nobody
 * else on a public project. `contributor`: under the `team-and-contributors` board audience, a reader who is not on
 * the team may post board notes to the team and read only their own notes and the replies to them. There is no
 * audience that opens the board or coordination to everyone. */
export function audienceOf(project: Project, role: ProjectRole | null) {
  const team = role === 'owner' || role === 'write';
  return {
    team,
    follows: team || (role === 'read' && project.visibility !== 'public'),
    contributor:
      !team &&
      role === 'read' &&
      project.autonomyPolicy?.agentDefaults?.boardAudience === 'team-and-contributors',
  };
}

/** Whether the viewer reads the team's coordination, Lane holders included. Call after `accessibleProject`: a
 * private project has already required a role, so only a public project reads membership (the owner none). */
export async function coordinationAccess(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  viewer: string,
) {
  return project.visibility !== 'public' || (await hasWriteRole(ctx, project, viewer));
}

/** The agent session holding a Lane names a person, so it follows the public identity rule (`publicPeople` strips
 * `holder` for anyone without write): shown to the team only, readers of any project included out. The owner costs
 * no read; a role the query already checked is reused. */
export async function laneHolderFor<T>(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  viewer: string,
  holder: T | undefined,
): Promise<T | undefined> {
  return holder !== undefined && (await hasWriteRole(ctx, project, viewer)) ? holder : undefined;
}

/** The board gate. The team reads and posts; a contributor (see `audienceOf`) posts to the team and reads only their
 * own notes; anyone else gets the private project's refusal. Owners cost no membership read and direct members one,
 * as before. A write device is required, as for every board call. */
export async function boardCaller(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read or record project context.');
  await requireDeviceWrite(ctx, projectId);
  const project = await accessibleProject(ctx, projectId, user.subject);
  const audience = audienceOf(project, await projectRole(ctx, project, user.subject));
  invariant(audience.team || audience.contributor, 'PROJECT_UNAVAILABLE', unavailable);
  invariant(
    sourceAuthority(project).mode !== 'native-owner',
    'HOSTED_ACTION_UNSUPPORTED',
    'This project retains native record authority.',
  );
  return { actor: user.subject, project, team: audience.team };
}
