// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useReadsAsleep } from '../live-reads';
import type { LineFeed, LineStage } from './Line';

type Lane = LineFeed['lanes'][number];
type Stop = { x: number; width: number };
type Placed = { lane: Lane; x: number; tally: boolean };
type Exit = NonNullable<LineFeed['exit']>;
type Delivery = {
  feed?: LineFeed;
  previous?: LineFeed;
  leaving?: { exit: Exit; from: LineFeed };
  geometry: readonly Stop[];
  quiet: boolean;
  catchingUp: boolean;
};
type StopStages = readonly { of: readonly LineStage[] }[];

const INSET = 5;
const MARK = 8;
const GAP = 2;
const TALLY = 3;
const stopWidth = (count: number, size: number) => Math.max(0, count * (size + GAP) - GAP);

function place(feed: LineFeed | undefined, geometry: readonly Stop[], stages: StopStages) {
  const marks = new Map<string, Placed>();
  stages.forEach(({ of }, index) => {
    const stop = geometry[index];
    if (!stop?.width || !feed) return;
    const lanes = feed.lanes
      .filter(lane => of.includes(lane.stage))
      .sort(
        (a, b) =>
          Number(b.held) - Number(a.held) || a.changedAt - b.changedAt || a.laneId.localeCompare(b.laneId),
      );
    const width = Math.max(0, stop.width - 2 * INSET);
    const held = lanes.findIndex(lane => !lane.held);
    const heldCount = held < 0 ? lanes.length : held;
    const packed = stopWidth(lanes.length, MARK) > width;
    const pitch =
      heldCount > 1 ? Math.min(MARK + GAP, Math.max(0, width - MARK) / (heldCount - 1)) : MARK + GAP;
    let x = 0;
    lanes.forEach((lane, i) => {
      if (!lane.held && feed.more) return;
      const tally = packed && !lane.held && !lane.overlap;
      const size = tally ? TALLY : MARK;
      if (!lane.held && x + size > width) return;
      marks.set(lane.laneId, { lane, x: stop.x + INSET + x, tally });
      x += lane.held && i + 1 < heldCount ? pitch : size + GAP;
    });
  });
  return marks;
}

function useStops() {
  const ref = useRef<HTMLSpanElement>(null);
  const [geometry, setGeometry] = useState<Stop[]>([]);
  useLayoutEffect(() => {
    const line = ref.current?.parentElement;
    if (!line || typeof ResizeObserver === 'undefined') return;
    const stops = Array.from(line.querySelectorAll<HTMLElement>(':scope > a.stop'));
    const measure = () => {
      const next = stops.map(stop => ({ x: stop.offsetLeft, width: stop.offsetWidth }));
      setGeometry(previous =>
        next.length === previous.length &&
        next.every((stop, i) => stop.x === previous[i]?.x && stop.width === previous[i]?.width)
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    stops.forEach(stop => observer.observe(stop));
    measure();
    return () => observer.disconnect();
  }, []);
  return { ref, geometry };
}

const exitKey = (exit: LineFeed['exit']) => exit && `${exit.kind}:${exit.laneId}:${exit.at}`;
const reduceMotion = '(prefers-reduced-motion: reduce)';

function useDelivery(feed: LineFeed | undefined, geometry: readonly Stop[]) {
  const asleep = useReadsAsleep();
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia(reduceMotion).matches,
  );
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    const motion = window.matchMedia?.(reduceMotion);
    const preference = () => setReduced(motion?.matches ?? false);
    preference();
    document.addEventListener('visibilitychange', visibility);
    motion?.addEventListener('change', preference);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      motion?.removeEventListener('change', preference);
    };
  }, []);
  const quiet = hidden || asleep || reduced;
  const [last, setLast] = useState<Delivery>({ feed, geometry, quiet, catchingUp: asleep });
  const newFeed = last.feed !== feed;
  const resized = last.geometry !== geometry;
  const catchingUp = asleep || (last.catchingUp && !newFeed);
  if (newFeed || resized || last.quiet !== quiet || last.catchingUp !== catchingUp) {
    // The first delivery after sleeping is the current snapshot. It carries no animation history.
    const previous = !newFeed || quiet || last.quiet || last.catchingUp ? undefined : last.feed;
    const exit = feed?.exit;
    const leaving =
      exit && previous && exitKey(exit) !== exitKey(previous.exit)
        ? { exit, from: previous }
        : quiet || resized || !feed
          ? undefined
          : last.leaving;
    setLast({
      feed,
      quiet,
      previous,
      geometry,
      leaving,
      catchingUp,
    });
  }
  const endExit = (exit: Exit) =>
    setLast(current => (current.leaving?.exit === exit ? { ...current, leaving: undefined } : current));
  return { delivery: last, hidden, endExit };
}

