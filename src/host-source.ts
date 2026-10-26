// SPDX-License-Identifier: Apache-2.0
import type { WorkData } from './work-types.js';
/** Bootstrap and accepted main are both immediately readable. All State records
 * are seeded too, so Work indexing can retain complete ancestry without blobs. */
export function hostSourceHeads(data: WorkData): string[] {
  const main = data.channelMoves.filter(move => move.channel === 'main').at(-1)?.head;
  return [...new Set([data.nativeHead, main].filter((head): head is string => Boolean(head)))];
}
