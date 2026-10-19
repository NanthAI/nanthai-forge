// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { PRESENCE } from './presence.js';
import type { WorkActor } from './work-actor-types.js';
import type { ChannelMove, CheckRun, Lane, WorkData, WorkView } from './work-types.js';

const count = z.number().int().nonnegative().safe().optional();
/** Self-reported token counts. Each key appears only when the reporter sent it. */
export const reportedTokensSchema = z
  .object({ input: count, output: count, cacheRead: count, cacheWrite: count, total: count })
  .strict();
export type ReportedTokens = z.infer<typeof reportedTokensSchema>;
export type SelfReport = {
  laneId: string;
  intentId: string;
  name: string;
  sessionId?: string | undefined;
  harness?: string | undefined;
  model?: string | undefined;
  tokens?: ReportedTokens | undefined;
  reportedAt: string;
};
export type PresenceObservation = {
  name: string;
  environment: string;
  status: string;
  lastSeen: number;
  lastActivity: number;
  context: { laneId: string; intentId: string };
};
export type MakingOfInput = {
  intent: WorkData['intents'][number];
  lanes: Lane[];
  views: WorkView[];
  runs: CheckRun[];
  moves: ChannelMove[];
  presence: PresenceObservation[];
  reports: SelfReport[];
};

/** Gaps longer than this between recorded events are idle, matching the presence working window. */
export const ACTIVE_IDLE_MS = PRESENCE.workingMs;
const at = (value: string | undefined) => {
  const ms = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};
const span = (from: string | undefined, to: string | undefined) => {
  const start = at(from),
    end = at(to);
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
};
const terminal = new Set([
  'passed',
  'failed',
  'cancelled',
  'interrupted',
  'runner-unavailable',
  'runner-budget-exhausted',
]);

