// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Which files this reader has read in a Lane (Item 52235fbf). A tick belongs to the exact content read, so a file the
// agent changes again after you read it comes back unread on its own. Kept in this browser only: no Convex call,
// no write per tick, nothing for an idle tab. A blocked or cleared store simply starts with nothing read.
import { useCallback, useState } from 'react';

type Ticks = Record<string, string>;
const key = (laneId: string) => `forge.lane-read.${laneId}`;

function load(laneId: string): Ticks {
  try {
    const value = JSON.parse(localStorage.getItem(key(laneId)) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Ticks) : {};
  } catch {
    return {};
  }
}

function store(laneId: string, ticks: Ticks) {
  try {
    localStorage.setItem(key(laneId), JSON.stringify(ticks));
  } catch {
    // Private windows and blocked storage keep ticks for this visit only.
  }
}

/** The content a path was read at: its blob id after the change, or "removed" for a deleted file. */
export const readMark = (after: { blob: string } | null) => after?.blob ?? 'removed';

export type ReadState = 'unread' | 'read' | 'changed';

export function useReadTicks(laneId: string) {
  const [ticks, setTicks] = useState<Ticks>(() => load(laneId));
  const state = useCallback(
    (path: string, mark: string): ReadState =>
      ticks[path] === undefined ? 'unread' : ticks[path] === mark ? 'read' : 'changed',
    [ticks],
  );
  const mark = useCallback(
    (path: string, value: string | null) =>
      setTicks(current => {
        const next = { ...current };
        if (value === null) delete next[path];
        else next[path] = value;
        store(laneId, next);
        return next;
      }),
    [laneId],
  );
  return { state, mark };
}
