// SPDX-License-Identifier: Apache-2.0
import type { FeedItem } from './attention';

/** Fold consecutive saves in the same Lane within twelve minutes. No records are discarded. */
export function activityBursts(items: readonly FeedItem[]): FeedItem[][] {
  const groups: FeedItem[][] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    const last = previous?.at(-1);
    if (
      last &&
      item.id.startsWith('save:') &&
      last.id.startsWith('save:') &&
      item.laneId &&
      item.laneId === last.laneId &&
      Math.abs(new Date(last.at).getTime() - new Date(item.at).getTime()) <= 12 * 60_000
    ) {
      previous!.push(item);
    } else groups.push([item]);
  }
  return groups;
}
