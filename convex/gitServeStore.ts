// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery } from './server';
import { accessibleProject } from './projectAuthority';
import { resolveProjectId } from './urlProjects';
import { loadHistory, mirrorMapping } from './projectHistoryStore';
import { hostedStartMain } from './projectHostedChannels';
import { ForgeError } from '../src/errors';
import { isMember, laneRefs } from './gitServeLaneStore';
import { workerUsage } from './gitServeWorkerStore';

/** Everything one Git smart-HTTP request needs, in one query: the presented Forge
 * credential (hash-checked against its row), current project access, stored history
 * packs, main's mirror mapping, hosted main's head and, for members, built Lane refs
 * (a page, or the named and wanted ones). Never per object or per commit. */
export const load = internalQuery({
  args: {
    projectId: v.optional(v.string()),
    handle: v.optional(v.string()),
    slug: v.optional(v.string()),
    credential: v.optional(v.object({ credentialId: v.string(), tokenHash: v.string() })),
    /** Lane refs (members only): list the built ones, and/or find the Lanes named or wanted. */
    lanes: v.optional(
      v.object({ list: v.boolean(), named: v.array(v.string()), commits: v.array(v.string()) }),
    ),
    /** A Worker session's credential: its token hash was checked when the session was signed;
     * the row's revocation, expiry and scope are checked again here. */
    sessionCredentialId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, input) => {
    let actor = '';
    const credentialId = input.credential?.credentialId ?? input.sessionCredentialId;
    if (credentialId) {
      const row = await ctx.db
        .query('cliCredentials')
        .withIndex('by_credentialId', q => q.eq('credentialId', credentialId))
        .unique();
      if (
        !row ||
        row.revoked ||
        row.expiresAt <= Date.now() ||
        row.scope !== 'cli' ||
        (input.credential && row.tokenHash !== input.credential.tokenHash)
      )
        return { status: 'bad-credential' };
      actor = row.owner;
    }
    const id = await resolveProjectId(ctx, input);
    if (!id) return { status: 'not-found', signedIn: !!actor };
    let project;
    try {
      project = await accessibleProject(ctx, id, actor);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'PROJECT_UNAVAILABLE')
        return { status: 'not-found', signedIn: !!actor };
      throw error;
    }
    let mainHead: string | null = null;
    try {
      mainHead = (await hostedStartMain(ctx, id)).head;
    } catch {
      mainHead = null;
    }
    const history = await loadHistory(ctx, id);
    const member = await isMember(ctx, project, actor);
    return {
      status: 'ok',
      projectId: id,
      member,
      // Wants that are stored pack tips are main's commits, never Lane commits.
      lanes:
        member && input.lanes
          ? await laneRefs(ctx, id, {
              ...input.lanes,
              commits: input.lanes.commits.filter(
                commit => !history?.packs.some(pack => pack.tip === commit),
              ),
            })
          : [],
      mainHead,
      history,
      mirror: history ? history.mirror : await mirrorMapping(ctx, id),
      // Daily Worker byte-path use (two indexed reads), checked before a redirect.
      workerUsage: await workerUsage(ctx, id),
    };
  },
});
