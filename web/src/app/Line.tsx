// SPDX-License-Identifier: Apache-2.0
// The line draws the stops and marks from one feed. The first delivery settles in place. Each stop opens its
// station on Needs me.
// The stops are the Flow picture's (Item 85f456c1): Editing, Saved, In queue, Checking; a Lane whose check passed
// ('ready') counts at Checking, so the line, the picture and Lanes count every stop alike (`lineStops`).
import { hrefFor } from './paths';
import { followLink } from './router';
import {
  firstTryPercent,
  flowVerdict,
  mainStateWords,
  mainToday,
  type FlowDayFeed,
} from '../../../src/flow-day';
import { LineMarks } from './LineMarks';

export type LineStage = 'editing' | 'saved' | 'queued' | 'checking' | 'ready';
/** A stop on the line: the stages it counts. */
export type LineStop = 'editing' | 'saved' | 'queued' | 'checking';
/** The feed's shape (liveLineResult), restated so the frame does not import Convex server code. */
export type LineFeed = {
  lanes: readonly {
    laneId: string;
    stage: LineStage;
    held: boolean;
    overlap: boolean;
    changedAt: number;
    /** Lanes checked together share it while checked (Flow view, Item 85f456c1). */
    check?: string;
    /** Held only because main is failing. */
    mainRed?: true;
    /** Held on its own next step (a failed check, a conflict, a wait): no person is asked. */
    fix?: true;
  }[];
  more: number;
  moreIsLowerBound: boolean;
  main: { head: string; at?: string } | null;
  /** The last Lane that left the line, and how. */
  exit?: { laneId: string; kind: 'landed' | 'set-aside'; at: number } | null;
  /** The Flow view's running day (src/flow-day.ts `FlowDay`); read it with `flowToday`. */
  flow?: FlowDayFeed;
  /** Recorded runs for open Lanes and available room in the check pipeline. */
  checks?: {
    runs: readonly { groups: readonly string[]; lanes: number; at: number; reserved?: true }[];
    free?: number;
    partial?: true;
  };
};

/** The line's stops in order, each with the stages it counts. One list for the top bar, the Flow picture and the
 * Lanes filter (`?stop=`), so every count of a stop is the same count. */
export const lineStops: readonly {
  stage: LineStop;
  label: string;
  short: string;
  of: readonly LineStage[];
}[] = [
  { stage: 'editing', label: 'Editing', short: 'Edit', of: ['editing'] },
  { stage: 'saved', label: 'Saved', short: 'Saved', of: ['saved'] },
  { stage: 'queued', label: 'In queue', short: 'Queue', of: ['queued'] },
  { stage: 'checking', label: 'Checking', short: 'Check', of: ['checking', 'ready'] },
];

/** Count Lanes in the check phase and passed Lanes separately. A recorded run can check several Lanes together. */
export function lineStopCounts(feed: LineFeed | undefined, stop: (typeof lineStops)[number]) {
  let total = 0;
  let held = 0;
  let passed = 0;
  let count = 0;
  for (const lane of feed?.lanes ?? []) {
    if (!stop.of.includes(lane.stage)) continue;
    total++;
    if (lane.held) held++;
    if (lane.stage === 'ready') passed++;
    else if (lane.stage !== 'checking' || !lane.held) count++;
  }
  return { total, held, passed, count };
}

const waitingToLand = 'waiting to land';
export const passedWaiting = (count: number) => `${count.toLocaleString('en')} passed, ${waitingToLand}`;

