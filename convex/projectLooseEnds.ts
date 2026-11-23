// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
import { hostedRecordBody, recordHead } from './projectHostedRecords';

import { looseEndIntentCursor } from '../src/hosted-lifecycle';
import { readLooseEndIntents } from './projectLooseEndIntents';
import { checkedKind } from './projectLooseEndStamp';
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
/** Checked, never landed rows on the details read's first page. Each costs a presence row and a landing-queue lookup,
 * so the first page stays within the page budget (Item b294a5d8); Show 25 more reads the rest, 25 a page. */
const CHECKED_FIRST_PAGE = 3;
const stoppedCursorPrefix = 'forge-loose-ends-stopped-v1:';
const idleCursorPrefix = 'forge-loose-ends-idle-v1:';
const checkedCursorPrefix = 'forge-loose-ends-checked-v1:';
const badCursor = () =>
  new ForgeError('BAD_ARGUMENT', 'Use a Loose ends group’s continueCursor or start a new read.');

type StoppedCursor = {
  projectId: Id<'hostedProjects'>;
  upTo: number;
  after: [at: number, creationTime: number, id: Id<'projectHostedPresence'>];
};
type CheckedCursor = {
  projectId: Id<'hostedProjects'>;
  upTo: number;
  after: [passedAt: number, laneId: string, creationTime: number, id: Id<'projectFinishReadRows'>];
};

function lanePosition(
  projectId: Id<'hostedProjects'>,
  token: string,
): (StoppedCursor & { group: 'idle' | 'stopped' }) | (CheckedCursor & { group: 'checked' }) {
  const prefix = token.startsWith(idleCursorPrefix)
    ? idleCursorPrefix
    : token.startsWith(checkedCursorPrefix)
      ? checkedCursorPrefix
      : stoppedCursorPrefix;
  if (!token.startsWith(prefix)) throw badCursor();
  let position: StoppedCursor | null;
  try {
    position = JSON.parse(token.slice(prefix.length));
  } catch {
    throw badCursor();
  }
  // A Lane cursor ends in the presence index key [at, creationTime, id]; Checked ends in the marker index key
  // [passedAt, laneId, creationTime, id].
  const tail = position?.after as unknown[] | undefined;
  const marker = prefix === checkedCursorPrefix;
  if (
    position?.projectId !== projectId ||
    !Number.isFinite(position.upTo) ||
    !Array.isArray(tail) ||
    tail.length !== (marker ? 4 : 3) ||
    !Number.isFinite(tail[0]) ||
    (tail[0] as number) > position.upTo ||
    (marker
      ? typeof tail[1] !== 'string' || !Number.isFinite(tail[2]) || typeof tail[3] !== 'string'
      : !Number.isFinite(tail[1]) || typeof tail[2] !== 'string')
  )
    throw badCursor();
  if (marker) return { ...(position as unknown as CheckedCursor), group: 'checked' };
  return { ...(position as StoppedCursor), group: prefix === idleCursorPrefix ? 'idle' : 'stopped' };
}

/** Open Lanes read per Item to find the one that replaced a quiet Lane (Item d9e1ac62). */
const SIBLINGS_PER_ITEM = 6;

type Presence = Doc<'projectHostedPresence'>;
/** A Lane started by an id (a bare UUID or digest) has no title of its own; its Item's title stands in for it. */
const BARE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,64})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The Item title for each listed Lane whose goal is a bare id: one Item-head point read per distinct id among such Lanes (none
 * when every goal is a real title), the goal id first and the Lane's own Intent (an Item's first) next. */
