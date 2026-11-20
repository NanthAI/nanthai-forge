// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReadsAsleep } from '../../live-reads';

const inputEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const;

/** A one-shot CSS clock halves the ambient rate after 60 s without input. It never reads data. */
export function FlowMotion({
  active,
  ariaBusy,
  children,
}: {
  active: boolean;
  ariaBusy: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const asleep = useReadsAsleep();

  useEffect(() => {
    const region = root.current!;
    const visibility = () => {
      region.toggleAttribute('data-hidden', document.hidden);
      if (!document.hidden) input();
    };
    const input = () => {
      if (!active || asleep || document.hidden) return;
      const [animation] = clock.current?.getAnimations() ?? [];
      if (animation) animation.currentTime = 0;
      region.removeAttribute('data-slow');
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    if (active && !asleep)
      for (const event of inputEvents)
        window.addEventListener(event, input, { passive: true, capture: true });
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      for (const event of inputEvents) window.removeEventListener(event, input, true);
    };
  }, [active, asleep]);

  return (
    <div
      ref={root}
      className="flow"
      data-still={active && !asleep ? undefined : ''}
      aria-busy={ariaBusy || undefined}
    >
      {active && !asleep ? (
        <span
          ref={clock}
          className="flow-clock"
          aria-hidden="true"
          onAnimationEnd={() => root.current?.setAttribute('data-slow', '')}
        />
      ) : null}
      {children}
    </div>
  );
}

type Point = { x: number; y: number };
export type DrawnBlock = Point & { laneId: string; stop: string };
type Feed = import('../Line').LineFeed;
type Frame = {
  feed: Feed;
  width: number;
  blocks: Map<string, DrawnBlock>;
  main: Point;
  today: number;
};
type Arrival = Point & { fresh?: true; key: string };
type Change = {
  width: number;
  blocks: Map<string, Arrival>;
  landed?: Point;
  pulse?: string;
};

/** Compare delivered frames. Resize and unrelated feed updates do not replay or cut short an arrival. */
export function useFlowArrival(frame: Frame | undefined) {
  const last = useRef<Frame | undefined>(undefined);
  const [change, setChange] = useState<Change>();
  useEffect(() => {
    const before = last.current;
    last.current = frame;
    if (!frame || !before || frame.width !== before.width) {
      setChange(undefined);
      return;
    }
    if (frame.feed === before.feed) return;
    const moved = new Map<string, Arrival>();
    const priorIds = new Set(before.feed.lanes.map(lane => lane.laneId));
    for (const lane of frame.feed.lanes) {
      const to = frame.blocks.get(lane.laneId);
      if (!to) continue;
      const from = before.blocks.get(lane.laneId);
      const key = `${lane.stage}:${lane.changedAt}`;
      if (from && from.stop !== to.stop) moved.set(lane.laneId, { x: from.x - to.x, y: from.y - to.y, key });
      else if (!from && !before.feed.more && !priorIds.has(lane.laneId))
        moved.set(lane.laneId, { x: 0, y: 0, fresh: true, key });
    }
    const exit = frame.feed.exit;
    const oldExit = before.feed.exit;
    const landed =
      exit?.kind === 'landed' &&
      (exit.at !== oldExit?.at || exit.laneId !== oldExit.laneId || oldExit.kind !== 'landed');
    const from = landed ? before.blocks.get(exit.laneId) : undefined;
    const pulse = landed
      ? `${exit.laneId}:${exit.at}`
      : frame.today > before.today
        ? String(frame.today)
        : undefined;
    setChange(old => {
      if (!old && !pulse && !moved.size) return old;
      const blocks = new Map([...(old?.blocks ?? [])].filter(([id]) => frame.blocks.has(id)));
      moved.forEach((move, id) => blocks.set(id, move));
      return {
        width: frame.width,
        blocks,
        landed: from
          ? { x: from.x - frame.main.x, y: from.y - frame.main.y }
          : pulse
            ? undefined
            : old?.landed,
        pulse: pulse ?? old?.pulse,
      };
    });
  }, [frame]);
  return frame && change?.width === frame.width ? change : undefined;
}
