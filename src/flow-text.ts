// SPDX-License-Identifier: Apache-2.0
/**
 * The Flow view as text (Item 85f456c1): `nforge agent ROOT flow` draws the same picture as Needs me from the same
 * one line feed (convex/projectLiveLine.ts `read`), so a stop's count here is the top bar's count for that stop.
 * One line per stop with open, held, the longest wait and the held Lanes by id, then the ways back, the checks and
 * the next step. Pure and read-free; elapsed times come from the feed's timestamps and the caller's clock.
 */
import { FLOW_TOOK, flowToday, type FlowDay } from './flow-day.js';

/** A Lane's stage in the feed. */
type FlowStage = 'editing' | 'saved' | 'queued' | 'checking' | 'ready';
/** A stop on the line; 'ready' (its check passed) counts at Checking. */
export type FlowStop = 'editing' | 'saved' | 'queued' | 'checking';
/** The line feed's reply, as this module reads it. */
export type FlowFeed = {
  lanes: readonly {
    laneId: string;
    stage: FlowStage;
    held: boolean;
    overlap: boolean;
    changedAt: number;
    check?: string;
    mainRed?: true;
  }[];
  more: number;
  moreIsLowerBound: boolean;
  main: { head: string; at?: string } | null;
  flow?: FlowDay | { hours: number[][]; took: number[][]; main?: { red: boolean; since: number } };
};

/** The line's stops and the stages each counts (web/src/app/Line.tsx `lineStops`): one vocabulary and one count
 * everywhere. A Lane whose check passed ('ready') counts at Checking, as passed. */
export const flowStops: readonly { stop: FlowStop; word: string; of: readonly FlowStage[] }[] = [
  { stop: 'editing', word: 'Editing', of: ['editing'] },
  { stop: 'saved', word: 'Saved', of: ['saved'] },
  { stop: 'queued', word: 'In queue', of: ['queued'] },
  { stop: 'checking', word: 'Checking', of: ['checking', 'ready'] },
];
/** Held Lanes named per stop; the rest are counted. */
const NAMED = 3;

