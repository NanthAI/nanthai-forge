// SPDX-License-Identifier: Apache-2.0

/** Items with the first of each key kept, in order. Source rows can repeat (an event read on two pages, a save
 * recorded twice with one head); a list that React keys by that id must drop the repeat here rather than key by
 * position, which would hide it and mis-match rows when the list changes. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
