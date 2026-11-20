// SPDX-License-Identifier: Apache-2.0
// The line's slot in the top bar (Item 18af654d owns the marks, their motion and the feed). The frame draws the stops
// and their counts from the feed's shared contract (convex/projectLiveLine.ts `liveLineResult`); until the feed
// arrives it draws the stops with no counts, so nothing moves when it does. Each stop links to Lanes at that stop.
// The stops are the Flow picture's (Item 85f456c1): Editing, Saved, In queue, Checking; a Lane whose check passed
// ('ready') counts at Checking, so the line, the picture and Lanes count every stop alike (`lineStops`).
import { hrefFor } from './paths';
import { followLink } from './router';

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
  }[];
  more: number;
  moreIsLowerBound: boolean;
  main: { head: string; at?: string } | null;
  /** The last Lane that left the line, and how. */
  exit?: { laneId: string; kind: 'landed' | 'set-aside'; at: number } | null;
  /** The Flow view's running day (src/flow-day.ts `FlowDay`); read it with `flowToday`. */
  flow?: { hours: number[][]; took: number[][]; main?: { red: boolean; since: number } };
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  const lanesHref = hrefFor({ frame: 'project', handle, project, place: 'lanes', section: '', rest: '' });
  return (
    <nav
      className={phone ? 'line phone' : 'line'}
      aria-label="Where work is"
      aria-busy={feed ? undefined : true}
    >
      {lineStops.map(stop => {
        const at = feed?.lanes.filter(lane => stop.of.includes(lane.stage)) ?? [];
        const held = at.filter(lane => lane.held).length;
        const shown = phone ? stop.short : stop.label;
        // The name starts with what the stop shows ("Editing 1"), so speech and voice control match the screen.
        const words = feed
          ? `${shown} ${plural(at.length, 'Lane')}${shown === stop.label ? '' : `, ${stop.label.toLowerCase()}`}${held ? `, ${held} held` : ''}`
          : `${shown}, not loaded yet`;
        return (
          <a
            key={stop.stage}
            href={`${lanesHref}?stop=${stop.stage}`}
            onClick={followLink}
            className={feed && !at.length ? 'stop zero' : 'stop'}
            data-stop={stop.stage}
            aria-label={words}
          >
            <span className="lbl" aria-hidden="true">
              {shown}
            </span>
            <span className="slot" aria-hidden="true" />
            {/* A space between the words and the count, so the shown text reads "Editing 1" (the flex row drops it). */}
            {feed ? ' ' : null}
            {feed ? (
              <span className="n" aria-hidden="true">
                {at.length}
              </span>
            ) : null}
          </a>
        );
      })}
      <a
        href={hrefFor({ frame: 'project', handle, project, place: 'code', section: '', rest: '' })}
        onClick={followLink}
        className="stop tomain"
        aria-label={feed?.main ? 'main' : 'main, nothing landed yet'}
      >
        <span className="lbl" aria-hidden="true">
          main
        </span>
      </a>
    </nav>
  );
}
