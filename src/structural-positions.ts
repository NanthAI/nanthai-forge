// SPDX-License-Identifier: Apache-2.0
import type { Position } from './types.js';

/** Offset to 1-based line/column (UTF-16 code units) for one text, by binary search. */
export function positionIn(text: string): (offset: number) => Position {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return offset => {
    let low = 0,
      high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid;
    }
    return { offset, line: low + 1, column: offset - starts[low]! + 1 };
  };
}
