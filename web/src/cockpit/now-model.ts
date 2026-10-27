// SPDX-License-Identifier: Apache-2.0
import { flattenSessions, isPersonSession, type Session } from '../coordination-view';
import { sessionTreeRows } from './session-tree';
import type { CockpitLane } from './model';

/** An accepted move as both local Work and the hosted index record it. */
export type MoveRecord = {
  id: string;
  channel: string;
  viewId: string;
  at: string;
  status?: string;
  acceptedBy?: { name: string; kind?: string };
  acceptanceId?: string;
  actor?: string;
  actorDisplayName?: string;
  actorFormerMember?: boolean;
  automatic?: { summary: string; undo: string };
};
/** A hosted selection of an imported acceptance is one landing, not two ledger entries. */
export function publishedMoves(
  local: readonly MoveRecord[],
  hosted: readonly MoveRecord[],
  initialChannelId?: string,
): MoveRecord[] {
  const native = new Set(local.map(move => move.id));
  return [...local, ...hosted.filter(move => !move.acceptanceId || !native.has(move.acceptanceId))].filter(
    move => !initialChannelId || (move.id !== initialChannelId && move.acceptanceId !== initialChannelId),
  );
}
type ViewRecord = {
  id: string;
  head?: string;
  intentId?: string;
  inputs?: readonly { laneId: string }[];
  dependencies?: readonly { kind: string; viewId?: string; head: string }[];
  changes?: { files: number; add?: number; del?: number };
};
type RunRecord = {
  viewId: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  checkName?: string;
};

/** One row of the "Accepted today" ledger. */
export type AcceptedRow = {
  id: string;
  title: string;
  at: string;
  laneId?: string;
  viewId: string;
  intentId?: string;
  intentTitle?: string;
  by?: string;
  automatic?: { summary: string; undo: string };
  /** The accepter was an agent rather than a person, when recorded. */
  byAgent?: boolean;
  /** How long the check that let it in took, in milliseconds. */
  checkMs?: number;
  /** The name of the check that let it in. */
  checkName?: string;
  /** How many Lanes the accepted View carried. */
  laneCount?: number;
  /** Line counts of the accepted View, when the index recorded them. */
  diff?: { add: number; del: number };
};