export function flowDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const short = (laneId: string) => laneId.slice(0, 8);
const clock = (ms: number, day?: number) =>
  `${day !== undefined && ms < day ? `${new Date(ms).toISOString().slice(0, 10)} ` : ''}${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** One stop's figures, as the picture and the text both read them. A Lane held only because main is failing
 * waits on no person, so it is held but not "needs you". */
export function flowStations(feed: FlowFeed, now: number) {
  return flowStops.map(({ stop, word, of }) => {
    const at = feed.lanes.filter(lane => of.includes(lane.stage));
    const held = at.filter(lane => lane.held);
    const checks = new Map<string, number>();
    for (const lane of at) if (lane.check) checks.set(lane.check, (checks.get(lane.check) ?? 0) + 1);
    return {
      stop,
      word,
      open: at.length,
      held: held.length,
      /** Checks that passed and wait to land (stage 'ready'). */
      passed: at.filter(lane => lane.stage === 'ready' && !lane.held).length,
      needsYou: held.filter(lane => !lane.mainRed).length,
      mainRed: held.filter(lane => lane.mainRed).length,
      longestMs: at.length ? Math.max(...at.map(lane => now - lane.changedAt)) : null,
      heldLanes: held.map(lane => ({
        laneId: lane.laneId,
        why: lane.mainRed ? 'main is failing' : lane.overlap ? 'conflict' : 'held',
      })),
      /** Lanes checked together, one size per check, largest first. */
      checks: [...checks.values()].sort((a, b) => b - a),
    };
  });
}

/** The picture as text, plus the same figures as fields. `root` is the agent ROOT for the next-step command. */
export function flowText(feed: FlowFeed, now: number, root = '.') {
  const stations = flowStations(feed, now);
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const today = flowToday(feed.flow, now, dayStart);
  const red = feed.flow?.main?.red === true;
  const open = feed.lanes.length + feed.more;
  const needs = stations.reduce((n, s) => n + s.needsYou, 0);
  const width = Math.max(...flowStops.map(s => s.word.length));
  const lines = [
    `Flow at ${clock(now)}: ${open ? `${plural(open, 'open Lane')}${feed.moreIsLowerBound ? ' or more' : ''}` : 'no open Lane'}, ${needs ? `${needs} need${needs === 1 ? 's' : ''} a person` : 'none needs a person'}.`,
  ];
  for (const s of stations) {
    const parts = [`${s.word.padEnd(width)}  ${String(s.open).padStart(3)}`];
    if (s.checks.length) parts.push(`in ${plural(s.checks.length, 'check')} (${s.checks.join(', ')})`);
    if (s.passed) parts.push(`${s.passed} passed, landing`);
    if (s.held) {
      const named = s.heldLanes
        .slice(0, NAMED)
        .map(lane => `${short(lane.laneId)} (${lane.why})`)
        .join(', ');
      parts.push(`${s.held} held: ${named}${s.held > NAMED ? `, and ${s.held - NAMED} more` : ''}`);
    }
    if (s.longestMs !== null) parts.push(`longest ${flowDuration(s.longestMs)}`);
    lines.push(parts.join('   '));
  }
  if (feed.more)
    lines.push(
      `${' '.repeat(width)}  +${feed.more}${feed.moreIsLowerBound ? ' or more' : ''} open Lanes past the first ${feed.lanes.length}, not by stop`,
    );
  const since = feed.flow?.main ? ` since ${clock(feed.flow.main.since, dayStart)}` : '';
  lines.push(
    `${'main'.padEnd(width)}  ${String(today.landed).padStart(3)}   landed today (UTC), ${today.thisHour} this hour; ${red ? `failing${since}` : feed.flow?.main ? `passing${since}` : 'passing or failing not reported yet'}`,
  );
  lines.push(
    `Ways back: needs fix ${today.fix} today; main failed ${today.reverted + today.fixedOnTop} today (${today.reverted} reverted, ${today.fixedOnTop} fixed on top)${red ? '; main is failing now' : ''}`,
  );
  const checking = stations.find(s => s.stop === 'checking')!;
  lines.push(
    `Checks: ${checking.checks.length ? `${plural(checking.checks.length, 'check')} running (${checking.checks.map(n => plural(n, 'Lane')).join(', ')})` : 'none running'}; landing checks used ${today.ciMinutes.toLocaleString('en-US')} CI min today, ${today.lostMinutes.toLocaleString('en-US')} on checks that did not land`,
  );
  if (today.samples)
    lines.push(
      `Land to main: middle ${flowDuration(today.middle! * 1000)}, 9 in 10 under ${flowDuration(today.nineInTen! * 1000)} (${today.samples >= FLOW_TOOK ? `the last ${today.samples} landings` : plural(today.samples, 'landing')} today)`,
    );
  const person = stations.flatMap(s => s.heldLanes).find(lane => lane.why !== 'main is failing');
  const next = red
    ? `main is failing: Lanes held for it land when it passes again. Read nforge agent ${root} queue '{}' for the order.`
    : person
      ? `nforge agent ${root} status '${JSON.stringify({ laneId: person.laneId })}' says what ${short(person.laneId)} waits on.`
      : open
        ? 'Nothing waits on a person.'
        : 'Nothing is open.';
  lines.push(`Next: ${next}`);
  return {
    text: lines.join('\n'),
    stops: stations.map(({ checks: _checks, ...s }) => s),
    checks: checking.checks,
    today: {
      landed: today.landed,
      thisHour: today.thisHour,
      byHour: today.byHour,
      landToMain: today.samples
        ? { middle: today.middle, nineInTen: today.nineInTen, samples: today.samples }
        : null,
      needsFix: today.fix,
      reverted: today.reverted,
      fixedOnTop: today.fixedOnTop,
      ciMinutes: today.ciMinutes,
      lostMinutes: today.lostMinutes,
    },
    main: { red, since: feed.flow?.main?.since ?? null, head: feed.main?.head ?? null },
    more: feed.more,
    next,
  };
}
