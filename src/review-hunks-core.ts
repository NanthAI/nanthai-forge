// SPDX-License-Identifier: Apache-2.0
type Op = { kind: 'context' | 'removed' | 'added'; text: string; before: number; after: number };

function decoded(bytes: Uint8Array): string[] | null {
  if (bytes.length > 1024 * 1024) return null;
  try {
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null;
    // Preserve the final empty line to disclose final-newline changes.
    return value ? value.split('\n') : [];
  } catch {
    return null;
  }
}
export function computeHunks(original: Uint8Array, selected: Uint8Array, context: number) {
  const a = decoded(original),
    b = decoded(selected);
  if (!a || !b)
    return {
      hunks: [],
      content: 'binary, invalid UTF-8 or over 1 MiB; hashes remain exact',
      truncated: true,
    };
  let first = 0,
    lastA = a.length,
    lastB = b.length;
  while (first < lastA && first < lastB && a[first] === b[first]) first++;
  while (lastA > first && lastB > first && a[lastA - 1] === b[lastB - 1]) {
    lastA--;
    lastB--;
  }
  if (first === lastA && first === lastB) return { hunks: [], truncated: false };
  const x = a.slice(first, lastA),
    y = b.slice(first, lastB),
    bounded = (x.length + 1) * (y.length + 1) <= 1_000_000;
  const ops: Op[] = [];
  let ai = Math.max(0, first - context),
    bi = ai;
  const emit = (kind: Op['kind'], text: string) => {
    ops.push({ kind, text, before: ai + 1, after: bi + 1 });
    if (kind !== 'added') ai++;
    if (kind !== 'removed') bi++;
  };
  for (; ai < first;) emit('context', a[ai]!);
  if (bounded) {
    const width = y.length + 1,
      table = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        table[i * width + j] =
          x[i] === y[j]
            ? 1 + table[(i + 1) * width + j + 1]!
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0,
      j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        emit('context', x[i++]!);
        j++;
      } else if (i < x.length && (j === y.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!))
        emit('removed', x[i++]!);
      else emit('added', y[j++]!);
    }
  } else {
    for (const line of x) emit('removed', line);
    for (const line of y) emit('added', line);
  }
  while (ai < Math.min(a.length, lastA + context)) emit('context', a[ai]!);
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < ops.length; i++)
    if (ops[i]!.kind !== 'context') {
      const start = Math.max(0, i - context),
        end = Math.min(ops.length, i + context + 1),
        previous = ranges.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else ranges.push({ start, end });
    }
  return {
    hunks: ranges.map(({ start, end }) => ({
      beforeStart: ops[start]!.before,
      afterStart: ops[start]!.after,
      beforeLines: ops.slice(start, end).filter(op => op.kind !== 'added').length,
      afterLines: ops.slice(start, end).filter(op => op.kind !== 'removed').length,
      lines: ops.slice(start, end).map(({ kind, text }) => ({ kind, text })),
    })),
    truncated: !bounded,
    ...(!bounded
      ? { content: 'Bounded replacement hunk; minimal alignment exceeded the computation budget' }
      : {}),
  };
}
