// SPDX-License-Identifier: Apache-2.0
import { parseJsonStream } from './json-stream.js';
import { validateRecordPacks, type RecordPack } from './work-record-packs.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { sourceManifestSchema } from './work-archive-metadata.js';
import {
  byteTreeChunks,
  exchangeRootSchema,
  isExchangeRoot,
  readByteTree,
  type BytePin,
} from './native-exchange-tree.js';
import { workRecordChunks, workRecordRootSchema, type WorkRecordRoot } from './work-exchange-records.js';
import type { WorkData } from './work-types.js';

/** Four independent immutable reads in flight; preserve record order and drain
 * failures before returning. Each read is <=100 records / a 2 MiB target. */
function batchedPinReader(pins: BytePin[], read: (pins: BytePin[]) => Promise<Buffer[]>) {
  const pending: { start: number; end: number; result: Promise<PromiseSettledResult<Buffer[]>> }[] = [];
  let queued = 0,
    position = 0,
    current: Buffer[] = [],
    start = 0;
  function fill() {
    while (queued < pins.length && pending.length < 4) {
      const from = queued;
      let bytes = 0;
      while (
        queued < pins.length &&
        queued - from < 100 &&
        (!bytes || bytes + pins[queued]!.size <= 2 * 1024 * 1024)
      )
        bytes += pins[queued++]!.size;
      const batch = pins.slice(from, queued);
      const result = read(batch).then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      );
      pending.push({ start: from, end: queued, result });
    }
  }
  return {
    async read(pin: BytePin) {
      if (!current.length) {
        fill();
        const batch = pending.shift();
        invariant(batch, 'INVALID_WORK_BACKUP', 'Record traversal exceeded its catalog.');
        const result = await batch.result;
        if (result.status === 'rejected') throw result.reason;
        invariant(
          result.value.length === batch.end - batch.start,
          'INVALID_WORK_BACKUP',
          'Record read omitted bytes.',
        );
        current = result.value;
        start = batch.start;
        fill();
      }
      const expected = pins[position]!;
      invariant(
        expected.sha256 === pin.sha256 && expected.size === pin.size,
        'INVALID_WORK_BACKUP',
        'Record traversal order changed.',
      );
      const bytes = current[position++ - start]!;
      // Release each consumed body; only the bounded pending window is retained.
      current[position - start - 1] = undefined as unknown as Buffer;
      if (position - start === current.length) current = [];
      return bytes;
    },
    async drain() {
      await Promise.all(pending.map(p => p.result));
    },
  };
}
/** Packs amortize per-object storage/authority calls without trusting any
 * record body. Callers still check each body and the whole canonical digest. */
export function batchedRecordReader(
  records: WorkRecordRoot,
  read: (pins: BytePin[]) => Promise<Buffer[]>,
  packs?: RecordPack[],
) {
  if (!packs)
    return batchedPinReader(
      records.fields.flatMap(f => ('records' in f ? f.records : [])),
      read,
    );
  const pins = validateRecordPacks(records, packs),
    reader = batchedPinReader(packs, read);
  let index = 0,
    position = 0,
    offset = 0,
    bytes: Buffer | undefined;
  return {
    async read(pin: BytePin) {
      const pack = packs[index]!;
      invariant(
        pack && pins[position]?.sha256 === pin.sha256 && pins[position]?.size === pin.size,
        'INVALID_WORK_BACKUP',
        'Packed record traversal order changed.',
      );
      if (!bytes) {
        bytes = await reader.read(pack);
        invariant(
          bytes.length === pack.size && digest(bytes) === pack.sha256,
          'INVALID_WORK_BACKUP',
          'Packed record bytes differ from their pin.',
        );
      }
      const result = bytes.subarray(offset, offset + pin.size);
      offset += pin.size + 2;
      position++;
      if (position === pack.first + pack.count) {
        index++;
        bytes = undefined;
        offset = 0;
      }
      return result;
    },
    drain: reader.drain,
  };
}
/** Complete validation still reads every byte. Only parsed Work and a bounded
 * read window are retained, never a second whole byte/string representation. */
export async function resolveExchangeWork(bytes: Buffer, read: (pins: BytePin[]) => Promise<Buffer[]>) {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isExchangeRoot(value)) {
    const manifest = sourceManifestSchema.parse(value),
      file = manifest.files.find(f => f.path === 'work.json');
    invariant(file, 'INVALID_WORK_BACKUP', 'Exchange omits Work metadata.');
    const [work] = await read([file]);
    invariant(
      work && work.length === file.size && digest(work) === file.sha256,
      'INVALID_WORK_BACKUP',
      'Work differs from its manifest.',
    );
    async function* chunks() {
      for (let i = 0; i < work!.length; i += 65536) yield work!.subarray(i, i + 65536);
    }
    return { manifest: bytes, data: (await parseJsonStream(chunks())) as WorkData };
  }
  const root = exchangeRootSchema.parse(value),
    options = { batchSize: 100 };
  const manifest = await readByteTree(root.manifest, read, options);
  const file = sourceManifestSchema
    .parse(JSON.parse(manifest.toString('utf8')))
    .files.find(f => f.path === 'work.json');
  invariant(
    file?.sha256 === root.work.sha256 && file.size === root.work.size,
    'INVALID_WORK_BACKUP',
    'Work tree differs from its manifest.',
  );
  if (root.schema === 1)
    return {
      manifest,
      data: (await parseJsonStream(byteTreeChunks(root.work, read, { batchSize: 4 }))) as WorkData,
    };
  const records = workRecordRootSchema.parse(
    await parseJsonStream(byteTreeChunks(root.records, read, options)),
  );
  invariant(
    records.work.sha256 === root.work.sha256 && records.work.size === root.work.size,
    'INVALID_WORK_BACKUP',
    'Record root differs from logical Work.',
  );
  const reader = batchedRecordReader(records, read, root.recordPacks);
  try {
    return { manifest, data: (await parseJsonStream(workRecordChunks(records, reader.read))) as WorkData };
  } finally {
    await reader.drain();
  }
}
