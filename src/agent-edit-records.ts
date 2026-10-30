// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { join } from 'node:path';
import { readWorkPointer } from './work-pointer.js';
import { readSource } from './files.js';
import { unpackRecord } from './work-record-codec.js';
import { assertCurrentWorkFormat } from './work-format.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { RecordManifest } from './work-records.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const collection = z.object({
  count: z.number().int().nonnegative(),
  pages: z.array(hash),
  lookup: hash.optional(),
});
const header = z.object({
  kind: z.literal('forge-work-record-v2'),
  fields: z.record(z.string(), z.unknown()),
  arrays: z.record(z.string(), collection),
});
const pointer = z.object({
  schema: z.enum(['forge-work-records-v2', 'forge-work-records-v3']),
  fields: z.record(z.string(), z.unknown()),
  collections: z.record(z.string(), collection),
});

/** Read-only selected metadata; deliberately imports no writer, Work schema or metrics stack.
 * Hash verification, physical codec and atomic pointer checks match the general record reader. */
export function editRecordReader(directory: string) {
  const bytes = readWorkPointer(directory);
  invariant(bytes, 'EDIT_INDEX_UNAVAILABLE', 'Local Work is unavailable.');
  const manifest = pointer.parse(JSON.parse(bytes.toString('utf8'))) as RecordManifest;
  assertCurrentWorkFormat(manifest.fields);
  const read = (id: string): unknown => {
    hash.parse(id);
    const packed = readSource(directory, join('records', id), Number.MAX_SAFE_INTEGER);
    invariant(packed, 'EDIT_INDEX_UNAVAILABLE', 'Local Work record is unavailable.');
    const raw = unpackRecord(packed);
    invariant(digest(raw) === id, 'INVALID_WORK_STORE', 'Local Work record differs from its identity.');
    return JSON.parse(raw.toString('utf8'));
  };
  const page = (id: string) => z.array(hash).max(128).parse(read(id));
  const fragment = (id: string) => header.parse(read(id));
  return {
    manifest,
    read,
    page,
    fragment,
    io: {
      read,
      put(): string {
        throw new Error('Edit reader cannot write Work.');
      },
    },
  };
}