async function itemTitles(ctx: QueryCtx, projectId: Id<'hostedProjects'>, rows: readonly Presence[]) {
  const titles = new Map<string, string>();
  // One read per distinct id, however many Lanes share it. An Intent that continues an Item (a follow-up) is not the
  // Item's key: its Lane keeps the short Lane mark the screen words, as before.
  const looked = new Map<string, Promise<string | null>>();
  const titleOf = (id: string) => {
    let found = looked.get(id);
    if (!found)
      looked.set(
        id,
        (found = recordHead(ctx, projectId, 'issue', id).then(head => {
          const title = head?.value ? (JSON.parse(head.value) as { title?: unknown }).title : null;
          return typeof title === 'string' && title.trim() ? title : null;
        })),
      );
    return found;
  };
  await Promise.all(
    rows
      .filter(presence => BARE_ID.test(presence.goal.trim()))
      .map(async presence => {
        const goal = presence.goal.trim();
        for (const id of new Set([...(UUID.test(goal) ? [goal] : []), presence.intentId])) {
          const title = await titleOf(id);
          if (title) return void titles.set(presence.laneId, title);
        }
      }),
  );
  return titles;
}
const row = (
  presence: Presence,
  replacedBy: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
) => {
  const by = replacedBy.get(presence.laneId);
  return {
    laneId: presence.laneId,
    intentId: presence.intentId,
    title: titles.get(presence.laneId) ?? presence.goal,
    actor: presence.actor,
    agent: presence.agent ?? null,
    paths: presence.pathCount,
    at: presence.at,
    // Stored on the presence row by the writes that already happen (Item fc1831eb); absent means "not recorded".
    ...(presence.saves === undefined ? {} : { saves: presence.saves }),
    ...(presence.landedBefore ? { landedBefore: true as const } : {}),
    ...(presence.passedAt === undefined ? {} : { passedAt: presence.passedAt }),
    // Another open Lane of the same Item is still live: this one was left behind. Its agent abandons it.
    ...(by
      ? {
          replacedBy: by,
          next: `nforge agent ROOT abandon ${JSON.stringify({ laneId: presence.laneId, reason: `Replaced by Lane ${by}` })}`,
        }
      : {}),
  };
};
const listed = (
  rows: Presence[],
  replacedBy: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
  size = LOOSE_ENDS_LIMIT,
) => ({
  reported: true as const,
  rows: rows.slice(0, size).map(presence => row(presence, replacedBy, titles)),
  more: rows.length > size,
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

type Marker = Doc<'projectFinishReadRows'>;

/** Lanes an unrequested check passed on, oldest pass first, that passed at least a quiet period ago: the stamp's marker
 * rows (convex/projectLooseEndStamp.ts), one indexed range. A save, a landing or a close deletes the marker with the
 * stamp, and each marker is checked against its Lane's presence row below, so a stale one is never listed. */
function checkedMarkers(ctx: QueryCtx, projectId: Id<'hostedProjects'>, upTo: number) {
  return ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_source_time', q =>
      q.eq('kind', checkedKind).eq('projectId', projectId).lte('sourceCreatedAt', upTo),
    )
    .take(CHECKED_FIRST_PAGE + 1);
}

/** The markers after the cursor's key, strictly, even if the Lane at that key was saved or landed meanwhile. */
async function continueMarkers(ctx: QueryCtx, { projectId, upTo, after }: CheckedCursor) {
  const markers: Marker[] = [];
  for await (const [marker] of streamQuery(ctx, {
    table: 'projectFinishReadRows',
    index: 'by_kind_and_project_and_source_time',
    schema,
    startIndexKey: [checkedKind, projectId, ...after],
    endIndexKey: [checkedKind, projectId, upTo],
  })) {
    markers.push(marker);
    if (markers.length > LOOSE_ENDS_LIMIT) break;
  }
  return markers;
}

/** The presence rows of the first `size` markers (one indexed point read each), those still carrying that exact stamp. */
async function stampedLanes(ctx: QueryCtx, projectId: Id<'hostedProjects'>, markers: Marker[], size: number) {
  const rows = await Promise.all(
    markers.slice(0, size).map(async marker => {
      const presence = await ctx.db
        .query('projectHostedPresence')
        .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', marker.sourceId))
        .unique();
      return presence?.passedAt === marker.sourceCreatedAt ? presence : null;
    }),
  );
  return rows.filter((presence): presence is Presence => presence !== null);
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
      const [idle, stopped, markers, extra] = await Promise.all([
        position?.group === 'idle'
          ? continueLanes(ctx, position)
          : cutoff === null
            ? null
            : presenceBetween(ctx, projectId, null, cutoff),
        position?.group === 'stopped'
          ? continueLanes(ctx, position)
          : position?.group === 'idle' ||
              position?.group === 'checked' ||
              (cutoff !== null && cutoff >= quietFrom)
            ? []
            : presenceBetween(ctx, projectId, cutoff, quietFrom),
        // Checked, never landed (Item fc1831eb): only the details read and its own continuation read this range.
        position?.group === 'checked'
          ? continueMarkers(ctx, position)
          : details && !position
            ? checkedMarkers(ctx, projectId, quietFrom)
            : null,
        details && !position
          ? Promise.all([
              inactiveProjects(ctx, project, user.subject, now),
              datedChecks(ctx, project, user.subject, now),
            ])
          : null,
      ]);
      const checkedSize = position ? LOOSE_ENDS_LIMIT : CHECKED_FIRST_PAGE;
      const checked = markers ? await stampedLanes(ctx, projectId, markers, checkedSize) : null;
      const quiet = [...(idle ?? []), ...stopped];
      // A Lane an unrequested check passed on shows once, under Checked, not again as quiet.
      const passedQuiet = (presence: Presence) =>
        presence.passedAt !== undefined && presence.passedAt <= quietFrom;
      // Idle and stopped pages of the details session leave out a Lane Checked lists; the cursor still follows the
      // examined rows, so no row is skipped or shown twice.
      const separate = Boolean(details || position);
      const [titles, replacedBy, holders] = await Promise.all([
        itemTitles(ctx, projectId, [
          ...(idle ?? []).slice(0, LOOSE_ENDS_LIMIT),
          ...stopped.slice(0, LOOSE_ENDS_LIMIT),
          ...(checked ?? []),
        ]),
        quiet.length ? replacements(ctx, projectId, quiet, quietFrom) : new Map<string, string>(),
        currentHolders(
          ctx,
          projectId,
          [
            // A Lane Checked lists is held (or not) on that group; it is not looked up a second time as quiet.
            ...(idle ?? []).slice(0, LOOSE_ENDS_LIMIT).filter(row => !separate || !passedQuiet(row)),
            ...stopped.slice(0, LOOSE_ENDS_LIMIT).filter(row => !separate || !passedQuiet(row)),
            ...(checked ?? []),
          ],
          now,
        ),
      ]);
      const group = (rows: Presence[], kind: 'idle' | 'stopped', upTo: number) => {
        const boundary = rows.length > LOOSE_ENDS_LIMIT ? rows[LOOSE_ENDS_LIMIT - 1] : undefined;
        const prefix = kind === 'idle' ? idleCursorPrefix : stoppedCursorPrefix;
        // The lookahead row is never shown: slice to the examined page first, then leave out what Checked lists.
        const examined = rows.slice(0, LOOSE_ENDS_LIMIT);
        const shown = separate ? examined.filter(row => !passedQuiet(row)) : examined;
        const value = listed(shown, replacedBy, titles);
        const reason = kind === 'idle' ? 'Past the project’s dormant cutoff' : 'Quiet for 90 minutes';
        return {
          ...value,
          more: rows.length > LOOSE_ENDS_LIMIT,
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
      // Checked, never landed: the rows are the presence rows still carrying their marker's stamp; the cursor follows
      // the markers, so a stale marker is skipped without losing the place.
      const checkedGroup = () => {
        const boundary = markers!.length > checkedSize ? markers![checkedSize - 1] : undefined;
        const value = listed(checked!, replacedBy, titles, checkedSize);
        return {
          ...value,
          more: markers!.length > checkedSize,
          rows: value.rows.map(row => ({ ...row, reason: 'An unrequested check passed' })),
          continueCursor: boundary
            ? checkedCursorPrefix +
              canonicalPayload({
                projectId,
                upTo: position?.upTo ?? quietFrom,
                after: [boundary.sourceCreatedAt, boundary.sourceId, boundary._creationTime, boundary._id],
              })
            : null,
        };
      };
      const stoppedGroup = group(stopped, 'stopped', position?.upTo ?? quietFrom);
      const idleGroup = idle ? group(idle, 'idle', position?.upTo ?? cutoff!) : null;
      const checkedRows = markers ? checkedGroup() : null;
      return canonicalPayload({
        at: now,
        // The owner sets Lanes aside through projectHostedDormant:abandon, which needs the current authority epoch.
        setAside: project.owner === user.subject ? { authorityEpoch: sourceAuthority(project).epoch } : null,
        groups: withLooseEndsHolders(
          position
            ? position.group === 'idle'
              ? { idle: idleGroup, stopped: stoppedGroup }
              : position.group === 'checked'
                ? { checked: checkedRows! }
                : { stopped: stoppedGroup }
            : {
                idle: idleGroup
                  ? details
                    ? idleGroup
                    : listed(idle!, replacedBy, titles)
                  : notReported('This project turned dormant Lanes off (agentDefaults.dormantAfterDays 0).'),
                stopped: stoppedGroup,
                checked:
                  checkedRows ??
                  notReported('Checked work that never landed is listed on the Loose ends page.'),
                projects:
                  extra?.[0] ??
                  notReported(
                    'Projects with no landing for 30 days need an account-wide read; it is not built yet.',
                  ),
                dated:
                  extra?.[1] ??
                  notReported('Done-when lines carry no date yet; that needs the planning contract change.'),
                // The compact read names the Intent group so a reader never takes it for empty; the page asks for it.
                intents: notReported(
                  'Open Intents with no linked Item are read on request: nforge agent ROOT lanes {"view":"loose-ends","intents":true}.',
                ),
              },
          holders,
        ),
      });
    } catch (error) {
      return report(error);
    }
  },
});
