// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { WorkRecordRoot } from './work-exchange-records.js';

/** Optional transport acceleration. Catalog identities and canonical Work bytes
 * stay identical; old record-only checkpoints still use their original reader. */
export const recordPackSchema = z
  .object({
    first: z.number().safe().nonnegative(),
    count: z.number().safe().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().safe().nonnegative(),
  })
  .strict();
export type RecordPack = z.infer<typeof recordPackSchema>;

export function buildRecordPacks(
  root: WorkRecordRoot,
  work: Buffer,
  locations: Record<string, { offset?: number }>,
  put: (bytes: Buffer, offset: number) => void,
): RecordPack[] {
  const packs: RecordPack[] = [];
  let position = 0,
    cursor = 0;
  for (const field of root.fields) {
    if (!('records' in field)) continue;
    let first = position,
      start = 0,
      end = 0;
    for (const record of field.records) {
      const location = locations[record.sha256]!.offset!;
      const offset = work.indexOf(work.subarray(location, location + record.size), cursor);
      invariant(offset >= 0, 'INVALID_WORK_BACKUP', 'Packed record is absent from Work.');
      cursor = offset + record.size;
      if (position === first) start = offset;
      end = offset + record.size;
      position++;
      const count = position - first;
      // Bound requests and anchor pages to stable record identities so an
      // insertion changes only its nearby page, rather than all later pages.
      if (
        count >= 64 ||
        end - start >= 128 * 1024 ||
        (count >= 8 && (parseInt(digest(record.key).slice(0, 8), 16) & 15) === 0) ||
        record === field.records.at(-1)
      ) {
        const bytes = work.subarray(start, end);
        packs.push({ first, count, sha256: digest(bytes), size: bytes.length });
        put(bytes, start);
        first = position;
      }
    }
  }
  return packs;
}

export function validateRecordPacks(root: WorkRecordRoot, packs: RecordPack[]) {
  const records = root.fields.flatMap(field => ('records' in field ? field.records : []));
  let position = 0;
  for (const pack of packs) {
    const selected = records.slice(position, position + pack.count);
    invariant(
      pack.first === position &&
        selected.length === pack.count &&
        pack.size === selected.reduce((size, pin) => size + pin.size, 0) + 2 * (pack.count - 1),
      'INVALID_WORK_BACKUP',
      'Packed record coverage or size differs from the catalog.',
    );
    position += pack.count;
  }
  invariant(position === records.length, 'INVALID_WORK_BACKUP', 'Packed records omit catalog entries.');
  return records;
}
