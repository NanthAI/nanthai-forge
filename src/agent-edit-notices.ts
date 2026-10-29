// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeEditObservation } from './agent-edit-observation.js';
import { editRecordReader } from './agent-edit-records.js';
import { indexGet, lookupKey } from './work-record-index.js';
import type { OverlapAlert } from './agent-overlap-alerts.js';

/** Stable indexed note identity; operationId separately retains retry identity. */
export function overlapAnswerId(laneId: string, noticeId: string) {
  const h = digest(JSON.stringify([laneId, noticeId]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function retainEditNotices(directory: string, notices: OverlapAlert[]) {
  for (const notice of notices)
    for (const laneId of notice.lanes) {
      const target = join(directory, 'overlap-inbox', laneId);
      mkdirBelow(directory, target);
      const path = join(target, `${notice.noticeId}.json`);
      if (!existsSync(path)) writeEditObservation(path, notice);
    }
}
/** Read one Lane's indexed notes rather than hydrating the Intent conversation. */
export function overlapAnswers(directory: string, laneId: string) {
  const reader = editRecordReader(directory),
    manifest = reader.manifest,
    io = reader.io;
  const lanePosition = indexGet(io, manifest.collections.lanes?.lookup, lookupKey('id', laneId))[0];
  if (lanePosition === undefined) return () => false;
  const fragment = (collection: string, position: number) => {
    const page = manifest.collections[collection]!.pages[Math.floor(position / 128)]!;
    return reader.fragment(reader.page(page)[position % 128]!);
  };
  const lane = fragment('lanes', lanePosition);
  const intentPosition = indexGet(
    io,
    manifest.collections.intents?.lookup,
    lookupKey('id', String(lane.fields.intentId)),
  )[0];
  const notes = intentPosition === undefined ? undefined : fragment('intents', intentPosition).arrays.notes;
  const hostedDirectory = join(directory, 'hosted-overlap-answers', laneId);
  // Like the native notes above, select available answers once per lookup.
  // Native owners without hosted answers need no per-notice filesystem probes.
  const hosted = existsSync(hostedDirectory);
  return (noticeId: string) =>
    (hosted && existsSync(join(hostedDirectory, `${noticeId}.json`))) ||
    (!!notes && indexGet(io, notes.lookup, lookupKey('id', overlapAnswerId(laneId, noticeId))).length > 0);
}
export function unacknowledgedOverlaps(directory: string, laneId: string) {
  let names: string[];
  try {
    names = readdirSync(join(directory, 'overlap-inbox', laneId)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0, items: [] };
    throw error;
  }
  if (!names.length) return { count: 0, items: [] };
  const answered = overlapAnswers(directory, laneId);
  const items: Pick<OverlapAlert, 'noticeId' | 'file' | 'lanes' | 'text'>[] = [];
  let count = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name) || answered(name.slice(0, -5))) continue;
    count++;
    if (items.length === 5) continue;
    const notice = JSON.parse(
      readFileSync(join(directory, 'overlap-inbox', laneId, name), 'utf8'),
    ) as OverlapAlert;
    items.push({
      noticeId: notice.noticeId,
      file: notice.file,
      lanes: notice.lanes,
      text: notice.text.slice(0, 400),
    });
  }
  return { count, items };
}
