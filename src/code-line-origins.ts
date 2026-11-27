// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { alignment } from './view-line-attribution.js';

/** Trace surviving final lines backwards through verified landing diffs. A discontinuity is not a diff:
 * stop instead of guessing who wrote a line. The result indexes the caller's newest-first transitions. */
export async function landingLineOrigins(
  selectedBlob: string,
  pairs: readonly { before: string | null; after: string | null }[],
  read: (blob: string) => Promise<Buffer | null>,
) {
  let blob: string | null = selectedBlob;
  let after = await read(blob);
  let targets: (number | null)[] | null = null;
  const origins: (number | null)[] = [];
  for (const [index, pair] of pairs.entries()) {
    if (!after || pair.after !== blob) break;
    if (pair.before === blob) continue;
    const before = pair.before ? await read(pair.before) : Buffer.alloc(0);
    const diff = before && alignment(before, after);
    if (!diff) break;
    if (!targets) {
      targets = Array.from({ length: diff.after }, (_, line) => line);
      origins.push(...targets.map(() => null));
    }
    const previous: (number | null)[] = [];
    let a = 0;
    let b = 0;
    for (const edit of diff.edits) {
      while (a < edit.start) {
        previous.push(targets[b++] ?? null);
        a++;
      }
      for (let inserted = 0; inserted < edit.lines.length; inserted++) {
        const target = targets[b++];
        if (target != null) origins[target] = index;
      }
      while (a < edit.end) {
        previous.push(null);
        a++;
      }
    }
    while (a++ < diff.before) previous.push(targets[b++] ?? null);
    targets = previous;
    if (!pair.before || !targets.some(line => line !== null)) break;
    blob = pair.before;
    after = before;
  }
  return origins;
}
