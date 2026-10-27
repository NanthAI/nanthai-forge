// SPDX-License-Identifier: Apache-2.0
// Synthetic legacy closures for read compatibility fixtures.
/** Complete immutable closures avoid a quadratic table of individual pairs.
 * Each chunk is below 70 KiB, independently of retained history size. */
export function ancestryEntries(head, parents) {
  const pending = [head],
    seen = new Set();
  let complete = true;
  while (pending.length) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    const list = parents.get(next);
    if (list) pending.push(...list);
    else complete = false;
  }
  const ancestors = [...seen],
    chunks = Math.ceil(ancestors.length / 1000);
  return [
    {
      collection: 'sourceAncestryClosure',
      key: head,
      parent: '',
      position: 0,
      value: JSON.stringify({ head, chunks, complete }),
    },
    ...Array.from({ length: chunks }, (_, i) => ({
      collection: 'sourceAncestryChunk',
      key: `${head}:${i}`,
      parent: head,
      position: i,
      value: JSON.stringify({
        ancestors: ancestors.slice(i * 1000, (i + 1) * 1000),
        boundaries: ancestors.slice(i * 1000, (i + 1) * 1000).filter(head => !parents.has(head)),
      }),
    })),
  ];
}
