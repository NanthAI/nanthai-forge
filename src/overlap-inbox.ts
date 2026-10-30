// SPDX-License-Identifier: Apache-2.0
import { opendirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type OverlapDelivery = { noticeId: string; file: string; lanes: string[]; at: string };
/** Hook attribution is file-backed, not a Work transaction. Publish its retained inbox at save time. */
export function readOverlapInbox(directory: string, laneId: string): OverlapDelivery[] {
  let entries;
  try {
    entries = opendirSync(join(directory, 'overlap-inbox', laneId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const recent: OverlapDelivery[] = [];
  try {
    for (let entry; (entry = entries.readSync());) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const value = JSON.parse(readFileSync(join(entries.path, entry.name), 'utf8')) as OverlapDelivery;
      if (!value.lanes.includes(laneId) || !Number.isFinite(Date.parse(value.at))) continue;
      recent.push({ noticeId: value.noticeId, file: value.file, lanes: value.lanes, at: value.at });
      recent.sort((a, b) => b.at.localeCompare(a.at) || a.noticeId.localeCompare(b.noticeId));
      if (recent.length > 20) recent.pop();
    }
  } finally {
    entries.closeSync();
  }
  return recent;
}
