// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Side-by-side rows of one hunk (Item 8e847a17), pure so the layout rule has its own test.
import type { Hunk } from './app/lane/file-diff';

export type Cell = { n: number; text: string; key: string; kind: 'context' | 'removed' | 'added' } | null;
export type Row = { left: Cell; right: Cell };

/** A hunk as rows with the removed and added runs paired line to line: a replaced line sits across from its
 * replacement, a pure removal or addition across from an empty cell. */
export function splitRows(hunk: Hunk, h: number): Row[] {
  const rows: Row[] = [];
  let before = hunk.beforeStart,
    after = hunk.afterStart,
    removed: Cell[] = [],
    added: Cell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    removed = [];
    added = [];
  };
  hunk.lines.forEach((line, l) => {
    const key = `${h}:${l}`;
    if (line.kind === 'removed') removed.push({ n: before++, text: line.text, key, kind: 'removed' });
    else if (line.kind === 'added') added.push({ n: after++, text: line.text, key, kind: 'added' });
    else {
      flush();
      rows.push({
        left: { n: before++, text: line.text, key, kind: 'context' },
        right: { n: after++, text: line.text, key, kind: 'context' },
      });
    }
  });
  flush();
  return rows;
}