type MarkStyle = CSSProperties & { '--mark-x': string; '--mark-order'?: number };
const markStyle = (x: number, order?: number): MarkStyle => ({ '--mark-x': `${x}px`, '--mark-order': order });

/** Stable Lane keys let CSS take a new transform and its delay in one commit. The overlay never owns a read. */
export function LineMarks({ feed, stages }: { feed?: LineFeed; stages: StopStages }) {
  const { ref, geometry } = useStops();
  const { delivery, hidden, endExit } = useDelivery(feed, geometry);
  const current = place(delivery.feed, geometry, stages);
  const previous = place(delivery.previous, geometry, stages);
  const previousIds = new Set(delivery.previous?.lanes.map(lane => lane.laneId));
  const main = geometry[stages.length];
  const leaving = delivery.leaving?.exit;
  let oldMark = leaving && place(delivery.leaving?.from, geometry, stages).get(leaving.laneId);
  if (leaving?.kind === 'set-aside' && !oldMark) {
    const lane = delivery.leaving?.from.lanes.find(row => row.laneId === leaving.laneId);
    const stop = lane && geometry[stages.findIndex(({ of }) => of.includes(lane.stage))];
    if (lane && stop?.width) oldMark = { lane, x: stop.x + stop.width - INSET - MARK, tally: false };
  }
  const instant = delivery.quiet || !delivery.previous;
  const displayed = [...current.values()];
  if (oldMark && leaving && main?.width && !current.has(leaving.laneId))
    displayed.push({ ...oldMark, x: leaving.kind === 'landed' ? main.x : oldMark.x });
  // Moving a keyed node in the DOM cancels its CSS transition. Only its position may change.
  displayed.sort((a, b) => a.lane.laneId.localeCompare(b.lane.laneId));
  let order = 0;
  return (
    <span className="marks" ref={ref} aria-hidden="true" hidden={hidden}>
      {displayed.map(({ lane, x, tally }) => {
        const exit = !current.has(lane.laneId) ? leaving?.kind : undefined;
        const prior = previous.get(lane.laneId);
        const movedStage = prior && prior.lane.stage !== lane.stage;
        const fresh = !exit && delivery.previous && !previousIds.has(lane.laneId);
        const state =
          exit === 'landed'
            ? 'passed'
            : exit === 'set-aside'
              ? 'stale'
              : lane.held
                ? lane.overlap
                  ? 'conflict'
                  : 'waiting'
                : lane.stage === 'ready'
                  ? 'passed'
                  : 'active';
        return (
          <span
            key={lane.laneId}
            className={tally ? 'm t' : 'm'}
            data-lane={lane.laneId}
            data-stage={lane.stage}
            data-st={state}
            data-hold={!exit && lane.held ? state : undefined}
            data-ov={(!exit && lane.overlap) || undefined}
            data-exit={exit}
            data-new={fresh || undefined}
            data-instant={instant || undefined}
            style={markStyle(x, movedStage ? order++ : undefined)}
          >
            <i onAnimationEnd={exit === 'set-aside' && leaving ? () => endExit(leaving) : undefined} />
          </span>
        );
      })}
      {!instant && leaving?.kind === 'landed' && main?.width ? (
        <span
          key={exitKey(leaving)}
          className="line-ring"
          style={markStyle(main.x)}
          onAnimationEnd={() => endExit(leaving)}
        />
      ) : null}
    </span>
  );
}
