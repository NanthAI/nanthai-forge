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
import { QUIET_MS } from '../src/lane-quiet';
import { report } from './errors';

/** Rows per group; a group with more says how many more were seen (at least one). */
export const LOOSE_ENDS_LIMIT = 25;

/** Open Lanes read per Item to find the one that replaced a quiet Lane (Item d9e1ac62). */
const SIBLINGS_PER_ITEM = 6;

type Presence = Doc<'projectHostedPresence'>;
const row = (presence: Presence, replacedBy: ReadonlyMap<string, string>) => {
  const by = replacedBy.get(presence.laneId);
  return {
    laneId: presence.laneId,
    intentId: presence.intentId,
    title: presence.goal,
    actor: presence.actor,
    agent: presence.agent ?? null,
    paths: presence.pathCount,
    at: presence.at,
    // Another open Lane of the same Item is still live: this one was left behind. Its agent abandons it.
    ...(by
      ? {
          replacedBy: by,
          next: `nforge x ROOT abandon ${JSON.stringify({ laneId: presence.laneId, reason: `Replaced by Lane ${by}` })}`,
        }
      : {}),
  };
};
const listed = (rows: Presence[], replacedBy: ReadonlyMap<string, string>) => ({
  reported: true as const,
  rows: rows.slice(0, LOOSE_ENDS_LIMIT).map(presence => row(presence, replacedBy)),
  more: rows.length > LOOSE_ENDS_LIMIT,
});

/** A quiet Lane is replaced when its Item has another open Lane that is not quiet (the same rule as the Lanes yard,
 * web/src/app/lanes/model.ts `replacedBy`). One indexed read of at most SIBLINGS_PER_ITEM Lane heads per Item among
 * the listed rows; an Item whose Lanes are all quiet names no replacement. */
async function replacements(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  quiet: readonly Presence[],
  quietFrom: number,
) {
  const listedIds = new Set(quiet.map(presence => presence.laneId));
  const items = [...new Set(quiet.map(presence => presence.intentId))];
  const out = new Map<string, string>();
  await Promise.all(
    items.map(async intentId => {
      const heads = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent_and_status', q =>
          q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId).eq('status', 'active'),
        )
        .order('desc')
        .take(SIBLINGS_PER_ITEM);
      // The first other Lane, newest first, whose own presence is not quiet (a Lane past the listed rows may be).
      let live: string | null = null;
      for (const head of heads) {
        if (listedIds.has(head.key)) continue;
        const presence = await ctx.db
          .query('projectHostedPresence')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', head.key))
          .unique();
        if (presence && presence.at > quietFrom) {
          live = head.key;
          break;
        }
      }
      if (!live) return;
      for (const presence of quiet) if (presence.intentId === intentId) out.set(presence.laneId, live);
    }),
  );
  return out;
}
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

/** Any member's read. Costs: the project row, then at most two indexed presence ranges of 26 rows each (oldest first),
 * and per distinct Item among them one Lane-head read of at most 6 rows plus a presence point read per other Lane
 * until a live one is found. Re-runs only when a Lane in those ranges, or
 * an open Lane of their Items, is written; nothing polls and nothing is scheduled. */
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
      const quiet = [...(idle ?? []), ...stopped];
      const replacedBy = quiet.length
        ? await replacements(ctx, projectId, quiet, quietFrom)
        : new Map<string, string>();
      return canonicalPayload({
        at: now,
        // The owner sets Lanes aside through projectHostedDormant:abandon, which needs the current authority epoch.
        setAside: project.owner === user.subject ? { authorityEpoch: sourceAuthority(project).epoch } : null,
        groups: {
          idle: idle
            ? listed(idle, replacedBy)
            : notReported('This project turned dormant Lanes off (agentDefaults.dormantAfterDays 0).'),
          stopped: listed(stopped, replacedBy),
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
