// SPDX-License-Identifier: Apache-2.0
// Who is working on the plan now (Item d3357f40): the open Lanes with activity in the last 48 hours on the Intents the
// Plan asks about (its in-progress Items and their first two follow-up Intents), for the Owner column when an Item has
// no owner. One call: per asked Intent one indexed range on the slim presence rows (projectHostedPresence
// by_project_and_intent_and_at, at most LANES_PER_INTENT rows of about 1 KB: Intent, actor, agent slug, goal, at most
// 10 paths), at most PLAN_WORK_INTENTS Intents. Asking by Intent means a busy project's other Lanes never push an
// Item's own Lane out of the answer. A closed or superseded Lane has no row; no Lane body, overlap row or per-row call
// is made. The web calls it once per page open, again only when the asked Intents change or a hidden tab is shown
// again, never subscribed, so an idle or hidden tab costs nothing. Presence is for members with write access only, as
// for the overlap read: anyone else gets `withheld`, which the page shows as nothing, never as "no one yet". `actor` is mapped at the public identity boundary
// (convex/publicPeople.ts) to `handle/slug` or a handle; only the Intent, that actor and the time leave the server.
import { v } from 'convex/values';
import { query } from './cliServer';
import { activeProject } from './projectAuthority';
import { dormantCutoff } from './projectHostedDormancy';
import { canonicalPayload } from '../src/hosted-source-operation';
import { agentActor } from '../src/agent-slug';
import { invariant } from '../src/errors';
import { report } from './errors';

/** "Working on it now": a Lane record write (start, save, sync, landing) within this window. Presence rows refresh
 * their time at most every 10 minutes, so a Lane can read up to 10 minutes older than it is. */
const ACTIVE_LANE_MS = 48 * 3_600_000;
/** Intents one call may ask about (web/src/app/plan/workers.ts asks at most this many). */
export const PLAN_WORK_INTENTS = 150;
/** Lanes read per Intent, newest first: the first is named and the rest counted ("+N"). */
const LANES_PER_INTENT = 6;
// Any case: planning keeps an id's case as given (src/planning-id.ts), and so does presence.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const read = query({
  args: { projectId: v.id('hostedProjects'), intentIds: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, { projectId, intentIds }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const asked = [...new Set(intentIds)];
      invariant(
        asked.length <= PLAN_WORK_INTENTS && asked.every(id => uuid.test(id)),
        'BAD_ARGUMENT',
        `intentIds: at most ${PLAN_WORK_INTENTS} full Intent ids.`,
      );
      const project = await activeProject(ctx, projectId, user.subject).catch(() => null);
      if (!project) return canonicalPayload({ lanes: [], withheld: true });
      if (!asked.length) return canonicalPayload({ lanes: [] });
      const now = Date.now();
      // A project whose Lanes go dormant sooner keeps its own, later cutoff: dormant Lanes are never read.
      const cutoff = Math.max(now - ACTIVE_LANE_MS, dormantCutoff(project, now) ?? -Infinity);
      const ranges = await Promise.all(
        asked.map(intentId =>
          ctx.db
            .query('projectHostedPresence')
            .withIndex('by_project_and_intent_and_at', q =>
              q.eq('projectId', projectId).eq('intentId', intentId).gt('at', cutoff),
            )
            .order('desc')
            .take(LANES_PER_INTENT),
        ),
      );
      const lanes = ranges.flat().map(row => ({
        intentId: row.intentId,
        actor: agentActor(row.actor, row.agent),
        at: row.at,
      }));
      return canonicalPayload({ lanes });
    } catch (error) {
      return report(error);
    }
  },
});