export function Line({
  feed,
  handle,
  project,
  phone = false,
}: {
  feed: LineFeed | undefined;
  handle: string;
  project: string;
  phone?: boolean;
}) {
  const flowHref = hrefFor({ frame: 'project', handle, project, place: 'needs', section: '', rest: '' });
  const plus = feed?.more ? '+' : '';
  const units = (n: number) => (n === 1 && !plus ? 'Lane' : 'Lanes');
  const scope = plus ? ` (first ${feed?.lanes.length} open Lanes in this project)` : ' in this project';
  return (
    <nav
      className={phone ? 'line phone' : 'line'}
      aria-label="Lane progress in this project"
      aria-busy={feed ? undefined : true}
    >
      {lineStops.map(stop => {
        const { total, count, held, passed } = lineStopCounts(feed, stop);
        const shown = phone ? stop.short : stop.label;
        // The name starts with what the stop shows ("Editing 1"), so speech and voice control match the screen.
        const amount = `${count}${plus} ${units(count)}`;
        const fullStop = shown !== stop.label ? `, ${stop.label.toLowerCase()}` : '';
        const waiting = `${passed}${plus} ${units(passed)} passed, ${waitingToLand}`;
        const words = feed
          ? `${shown} ${amount}${passed ? `, ${waiting}` : ''}${held ? `, ${held}${plus} held` : ''}${scope}${fullStop}`
          : `${shown}, not loaded yet`;
        const label = (
          <span className="lbl" aria-hidden="true">
            {shown}
          </span>
        );
        const number = (
          <span className="line-count" aria-hidden="true">
            <span className="n">
              {count}
              {plus}
            </span>
            <span className="line-unit"> {units(count)}</span>
          </span>
        );
        return (
          <a
            key={stop.stage}
            href={`${flowHref}?open=${stop.stage}`}
            onClick={followLink}
            className={passed ? 'stop checking-split' : feed && !total ? 'stop zero' : 'stop'}
            data-stop={stop.stage}
            aria-label={words}
          >
            {passed ? (
              <>
                <span className="line-checking">
                  {label} {number}
                </span>{' '}
                <span className="line-passed" aria-hidden="true" title={waiting}>
                  {passed}
                  {plus}
                  <span className="line-unit"> {units(passed)}</span> passed
                </span>
              </>
            ) : (
              <>
                {label}
                {feed ? <> {number}</> : null}
              </>
            )}
          </a>
        );
      })}
      <MainStop feed={feed} phone={phone} href={`${flowHref}?open=main`} />
      <LineMarks key={flowHref} feed={feed} stages={lineStops} />
    </nav>
  );
}

/** The main segment (Item 32e8de50): "main · N today · X% first try" from the feed's Flow day; on a phone
 * "main · N · X%". Its name starts with the words it shows, then says them in full. "Today" is the UTC project day
 * at draw time, as on the Flow view: no timer, so a tab left open moves to the new day on its next feed update.
 * Compact widths keep the full name when the visible line drops words. */
function MainStop({ feed, href, phone }: { feed: LineFeed | undefined; href: string; phone: boolean }) {
  const today = feed ? mainToday(feed.flow, Date.now()) : null;
  const pct = today ? firstTryPercent(today) : null;
  const n = today?.landed.toLocaleString('en-US');
  const verdict = flowVerdict(feed?.flow);
  // Red names since when (UTC, as the figure's day), the same words `nforge status` prints (Item 8d21cc9e).
  const since = verdict?.red ? mainStateWords(feed?.flow, Date.now())?.replace(/^main red/, '') : '';
  const state = verdict ? (verdict.red ? `Main failing${since ?? ''}` : 'Main passing') : undefined;
  return (
    <a href={href} onClick={followLink} className="stop tomain" title={state}>
      {/* Two unbreakable groups, so a narrow line wraps it to two rows at most: "main · N today", "· X% first try". */}
      <span className="g">
        <span className="lbl">main</span>
        {today ? (
          <>
            {' · '}
            <span className="main-number">{n}</span>
            {phone ? null : <span className="words"> today</span>}
          </>
        ) : null}
      </span>
      {pct === null ? null : (
        <span className="g share">
          {' · '}
          <span className="main-number">{pct}%</span>
          {phone ? null : <span className="words"> first try</span>}
        </span>
      )}
      <span className="sr">
        {today ? (
          <>
            <span className={phone ? undefined : 'compact-context'}>
              {`, ${n} landing${today.landed === 1 ? '' : 's'} today${pct === null ? '' : `, ${pct}% first try`}`}
            </span>
            {!feed?.main && !today.landed ? ', nothing landed yet' : ''}
            {' (UTC day)'}
            {state ? `, ${state.toLowerCase()}` : ''}
          </>
        ) : (
          ', not loaded yet'
        )}
      </span>
    </a>
  );
}
