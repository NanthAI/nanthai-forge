// SPDX-License-Identifier: Apache-2.0
// Loose ends (Item fc1831eb): what was started and left, in one compact read for the Needs me screen and for agents
// (`nforge agent ROOT lanes '{"view":"loose-ends"}'`). Each of the five groups either lists its rows or says it is not
// reported yet and why, so a reader never takes a missing group for an empty one. Nothing here changes or deletes
// anything: setting a Lane aside goes through the existing dormant sweep (projectHostedDormant:abandon), which re-checks
// each Lane and skips one that gained a save meanwhile.
import { v } from 'convex/values';
import { query } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { dormantCutoff } from './projectHostedDormancy';
import { canonicalPayload } from '../src/hosted-source-operation';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Rows per group; a group with more says how many more were seen (at least one). */
export const LOOSE_ENDS_LIMIT = 25;
/** A Lane with no save, sync or start for this long, but not yet dormant, reads as stopped mid-task. */
export const QUIET_MS = 90 * 60_000;

type Presence = Doc<'projectHostedPresence'>;
const row = (presence: Presence) => ({
  laneId: presence.laneId,
  intentId: presence.intentId,
  title: presence.goal,
  actor: presence.actor,
  agent: presence.agent ?? null,
  paths: presence.pathCount,
  at: presence.at,
});
const listed = (rows: Presence[]) => ({
  reported: true as const,
  rows: rows.slice(0, LOOSE_ENDS_LIMIT).map(row),
  more: rows.length > LOOSE_ENDS_LIMIT,
});
const notReported = (why: string) => ({ reported: false as const, why });

async function presenceBetween(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  after: number | null,
  upTo: number,
) {
  return ctx.db
    .query('projectHostedPresence')
    .withIndex('by_project_and_at', q =>
      after === null
        ? q.eq('projectId', projectId).lte('at', upTo)
        : q.eq('projectId', projectId).gt('at', after).lte('at', upTo),
    )
    .take(LOOSE_ENDS_LIMIT + 1);
}

/** Any member's read. Costs: the project row, then at most two indexed presence ranges of 26 rows each (oldest first).
 * Re-runs only when a Lane in those ranges is written; nothing polls and nothing is scheduled. */
export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read loose ends.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const now = Date.now();
      const cutoff = dormantCutoff(project, now);
      const quietFrom = now - QUIET_MS;
      const [idle, stopped] = await Promise.all([
        cutoff === null ? null : presenceBetween(ctx, projectId, null, cutoff),
        cutoff !== null && cutoff >= quietFrom ? [] : presenceBetween(ctx, projectId, cutoff, quietFrom),
      ]);
      return canonicalPayload({
        at: now,
        // The owner sets Lanes aside through projectHostedDormant:abandon, which needs the current authority epoch.
        setAside: project.owner === user.subject ? { authorityEpoch: sourceAuthority(project).epoch } : null,
        groups: {
          idle: idle
            ? listed(idle)
            : notReported('This project turned dormant Lanes off (agentDefaults.dormantAfterDays 0).'),
          stopped: listed(stopped),
          checked: notReported('A passed check that nobody asked to land is not recorded per Lane yet.'),
          projects: notReported(
            'Projects with no landing for 30 days need an account-wide read; it is not built yet.',
          ),
          dated: notReported('Done-when lines carry no date yet; that needs the planning contract change.'),
        },
      });
    } catch (error) {
      return report(error);
    }
  },
});
