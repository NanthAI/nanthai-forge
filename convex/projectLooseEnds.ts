// SPDX-License-Identifier: Apache-2.0
// Loose ends (Item fc1831eb): what was started and left, in one compact read for the Needs me screen and for agents
// (`nforge agent ROOT lanes '{"view":"loose-ends"}'`). Each of the five groups either lists its rows or says it is not
// reported yet and why, so a reader never takes a missing group for an empty one. Nothing here changes or deletes
// anything: setting a Lane aside goes through the existing dormant sweep (projectHostedDormant:abandon), which re-checks
// each Lane and skips one that gained a save meanwhile.
import { v } from 'convex/values';
import { streamQuery } from 'convex-helpers/server/pagination';
import { query } from './cliServer';
import schema from './schema';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { dormantCutoff } from './projectHostedDormancy';
import { canonicalPayload } from '../src/hosted-source-operation';
import { sourceAuthority } from '../src/hosted-source-authority';
import { ForgeError, invariant } from '../src/errors';
import { LOOSE_ENDS_ACTIVITY_MS, QUIET_MS, withLooseEndsHolders } from '../src/lane-quiet';
import { report } from './errors';
import { hostedRecordBody } from './projectHostedRecords';

import { looseEndIntentCursor } from '../src/hosted-lifecycle';
import { readLooseEndIntents } from './projectLooseEndIntents';
import { datedChecks, inactiveProjects, looseEndsPosition } from './projectLooseEndsDetails';

/** The Lane a resolution Lane continues, from its record; nothing for any other Lane or an unreadable record. */
const resolutionOrigin = (value: string): string | undefined => {
  try {
    const origin = (JSON.parse(value) as { resolution?: { origin?: { laneId?: unknown } } }).resolution
      ?.origin?.laneId;
    return typeof origin === 'string' ? origin : undefined;
  } catch {
    return undefined;
  }
};

/** Rows per group. */
const LOOSE_ENDS_LIMIT = 25;
const stoppedCursorPrefix = 'forge-loose-ends-stopped-v1:';
const idleCursorPrefix = 'forge-loose-ends-idle-v1:';
const badCursor = () =>
  new ForgeError('BAD_ARGUMENT', 'Use a Loose ends group’s continueCursor or start a new read.');

type StoppedCursor = {
  projectId: Id<'hostedProjects'>;
  upTo: number;
  after: [at: number, creationTime: number, id: Id<'projectHostedPresence'>];
};

function lanePosition(
  projectId: Id<'hostedProjects'>,
  token: string,
): StoppedCursor & { group: 'idle' | 'stopped' } {
  const prefix = token.startsWith(idleCursorPrefix) ? idleCursorPrefix : stoppedCursorPrefix;
  if (!token.startsWith(prefix)) throw badCursor();
  let position: StoppedCursor | null;
  try {
    position = JSON.parse(token.slice(prefix.length));
  } catch {
    throw badCursor();
  }
  if (
    position?.projectId !== projectId ||
    !Number.isFinite(position.upTo) ||
    !Array.isArray(position.after) ||
    position.after.length !== 3 ||
    !Number.isFinite(position.after[0]) ||
    position.after[0] > position.upTo ||
    !Number.isFinite(position.after[1]) ||
    typeof position.after[2] !== 'string'
  )
    throw badCursor();
  return { ...position, group: prefix === idleCursorPrefix ? 'idle' : 'stopped' };
}

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