/** Local midnight for "today". */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Accepted moves into main since a time, newest first, named by the Lanes they carried. */
export function acceptedSince(
  input: {
    moves: readonly MoveRecord[];
    views: readonly ViewRecord[];
    runs: readonly RunRecord[];
    lanes: readonly { id: string; name: string }[];
    intents?: readonly { id: string; outcome: string }[];
    viewer?: string;
  },
  since: number,
  channel = 'main',
): AcceptedRow[] {
  const views = new Map(input.views.map(view => [view.id, view]));
  const laneName = new Map(input.lanes.map(lane => [lane.id, lane.name]));
  const outcome = new Map((input.intents ?? []).map(intent => [intent.id, intent.outcome]));
  return input.moves
    .filter(
      move =>
        move.channel === channel &&
        (move.status === undefined || move.status === 'accepted') &&
        Date.parse(move.at) >= since,
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(move => {
      const view = views.get(move.viewId);
      const included: ViewRecord[] = [];
      const pending = view ? [view] : [];
      const seen = new Set<string>();
      while (pending.length) {
        const current = pending.pop()!;
        if (seen.has(current.id)) continue;
        seen.add(current.id);
        included.push(current);
        for (const pin of current.dependencies ?? []) {
          const dependency = pin.kind === 'view' && pin.viewId ? views.get(pin.viewId) : undefined;
          if (dependency?.head === pin.head) pending.push(dependency);
        }
      }
      const laneIds = [...new Set(included.flatMap(view => (view.inputs ?? []).map(input => input.laneId)))];
      const names = laneIds.map(id => laneName.get(id)).filter((name): name is string => Boolean(name));
      const title = names.join(' + ') || (view?.intentId && outcome.get(view.intentId)) || 'Accepted change';
      const run = input.runs
        .filter(
          item => item.viewId === move.viewId && item.status === 'passed' && item.startedAt && item.endedAt,
        )
        .at(-1);
      const by =
        move.actor && input.viewer && move.actor === input.viewer
          ? 'you'
          : (move.acceptedBy?.name ?? move.actorDisplayName);
      return {
        id: move.id,
        title,
        at: move.at,
        viewId: move.viewId,
        ...(view?.intentId ? { intentId: view.intentId, intentTitle: outcome.get(view.intentId) } : {}),
        ...(laneIds[0] ? { laneId: laneIds[0] } : {}),
        ...(by ? { by: move.actorFormerMember ? `${by} · former member` : by } : {}),
        ...(move.automatic ? { automatic: move.automatic } : {}),
        ...(move.acceptedBy?.kind ? { byAgent: move.acceptedBy.kind === 'agent' } : {}),
        ...(run ? { checkMs: Date.parse(run.endedAt!) - Date.parse(run.startedAt!) } : {}),
        ...(run?.checkName?.trim() ? { checkName: run.checkName.trim() } : {}),
        ...(laneIds.length ? { laneCount: laneIds.length } : {}),
        ...(view?.changes?.add !== undefined
          ? { diff: { add: view.changes.add, del: view.changes.del ?? 0 } }
          : {}),
      };
    });
}

/** Group by identity, retaining every acceptance and the latest acceptance's time. */
export function acceptanceGroups(rows: readonly AcceptedRow[]) {
  const groups = new Map<string, AcceptedRow[]>();
  for (const row of [...rows].sort((a, b) => b.at.localeCompare(a.at))) {
    const key = row.intentId ? `intent:${row.intentId}` : `move:${row.id}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()].map(([id, acceptances]) => ({
    id,
    latest: acceptances[0]!,
    title: acceptances[0]!.intentTitle ?? acceptances[0]!.title,
    acceptances,
  }));
}

/** "1 m 50 s", "42 s", "6 m". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60),
    rest = seconds % 60;
  return rest && minutes < 10 ? `${minutes} m ${rest} s` : `${minutes} m`;
}

export type AwayFact = {
  id: string;
  glyph: 'passed' | 'channel' | 'waiting';
  text: string;
  automatic?: boolean;
  /** How to undo it, when Forge recorded one. */
  undo?: string;
};

/**
 * What happened since the viewer was last here: acceptances (automatic ones marked), updates from
 * main Forge made on its own, and Lanes that stopped for review. At most three facts.
 */
export function awayFacts(
  since: number,
  accepted: readonly AcceptedRow[],
  lanes: readonly CockpitLane[],
  updates: readonly { laneId: string; at: string; files: number; undo?: string }[] = [],
): AwayFact[] {
  const facts: AwayFact[] = [];
  const recent = accepted.filter(row => Date.parse(row.at) >= since);
  const events = [
    ...new Map(lanes.flatMap(lane => lane.queue?.events ?? []).map(event => [event.id, event])).values(),
  ].filter(event => Date.parse(String(event.at)) >= since);
  const landed = events.filter(event => event.id.startsWith('move:'));
  const failed = events.filter(event => event.id.startsWith('run:') && event.tone === 'failed');
  if (landed.length)
    facts.push({
      id: 'queue-landed',
      glyph: 'passed',
      text: `${landed.length} landed from the queue`,
      ...(landed.some(event => event.automatic)
        ? { automatic: true, undo: landed.find(event => event.automatic)?.automatic?.undo }
        : {}),
    });
  if (failed.length)
    facts.push({ id: 'queue-failed', glyph: 'waiting', text: `${failed.length} stopped: check failed` });
  const ordinary = recent.filter(row => !events.some(event => event.id === `move:${row.id}`));
  const auto = ordinary.filter(row => row.automatic);
  const manual = ordinary.length - auto.length;
  if (auto.length)
    facts.push({
      id: 'auto-accepted',
      glyph: 'passed',
      text: `${auto.length} ${auto.length === 1 ? 'Lane' : 'Lanes'} accepted automatically`,
      automatic: true,
      ...(auto.length === 1 ? { undo: auto[0]!.automatic!.undo } : {}),
    });
  if (manual) facts.push({ id: 'accepted', glyph: 'passed', text: `${manual} accepted into main` });
  const synced = updates.filter(update => Date.parse(update.at) >= since);
  if (synced.length) {
    const laneCount = new Set(synced.map(update => update.laneId)).size;
    const files = synced.reduce((sum, update) => sum + update.files, 0);
    facts.push({
      id: 'updated',
      glyph: 'channel',
      text: `${laneCount} ${laneCount === 1 ? 'Lane' : 'Lanes'} updated from main · ${files} ${files === 1 ? 'file' : 'files'}`,
      automatic: true,
      ...(synced.length === 1 && synced[0]!.undo ? { undo: synced[0]!.undo } : {}),
    });
  }
  const stopped = lanes.filter(
    lane => lane.open && lane.tone === 'passed' && lane.lastAt && Date.parse(lane.lastAt) >= since,
  ).length;
  if (stopped)
    facts.push({
      id: 'stopped',
      glyph: 'waiting',
      text: `${stopped} ${stopped === 1 ? 'Lane' : 'Lanes'} stopped for your review`,
    });
  return facts.slice(0, 3);
}

/** Automatic updates from main recorded on local Lane saves. */
export function automaticUpdates(
  lanes: readonly {
    id: string;
    checkpoints?: readonly {
      at: string;
      automatic?: { undo: string };
      sync?: { changedPaths: readonly string[] };
    }[];
  }[],
) {
  return lanes.flatMap(lane =>
    (lane.checkpoints ?? []).flatMap(save =>
      save.automatic && save.sync
        ? [{ laneId: lane.id, at: save.at, files: save.sync.changedPaths.length, undo: save.automatic.undo }]
        : [],
    ),
  );
}

/** "Answered today · n", from the viewer's acknowledgements in the recent feed. */
export function answeredToday(
  events: readonly { command: { kind: string }; actor: string; at: number }[],
  viewer: string | undefined,
  since: number,
) {
  if (!viewer) return undefined;
  const count = events.filter(
    event => event.command.kind === 'ack' && event.actor === viewer && event.at >= since,
  ).length;
  if (!count) return undefined;
  const covered = events.some(event => event.at < since);
  return `Answered today · ${count}${covered ? '' : '+'}`;
}

/** The server's activity tally (H9 counts). */
export type ActivityCounts = {
  activeAgents: number;
  activeSubagents: number;
  activePeople: number;
  activeLanes: number;
  unannouncedActiveLanes: number;
};

/** Who is listed in the people panel, from the same loaded sessions and folding rules. */
export function workingFacts(
  sessions: readonly Session[],
  _counts: ActivityCounts | undefined,
  now: number,
  endedLaneIds: readonly string[] = [],
) {
  const fresh = flattenSessions(sessionTreeRows(sessions, now, false, endedLaneIds).visible);
  const people = fresh.filter(isPersonSession).map(session => session.name);
  return {
    total: fresh.length,
    agents: fresh.filter(session => !isPersonSession(session) && session.kind !== 'subagent').length,
    subagents: fresh.filter(session => session.kind === 'subagent').length,
    people,
    peopleCount: people.length,
  };
}

/** First reads and catch-up while away establish a baseline, never an arrival toast. */
export function acceptanceArrival(
  previous: ReadonlySet<string> | null,
  rows: readonly AcceptedRow[],
  liveSince: number,
  quiet = false,
) {
  return {
    seen: new Set(rows.map(row => row.id)),
    arrival:
      !previous || quiet
        ? undefined
        : rows.find(row => !previous.has(row.id) && Date.parse(row.at) >= liveSince),
  };
}
