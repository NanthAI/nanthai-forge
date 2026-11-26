// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { openImportScratch, requireImportRange, writeImportRange } from './projectGithubImportScratch';
import { createWork } from '../src/work-create';
import { invariant } from '../src/errors';
import { digest } from '../src/hash';
import { byteTreeChunks, type BytePin, type ExchangeRoot } from '../src/native-exchange-tree';
import { batchedRecordReader } from '../src/native-exchange-stream';
import { discardJsonValue, parseJsonStream } from '../src/json-stream';
import { workRecordChunks, workRecordRootSchema } from '../src/work-exchange-records';
import { hostedRecordValue, type HostedRecord } from '../src/hosted-records';
import { workStoreRecord, type WorkStoreSource } from '../src/work-store-records';
import { sourceManifestSchema } from '../src/work-archive-metadata';
import type { SeedRequest } from '../src/hosted-seed-protocol';
import { seedWorkBytes, seedWorkRows } from './projectHostedSeedWorkLimits';
import { jsonChunks } from '../src/json-chunks';
import type { WorkData } from '../src/work-types';

type Read = (pins: BytePin[]) => Promise<Buffer[]>;
type Row = { collection: WorkStoreSource; value: string; bound?: true };
type Span = {
  collection: WorkStoreSource;
  start: number;
  size: number;
  id?: string;
  version?: number;
  intentId?: string;
};
type Progress = { next: number; digest: string; total: number; fragment: number };
type Identity = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  owner: string;
  backupId?: Id<'projectBackups'>;
};

export function emptySeedWork(request: SeedRequest) {
  if (request.revision !== 0) return false;
  const work = JSON.stringify(
    createWork(request.format === 'native' ? request.sourceHead : undefined),
    null,
    2,
  );
  return request.work.size === Buffer.byteLength(work) && request.work.sha256 === digest(work);
}

async function* verifiedWork(root: ExchangeRoot, read: Read) {
  if (root.schema === 1) {
    yield* byteTreeChunks(root.work, read, { batchSize: 1, batchBytes: seedWorkBytes });
    return;
  }
  const records = workRecordRootSchema.parse(
    await parseJsonStream(byteTreeChunks(root.records, read, { batchSize: 20, batchBytes: seedWorkBytes })),
  );
  invariant(
    records.work.sha256 === root.work.sha256 && records.work.size === root.work.size,
    'INVALID_WORK_BACKUP',
    'The Work record catalog differs from the original Work pin.',
  );
  const reader = batchedRecordReader(records, read, undefined, { bytes: seedWorkBytes, inFlight: 1 });
  try {
    yield* workRecordChunks(records, reader.read);
  } finally {
    await reader.drain();
  }
}

/** Import only verified snapshot records. The scratch file holds bodies; the in-memory order is
 * offsets and IDs. The durable cursor and whole Work pin reconcile a lost page response. */
export async function importSeedWork(
  ctx: ActionCtx,
  input: Identity,
  request: SeedRequest,
  root: ExchangeRoot,
  read: Read,
  previous?: Progress,
) {
  if (emptySeedWork(request)) return 0;
  if (previous && previous.next === previous.total) return previous.total;
  const manifest = sourceManifestSchema.parse(
    await parseJsonStream(byteTreeChunks(root.manifest, read, { batchSize: 20, batchBytes: seedWorkBytes })),
  );
  const workPin = manifest.files.find(file => file.path === 'work.json');
  invariant(
    workPin?.sha256 === request.work.sha256 &&
      workPin.size === request.work.size &&
      manifest.revision === request.revision &&
      manifest.head === request.sourceHead &&
      (manifest.kind === 'forge-native-work-backup') === (request.format === 'native'),
    'INVALID_WORK_BACKUP',
    'The original source manifest differs from its Work and revision pins.',
  );
  return await importWorkSnapshot(
    ctx,
    input,
    verifiedWork(root, read),
    {
      revision: request.revision,
      source: request.format === 'native' ? request.sourceHead : undefined,
      digest: request.work.sha256,
    },
    previous,
  );
}

/** A stored archive from before seed publication uses the same canonical import
 * before its first Work initialization. The existing source reader already verified its bytes. */
export async function importStoredWork(
  ctx: ActionCtx,
  input: Identity,
  data: WorkData,
  digest: string,
  previous?: Progress,
) {
  if (previous && previous.next === previous.total) return;
  async function* chunks() {
    for (const chunk of jsonChunks(data)) yield Buffer.from(chunk);
  }
  await importWorkSnapshot(
    ctx,
    input,
    chunks(),
    { revision: data.revision, source: data.nativeHead, digest },
    previous,
  );
}