/** A quiet Lane is replaced when its Item has another open Lane that is not quiet, or when a listed quiet Lane of the
 * same Item is its resolution Lane (the same rule as the Lanes yard, web/src/app/lanes/model.ts `replacedBy`). One
 * indexed read of at most SIBLINGS_PER_ITEM Lane heads per Item among the listed rows, and, only for an Item with
 * several open Lanes and several listed quiet Lanes, one Lane-record point read per listed quiet Lane (its
 * `resolution.origin`, through the head already read); otherwise an Item
 * whose Lanes are all quiet names no replacement. */
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
      const mine = quiet.filter(presence => presence.intentId === intentId);
      // A quiet resolution Lane replaces the quiet Lane it resolves (real case: Item 1dd4e095).
      // The origin is on the Lane record the head points at (about 1 KB, fixed at the resolve), not on the overlap row,
      // whose `changes` grow with the Lane's edits (Item 77d2e8bc).
      if (heads.length > 1 && mine.length > 1)
        for (const presence of mine) {
          const head = heads.find(candidate => candidate.key === presence.laneId);
          const record = head ? await ctx.db.get(head.recordId) : null;
          const origin = record ? resolutionOrigin(await hostedRecordBody(ctx, record)) : undefined;
          if (origin && origin !== presence.laneId && mine.some(other => other.laneId === origin))
            out.set(origin, presence.laneId);
        }
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
      for (const presence of mine) if (!out.has(presence.laneId)) out.set(presence.laneId, live);
    }),
  );
  return out;
}
const notReported = (why: string) => ({ reported: false as const, why });

function presenceBetween(ctx: QueryCtx, projectId: Id<'hostedProjects'>, after: number | null, upTo: number) {
  return ctx.db
    .query('projectHostedPresence')
    .withIndex('by_project_and_at', q =>
      after === null
        ? q.eq('projectId', projectId).lte('at', upTo)
        : q.eq('projectId', projectId).gt('at', after).lte('at', upTo),
    )
    .take(LOOSE_ENDS_LIMIT + 1);
}

/** Resume strictly after an index key, even if the Lane at that key was removed or saved meanwhile. */
async function continueLanes(ctx: QueryCtx, { projectId, upTo, after }: StoppedCursor) {
  const rows: Presence[] = [];
  for await (const [presence] of streamQuery(ctx, {
    table: 'projectHostedPresence',
    index: 'by_project_and_at',
    schema,
    startIndexKey: [projectId, ...after],
    endIndexKey: [projectId, upTo],
  })) {
    rows.push(presence);
    if (rows.length > LOOSE_ENDS_LIMIT) break;
  }
  return rows;
}

/** Read only displayed candidates. The lookahead is used for the cursor and replacement evidence. */
async function currentHolders(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  candidates: Presence[],
  now: number,
) {
  const holders = new Map<string, string>();
  await Promise.all(
    candidates.map(async ({ laneId, at }) => {
      if (at >= now - LOOSE_ENDS_ACTIVITY_MS) {
        holders.set(laneId, 'Recent activity');
        return;
      }
      const mark = await ctx.db
        .query('projectLiveLineLanes')
        .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
        .unique();
      if (mark?.stage === 'queued' || mark?.stage === 'checking' || mark?.stage === 'ready')
        holders.set(laneId, 'Landing queue');
    }),
  );
  return holders;
}

