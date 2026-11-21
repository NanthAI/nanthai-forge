// SPDX-License-Identifier: Apache-2.0
export type LineEdit = { start: number; end: number; lines: string[] };

/** Myers shortest edit path within a distance cap and a step budget (shared across calls). */
export function myers(before: string[], after: string[], budget: { steps: number }): LineEdit[] | null {
  let previous = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let distance = 0; distance <= Math.min(before.length + after.length, 512); distance++) {
    trace.push(previous);
    const next = new Map<number, number>();
    for (let k = -distance; k <= distance; k += 2) {
      if (--budget.steps < 0) return null;
      let x =
        k === -distance || (k !== distance && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1))
          ? (previous.get(k + 1) ?? 0)
          : (previous.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
        if (--budget.steps < 0) return null;
      }
      next.set(k, x);
      if (x < before.length || y < after.length) continue;
      const operations: ('same' | 'delete' | 'insert')[] = [];
      for (let d = distance; d >= 0; d--) {
        const v = trace[d]!,
          diagonal = x - y;
        const prior =
          diagonal === -d || (diagonal !== d && (v.get(diagonal - 1) ?? -1) < (v.get(diagonal + 1) ?? -1))
            ? diagonal + 1
            : diagonal - 1;
        const px = v.get(prior) ?? 0,
          py = px - prior;
        while (x > px && y > py) {
          operations.push('same');
          x--;
          y--;
        }
        if (d > 0) {
          if (x === px) {
            operations.push('insert');
            y--;
          } else {
            operations.push('delete');
            x--;
          }
        }
      }
      let a = 0,
        b = 0,
        current: LineEdit | undefined;
      const result: LineEdit[] = [];
      for (const operation of operations.reverse()) {
        if (operation === 'same') {
          current = undefined;
          a++;
          b++;
          continue;
        }
        if (!current) {
          current = { start: a, end: a, lines: [] };
          result.push(current);
        }
        if (operation === 'delete') current.end = ++a;
        else current.lines.push(after[b++]!);
      }
      return result;
    }
    previous = next;
  }
  return null;
}