async function importWorkSnapshot(
  ctx: ActionCtx,
  input: Identity,
  chunks: AsyncIterable<Uint8Array>,
  expected: { revision: number; source: string | undefined; digest: string },
  previous?: Progress,
) {
  const scratch = await openImportScratch(),
    spans: Span[] = [];
  let offset = 0;
  const append = async (collection: WorkStoreSource, value: unknown, encoded: HostedRecord) => {
    const body = Buffer.from(JSON.stringify({ collection, value: JSON.stringify(value) }));
    const size = body.byteLength;
    await writeImportRange(scratch.file, body, offset);
    spans.push({
      collection,
      start: offset,
      size,
      ...(encoded.kind === 'issue' ? { id: encoded.id, version: encoded.version } : {}),
      ...(encoded.kind === 'intent' ? { intentId: encoded.id } : {}),
    });
    offset += size;
  };
  try {
    const detached = new Map<number, Span[]>();
    const intents = new Map<number, string>();
    const work = (await parseJsonStream(chunks, {
      select: path =>
        (path.length === 2 && typeof path[1] === 'number') ||
        (path.length === 4 &&
          path[0] === 'intents' &&
          (path[2] === 'notes' || path[2] === 'lifecycle') &&
          typeof path[3] === 'number'),
      value: async (value, [field, index, nested, position]) => {
        if (field === 'planningItems' || field === 'planningComments') {
          const collection = field === 'planningItems' ? 'planningVersions' : field;
          await append(collection, value, workStoreRecord(collection, value));
        } else if (field === 'intents' && typeof index === 'number') {
          if (nested === 'notes' || nested === 'lifecycle') {
            const body = Buffer.from(JSON.stringify(value));
            await writeImportRange(scratch.file, body, offset);
            const rows = detached.get(index) ?? [];
            rows.push({
              collection: nested,
              start: offset,
              size: body.byteLength,
              version: position as number,
            });
            detached.set(index, rows);
            offset += body.byteLength;
          } else {
            const intent = workStoreRecord('intents', value, { owner: input.owner, version: 0 });
            hostedRecordValue(intent);
            intents.set(index, intent.id);
            await append('intents', value, intent);
          }
        }
        return discardJsonValue;
      },
    })) as { revision?: number; nativeHead?: string };
    invariant(
      work?.revision === expected.revision && work.nativeHead === expected.source,
      'INVALID_WORK_BACKUP',
      'Verified Work differs from its selected revision or source head.',
    );
    for (const [index, rows] of detached) {
      const intentId = intents.get(index);
      invariant(intentId, 'INVALID_WORK_BACKUP', 'A note or status move has no parent Intent.');
      for (const span of rows) {
        const record = Buffer.alloc(span.size);
        await requireImportRange(scratch.file, record, span.start);
        const value = { ...JSON.parse(record.toString('utf8')), intentId, index: span.version };
        await append(span.collection, value, workStoreRecord(span.collection, value));
      }
    }
    // Advance each Item's time pin from its preceding immutable version.
    const itemIds = new Set(spans.flatMap(span => (span.id ? [span.id] : [])));
    spans.sort((a, b) =>
      a.id && b.id
        ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.version! - b.version!
        : a.id
          ? -1
          : b.id
            ? 1
            : a.start - b.start,
    );
    const pin = { digest: expected.digest, total: spans.length };
    invariant(
      !previous || (previous.digest === pin.digest && previous.total === pin.total),
      'WORK_OPERATION_CHANGED',
      'Resume the original verified Work import.',
    );
    const stage = makeFunctionReference<
      'mutation',
      typeof input &
        typeof pin & {
          next: number;
          body: string;
          fragment?: number;
          final?: boolean;
        },
      Progress
    >('projectHostedSeedWorkStore:stage');
    let next = previous?.next ?? 0;
    if (!spans.length) {
      await ctx.runMutation(stage, { ...input, ...pin, next, body: '[]' });
      return 0;
    }
    while (next < spans.length) {
      const batch: Row[] = [];
      let bytes = 2;
      for (const span of spans.slice(next, next + seedWorkRows)) {
        const bound = span.intentId && itemIds.has(span.intentId);
        const size = bound ? span.size + Buffer.byteLength(',"bound":true') : span.size;
        if (bytes + size + 1 > seedWorkBytes && batch.length) break;
        const row = Buffer.alloc(span.size);
        await requireImportRange(scratch.file, row, span.start);
        const text = row.toString('utf8');
        const body = bound ? text.slice(0, -1) + ',"bound":true}' : text;
        if (bytes + size + 1 > seedWorkBytes) {
          // Existing valid records can exceed a page. Stage UTF-8-safe string
          // fragments, then assemble only this record in its final transaction.
          const width = Math.floor(seedWorkBytes / 4),
            parts: string[] = [];
          for (let start = 0; start < body.length;) {
            let end = Math.min(body.length, start + width);
            if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1]!)) end--;
            parts.push(body.slice(start, end));
            start = end;
          }
          let progress: Progress | undefined;
          for (
            let fragment = previous?.next === next ? previous.fragment : 0;
            fragment < parts.length;
            fragment++
          ) {
            progress = await ctx.runMutation(stage, {
              ...input,
              ...pin,
              next,
              body: parts[fragment]!,
              fragment,
              final: fragment + 1 === parts.length,
            });
          }
          invariant(progress && progress.next > next, 'WORK_STALE', 'The Work import did not advance.');
          next = progress.next;
          break;
        }
        batch.push(JSON.parse(body));
        bytes += size + 1;
      }
      if (batch.length) {
        const progress = await ctx.runMutation(stage, {
          ...input,
          ...pin,
          next,
          body: JSON.stringify(batch),
        });
        invariant(progress.next > next, 'WORK_STALE', 'The Work import did not advance.');
        next = progress.next;
      }
    }
    return spans.length;
  } finally {
    await scratch.close();
  }
}