/** Any member's read. Costs: the project row, then at most two indexed presence ranges of 26 rows each (oldest first),
 * or one stopped page over at most three disjoint index ranges (26 rows total) for a continuation,
 * one indexed live-line mark lookup per displayed candidate (at most 25 per group),
 * and per distinct Item among them one Lane-head read of at most 6 rows, a Lane-record point read per listed quiet
 * Lane of an Item with several open Lanes and several listed quiet Lanes (at most 52, about 1 KB each), plus a presence point read per other Lane until a live one is
 * found. Re-runs only when a Lane in those ranges, or
 * an open Lane of their Items, is written; nothing polls and nothing is scheduled. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.optional(v.string()),
    details: v.optional(v.literal(true)),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor, details }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read loose ends.');
      const now = Date.now();
      if (cursor?.startsWith(looseEndIntentCursor))
        return canonicalPayload(await readLooseEndIntents(ctx, projectId, user.subject, cursor, now));
      const project = await accessibleProject(ctx, projectId, user.subject);
      const extraPosition = looseEndsPosition(cursor, now);
      if (extraPosition) {
        const groups =
          extraPosition.group === 'projects'
            ? { projects: await inactiveProjects(ctx, project, user.subject, now, extraPosition) }
            : { dated: await datedChecks(ctx, project, user.subject, now, extraPosition) };
        return canonicalPayload({ at: now, groups });
      }
      const quietFrom = now - QUIET_MS;
      const position = cursor === undefined ? null : lanePosition(projectId, cursor);
      const cutoff = position ? null : dormantCutoff(project, now);
      const [idle, stopped, extra] = await Promise.all([
        position?.group === 'idle'
          ? continueLanes(ctx, position)
          : cutoff === null
            ? null
            : presenceBetween(ctx, projectId, null, cutoff),
        position?.group === 'stopped'
          ? continueLanes(ctx, position)
          : position?.group === 'idle' || (cutoff !== null && cutoff >= quietFrom)
            ? []
            : presenceBetween(ctx, projectId, cutoff, quietFrom),
        details && !position
          ? Promise.all([
              inactiveProjects(ctx, project, user.subject, now),
              datedChecks(ctx, project, user.subject, now),
            ])
          : null,
      ]);
      const quiet = [...(idle ?? []), ...stopped];
      const [replacedBy, holders] = await Promise.all([
        quiet.length ? replacements(ctx, projectId, quiet, quietFrom) : new Map<string, string>(),
        currentHolders(
          ctx,
          projectId,
          [...(idle ?? []).slice(0, LOOSE_ENDS_LIMIT), ...stopped.slice(0, LOOSE_ENDS_LIMIT)],
          now,
        ),
      ]);
      const group = (rows: Presence[], kind: 'idle' | 'stopped', upTo: number) => {
        const boundary = rows.length > LOOSE_ENDS_LIMIT ? rows[LOOSE_ENDS_LIMIT - 1] : undefined;
        const prefix = kind === 'idle' ? idleCursorPrefix : stoppedCursorPrefix;
        const value = listed(rows, replacedBy);
        const reason = kind === 'idle' ? 'Past the project’s dormant cutoff' : 'Quiet for 90 minutes';
        return {
          ...value,
          ...(details || position?.group === 'idle'
            ? { rows: value.rows.map(row => ({ ...row, reason })) }
            : {}),
          continueCursor: boundary
            ? prefix +
              canonicalPayload({
                projectId,
                upTo,
                after: [boundary.at, boundary._creationTime, boundary._id],
              })
            : null,
        };
      };
      const stoppedGroup = group(stopped, 'stopped', position?.upTo ?? quietFrom);
      const idleGroup = idle ? group(idle, 'idle', position?.upTo ?? cutoff!) : null;
      return canonicalPayload({
        at: now,
        // The owner sets Lanes aside through projectHostedDormant:abandon, which needs the current authority epoch.
        setAside: project.owner === user.subject ? { authorityEpoch: sourceAuthority(project).epoch } : null,
        groups: withLooseEndsHolders(
          position
            ? position.group === 'idle'
              ? { idle: idleGroup, stopped: stoppedGroup }
              : { stopped: stoppedGroup }
            : {
                idle: idleGroup
                  ? details
                    ? idleGroup
                    : listed(idle!, replacedBy)
                  : notReported('This project turned dormant Lanes off (agentDefaults.dormantAfterDays 0).'),
                stopped: stoppedGroup,
                checked: notReported(
                  'A passed check that nobody asked to land is not recorded per Lane yet.',
                ),
                projects:
                  extra?.[0] ??
                  notReported(
                    'Projects with no landing for 30 days need an account-wide read; it is not built yet.',
                  ),
                dated:
                  extra?.[1] ??
                  notReported('Done-when lines carry no date yet; that needs the planning contract change.'),
              },
          holders,
        ),
      });
    } catch (error) {
      return report(error);
    }
  },
});