/** Queue and run time per check run. Missing timestamps leave the matching duration out. */
export function runTiming(run: CheckRun) {
  const ended = terminal.has(run.status) ? run.endedAt : undefined;
  // New runs record queuedAt; startedAt moves forward when the command actually spawns.
  const spawned = run.childPid !== undefined;
  const queuedMs = run.queuedAt ? span(run.queuedAt, spawned ? run.startedAt : ended) : undefined;
  const runningMs = run.queuedAt ? (spawned ? span(run.startedAt, ended) : undefined) : undefined;
  const durationMs = span(run.queuedAt ?? run.startedAt, ended);
  return {
    ...(queuedMs !== undefined ? { queuedMs } : {}),
    ...(runningMs !== undefined ? { runningMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Total length of the union of [start, end] intervals, so parallel runs count once. */
export function unionMs(intervals: [number, number][]) {
  let total = 0,
    cursor = -Infinity;
  for (const [start, end] of intervals.slice().sort((a, b) => a[0] - b[0])) {
    if (end <= cursor) continue;
    total += end - Math.max(start, cursor);
    cursor = end;
  }
  return total;
}

/** Sum of gaps between consecutive recorded events that are no longer than the idle threshold. */
export function activeMs(times: number[], idleMs = ACTIVE_IDLE_MS) {
  const sorted = times.slice().sort((a, b) => a - b);
  let total = 0;
  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index]! - sorted[index - 1]!;
    if (gap <= idleMs) total += gap;
  }
  return total;
}

function sum(rows: object[], key: string) {
  const values = rows
    .map(row => (row as Record<string, unknown>)[key])
    .filter((value): value is number => typeof value === 'number');
  return values.length ? { [key]: values.reduce((a, b) => a + b, 0) } : {};
}

function actorRow(actor: WorkActor | undefined) {
  return actor
    ? { name: actor.name, kind: actor.kind, ...(actor.tool ? { tool: actor.tool } : {}) }
    : undefined;
}

/** Derived, read-only making-of record for one Intent. Absent facts are omitted, never zero-filled. */
export function deriveMakingOf(input: MakingOfInput) {
  const { intent } = input;
  const events: number[] = [];
  const note = (value: string | number | undefined) => {
    const ms = typeof value === 'number' ? value : at(value);
    if (ms !== undefined) events.push(ms);
  };
  note(intent.createdAt);
  for (const entry of intent.lifecycle ?? []) note(entry.at);

  const actors = new Map<
    string,
    { name: string; kind?: string | undefined; harnesses: Set<string>; models: Set<string> }
  >();
  const actor = (name: string, kind?: string, harness?: string, model?: string) => {
    const row = actors.get(name) ?? { name, harnesses: new Set<string>(), models: new Set<string>() };
    row.kind ??= kind;
    if (harness) row.harnesses.add(harness);
    if (model) row.models.add(model);
    actors.set(name, row);
  };
  const seen = (value: WorkActor | undefined) => value && actor(value.name, value.kind, value.tool);
  for (const entry of intent.lifecycle ?? []) seen(entry.actor);

  const lanes = input.lanes.map(lane => {
    seen(lane.startedBy);
    const startedAt = intent.agentStart?.laneId === lane.id ? intent.createdAt : undefined;
    const ended = (lane.lifecycle ?? [])
      .filter(entry => ['completed', 'abandoned'].includes(entry.to))
      .at(-1);
    for (const entry of lane.lifecycle ?? []) {
      note(entry.at);
      seen(entry.actor);
    }
    const saves = lane.checkpoints.map(save => {
      note(save.at);
      seen(save.actor);
      return {
        at: save.at,
        kind: save.sync ? ('sync' as const) : save.undoSync ? ('undo-sync' as const) : ('save' as const),
        message: save.message,
        ...(save.actor ? { actor: actorRow(save.actor) } : {}),
        ...(save.automatic ? { automatic: true } : {}),
      };
    });
    return {
      laneId: lane.id,
      name: lane.name,
      state: lane.state,
      ...(startedAt ? { startedAt } : {}),
      ...(lane.startedBy ? { startedBy: actorRow(lane.startedBy) } : {}),
      ...(lane.setup?.machine ? { machine: lane.setup.machine } : {}),
      ...(ended && lane.state === ended.to ? { endedAt: ended.at } : {}),
      saves,
    };
  });

  for (const view of input.views) note(view.at);
  const waiting: [number, number][] = [],
    timings: { finished: boolean; queuedMs?: number; runningMs?: number; durationMs?: number }[] = [];
  const runs = input.runs
    .slice()
    .sort((a, b) => (a.queuedAt ?? a.startedAt).localeCompare(b.queuedAt ?? b.startedAt))
    .map(run => {
      note(run.queuedAt);
      note(run.startedAt);
      note(run.endedAt);
      const timing = runTiming(run),
        start = at(run.queuedAt ?? run.startedAt),
        end = terminal.has(run.status) ? at(run.endedAt) : undefined;
      if (start !== undefined && end !== undefined && end >= start) waiting.push([start, end]);
      timings.push({ finished: terminal.has(run.status), ...timing });
      return {
        runId: run.id,
        viewId: run.viewId,
        check: run.check.name,
        status: run.status,
        ...(run.checkSelection ? { scope: run.checkSelection.scope } : {}),
        ...(run.mainCheck ? { mainCheck: true } : {}),
        ...(run.queuedAt ? { queuedAt: run.queuedAt } : {}),
        startedAt: run.startedAt,
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        ...timing,
      };
    });

  const landings = input.moves
    .filter(move => move.status === 'accepted')
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(move => {
      note(move.at);
      seen(move.acceptedBy);
      return {
        channel: move.channel,
        viewId: move.viewId,
        head: move.head,
        at: move.at,
        ...(move.acceptedBy ? { acceptedBy: actorRow(move.acceptedBy) } : {}),
        ...(move.automatic ? { automatic: true } : {}),
        ...(move.fastPath ? { fastPath: true } : {}),
      };
    });

  const sessions = input.presence
    .slice()
    .sort((a, b) => a.lastActivity - b.lastActivity)
    .map(session => {
      note(session.lastActivity);
      actor(session.name);
      return {
        name: session.name,
        laneId: session.context.laneId,
        environment: session.environment,
        status: session.status,
        lastActivityAt: new Date(session.lastActivity).toISOString(),
        lastSeenAt: new Date(session.lastSeen).toISOString(),
      };
    });

  const reports = input.reports
    .slice()
    .sort((a, b) => a.reportedAt.localeCompare(b.reportedAt))
    .map(report => {
      actor(report.name, undefined, report.harness, report.model);
      return report;
    });
  const tokenRows = reports.flatMap(report => (report.tokens ? [report.tokens] : []));
  const tokens = Object.assign(
    {},
    ...(['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const).map(key => sum(tokenRows, key)),
  );

  const finished = timings.filter(timing => timing.finished);
  const checkTotals = {
    ...sum(timings, 'queuedMs'),
    ...sum(timings, 'runningMs'),
    ...sum(finished, 'durationMs'),
    ...(waiting.length ? { waitingMs: unionMs(waiting) } : {}),
  };
  const first = events.length ? Math.min(...events) : undefined,
    last = events.length ? Math.max(...events) : undefined;

  return {
    intentId: intent.id,
    outcome: intent.outcome,
    status: intent.status,
    createdAt: intent.createdAt,
    ...(first !== undefined && last !== undefined && events.length > 1
      ? {
          firstEventAt: new Date(first).toISOString(),
          lastEventAt: new Date(last).toISOString(),
          wallClockMs: last - first,
        }
      : {}),
    ...(events.length > 1
      ? { activeTime: { ms: activeMs(events), idleThresholdMs: ACTIVE_IDLE_MS, events: events.length } }
      : {}),
    ...(runs.length ? { checks: { runs: runs.length, finished: finished.length, ...checkTotals } } : {}),
    actors: [...actors.values()].map(row => ({
      name: row.name,
      ...(row.kind ? { kind: row.kind } : {}),
      ...(row.harnesses.size ? { harness: [...row.harnesses] } : {}),
      ...(row.models.size ? { model: [...row.models] } : {}),
    })),
    ...(Object.keys(tokens).length ? { tokens: { ...tokens, reports: tokenRows.length } } : {}),
    lanes,
    runs,
    landings,
    ...(sessions.length ? { sessions } : {}),
    ...(reports.length ? { reports } : {}),
    ...(intent.lifecycle?.length
      ? {
          lifecycle: intent.lifecycle.map(entry => ({
            from: entry.from,
            to: entry.to,
            at: entry.at,
            ...(entry.reason ? { reason: entry.reason } : {}),
            ...(entry.actor ? { actor: actorRow(entry.actor) } : {}),
          })),
        }
      : {}),
  };
}
