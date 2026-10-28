// SPDX-License-Identifier: Apache-2.0
// Isolated offline action model: real validators/projection, immutable local bytes, fake database boundaries.
import assert from 'node:assert/strict';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { preparedMetadata } from '../dist/native-exchange-prepared.js';
import { firstIndexBatch, workIndexRows } from '../dist/work-hosted-index.js';
import { viewIndexEntries } from '../dist/view-hosted-index.js';
import { prepareRecordReturn } from '../dist/work-return-context.js';
import { parseJsonStream } from '../dist/json-stream.js';
import { digest } from '../dist/hash.js';
const [scratch, capture, progressModule, deltaModule, mode] = process.argv.slice(2);
const { returnProgress, recordReturnCursor } = await import(progressModule);
const { prepareDelta } = await import(deltaModule);
const before = JSON.parse(readFileSync(join(scratch, 'before.json')));
const after = JSON.parse(readFileSync(join(scratch, 'after.json')));
const events = JSON.parse(readFileSync(join(scratch, 'events.json')));
const prepared = preparedMetadata(capture, readFileSync(join(capture, 'manifest.json')));
const root = JSON.parse(prepared.bytes);
const delta = JSON.parse(prepared.read(root.delta.sha256));
const manifest = JSON.parse(readFileSync(join(capture, 'manifest.json')));
const previousManifest = JSON.parse(readFileSync(join(scratch, 'manifest.json')));
let sourcePages = 0,
  cachedBytes = 0;
const cache = new Map();
const local = pin => prepared.read(pin.sha256) ?? readFileSync(join(scratch, pin.sha256));
const read = async pin => {
  if (!cache.has(pin.sha256)) {
    sourcePages++;
    const bytes = local(pin);
    cache.set(pin.sha256, bytes);
    cachedBytes += bytes.length;
  }
  return cache.get(pin.sha256);
};
let pages = 0;
const started = performance.now();
const result = await prepareRecordReturn(
  before,
  after,
  delta,
  events,
  manifest,
  delta.base.journalRevision,
  'a'.repeat(64),
  read,
  async pins => {
    pages++;
    return Promise.all(
      pins.map(async pin => {
        if (!cache.has(pin.sha256)) {
          const bytes = local(pin);
          cache.set(pin.sha256, bytes);
          cachedBytes += bytes.length;
        }
        return cache.get(pin.sha256);
      }),
    );
  },
);
assert(result);
const validationMs = Math.round(performance.now() - started);
cache.clear();
global.gc?.();
const snapshot = {
  data: result.context.current,
  manifest,
  backup: { _id: 'candidate', transport: 'objects' },
};
const previous = {
  data: result.context.previous,
  manifest: previousManifest,
  backup: { _id: 'previous', transport: 'objects' },
};
const rowDirectory = join(scratch, 'rows');
mkdirSync(rowDirectory, { recursive: true });
const oldObjects = new Map(
  previousManifest.files.filter(file => file.path.startsWith('objects/')).map(file => [file.sha256, file]),
);
const rowPath = (collection, key) => join(rowDirectory, digest(JSON.stringify([collection, key])));
let baselineMetadata;
const iterator = workIndexRows(previous.data, previousManifest, [], 'objects', new Map(), true, false, true);
let item = iterator.next();
while (!item.done) {
  const row = item.value;
  writeFileSync(rowPath(row.collection, row.key), JSON.stringify(row));
  item = iterator.next();
}
baselineMetadata = item.value;
const generation = { _id: 'generation', metadata: JSON.stringify(baselineMetadata) };
global.gc?.();
const stage = {
  _id: 'stage',
  backupId: 'candidate',
  returnAt: new Date().toISOString(),
  status: 'building',
  nextBatch: 0,
  returnStep: 0,
};
const calls = {};
let metadataBytes = 0;
let retainedViewFileRows = 0;
const storedPath = (key, position) => join(scratch, `output-${key}-${position}`);
const input = {
  projectId: 'project',
  expectedBackupId: 'previous',
  revision: delta.base.journalRevision,
  operationId: '00000000-0000-4000-8000-000000000000',
};
const final = {
  ...input,
  owner: 'owner',
  backupId: 'candidate',
  expectedRevision: input.revision,
  localRevision: after.revision,
  at: stage.returnAt,
  command: '{}',
  request: 'synthetic',
  changes: [],
};
let copy = false;
const run = async (ref, args) => {
  const name = getFunctionName(ref);
  calls[name] = (calls[name] ?? 0) + 1;
  switch (name) {
    case 'projectWorkIndexStore:returnLookups':
    case 'projectWorkIndexStore:lookups':
      return args.keys.map(key => {
        if (key.collection === 'sourceBlobs' && oldObjects.has(key.key)) {
          const file = oldObjects.get(key.key);
          return {
            collection: key.collection,
            key: key.key,
            parent: '',
            position: 0,
            value: JSON.stringify({ sha256: file.sha256, size: file.size }),
          };
        }
        return existsSync(rowPath(key.collection, key.key))
          ? JSON.parse(readFileSync(rowPath(key.collection, key.key)))
          : null;
      });
    case 'projectWorkIndexStore:returnViewFiles': {
      const keys = [];
      let view = args.view,
        after = args.after,
        bytes = 0;
      while (view < args.viewIds.length && keys.length < 1000 && bytes < 2 * 1024 * 1024) {
        const path = join(scratch, `view-files-${args.viewIds[view]}.json`);
        const rows = (existsSync(path) ? JSON.parse(readFileSync(path)) : [])
          .filter(row => row.position > after)
          .slice(0, Math.min(100, 1000 - keys.length));
        const limit = Math.min(100, 1000 - keys.length);
        for (const row of rows) {
          keys.push(row.key);
          bytes += row.bytes;
          after = row.position;
        }
        if (rows.length < limit) {
          view++;
          after = -1;
        }
      }
      retainedViewFileRows += keys.length;
      return { keys, view, after, bytes };
    }
    case 'projectWorkIndexStore:viewFiles':
      return { entries: [], cursor: null };
    case 'projectReturnMetadataStore:putBatch':
      for (const [index, body] of args.bodies.entries()) {
        metadataBytes += Buffer.byteLength(body);
        writeFileSync(storedPath(args.key, args.position + index), body);
      }
      return null;
    case 'projectReturnMetadataStore:readBatch':
      return Array.from({ length: args.count }, (_, index) =>
        readFileSync(storedPath(args.key, args.position + index), 'utf8'),
      );
    case 'projectReturnMetadataStore:put':
      writeFileSync(storedPath(args.key, args.position), args.body);
      return null;
    case 'projectReturnIndexStage:batch':
      return true;
    case 'projectReturnCommit:batch': {
      let entries = args.entries;
      if (args.output) {
        const rows = JSON.parse(
          Array.from({ length: args.output.parts }, (_, index) =>
            readFileSync(storedPath(args.output.key, index), 'utf8'),
          ).join(''),
        );
        entries = firstIndexBatch(rows.slice(args.output.skip), { rows: 1000, bytes: 2 * 1024 * 1024 });
      }
      const offset = args.offset + (args.copy ? 0 : entries.length + args.removed.length);
      return {
        ...stage,
        returnCommitDone: !args.copy && offset === args.total,
        returnCommitCopied: true,
        returnCommitOffset: offset,
      };
    }
    case 'projectWork:returnSource':
      return { revision: after.revision + 1 };
    case 'projectWorkIndexStore:snapshotEntries':
      copy = true;
      return { entries: [], cursor: null };
    default:
      throw Error(`Unexpected offline boundary ${name}`);
  }
};
const preparedCursor =
  mode === 'baseline' ? undefined : recordReturnCursor(snapshot, previous, generation, final);
global.gc?.();
const ownerDerived = await parseJsonStream(createReadStream(join(capture, 'owner-derived.json')));
if (mode === 'baseline') {
  const { NativeSource } = await import('../dist/native-source.js');
  const { reviewPaths } = await import('../dist/native-source-review.js');
  const { contextualHunks } = await import('../dist/review-hunks.js');
  const plan = prepareDelta(previous, snapshot, generation, true);
  const statKeys = new Set(ownerDerived.stats.map(([key]) => key));
  const missing = plan.entries
    .filter(row => ['lanes', 'views'].includes(row.collection))
    .filter(row => {
      const v = JSON.parse(row.value);
      return v.head && !statKeys.has(`${v.base}:${v.head}`);
    });
  // Model the seed's retained exact-pair stats from immutable local source bytes.
  const retainedStats = [];
  const source = new NativeSource(join(capture, '../../..'));
  // Reconstruct only the retained View keys the real return queries. Keep this
  // source-derived baseline outside the constrained action process, like stats.
  const stateFiles = new Map();
  const state = head => {
    if (stateFiles.has(head)) {
      const files = stateFiles.get(head);
      stateFiles.delete(head);
      stateFiles.set(head, files);
      return files;
    }
    const files = source.state(head).files;
    stateFiles.set(head, files);
    if (stateFiles.size > 128) stateFiles.delete(stateFiles.keys().next().value);
    return files;
  };
  const states = { get: state, has: head => !!state(head) };
  let availableViewFileRows = 0;
  for (const index of plan.delta.views) {
    const id = snapshot.data.views[index].id;
    const previousIndex = previous.data.views.findIndex(view => view.id === id);
    if (previousIndex < 0) continue;
    const rows = viewIndexEntries(previous.data, states, {
      index: previousIndex,
      positions: new Map(),
    })
      .filter(row => row.collection === 'viewFiles')
      .map(row => ({
        key: row.key,
        position: row.position,
        bytes: Buffer.byteLength(JSON.stringify(row)) + 2048,
      }));
    writeFileSync(join(scratch, `view-files-${id}.json`), JSON.stringify(rows));
    availableViewFileRows += rows.length;
  }
  writeFileSync(join(scratch, 'retained-view-files-count.json'), JSON.stringify(availableViewFileRows));
  for (const row of missing) {
    const value = JSON.parse(row.value),
      key = `${value.base}:${value.head}`;
    const changed = reviewPaths(source.state(value.base).files, source.state(value.head).files).filter(
      file => file.status !== 'unchanged',
    );
    let add = 0,
      del = 0,
      exact = true;
    for (const file of changed) {
      const a = file.before ? source.object(file.before.blob) : Buffer.alloc(0);
      const b = file.after ? source.object(file.after.blob) : Buffer.alloc(0);
      if (a.length > 1024 * 1024 || b.length > 1024 * 1024) {
        exact = false;
        continue;
      }
      const compared = contextualHunks(a, b, 0);
      if (compared.truncated) {
        exact = false;
        continue;
      }
      if (!file.before || !file.after) {
        const text = new TextDecoder().decode(file.before ? a : b);
        const count = text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
        if (file.before) del += count;
        else add += count;
      } else
        for (const hunk of compared.hunks)
          for (const line of hunk.lines) {
            if (line.kind === 'added') add++;
            if (line.kind === 'removed') del++;
          }
    }
    retainedStats.push({
      collection: 'diffstats',
      key,
      parent: '',
      position: 0,
      value: JSON.stringify({
        files: changed.length,
        ...(exact ? { add, del } : {}),
        provenance: 'owner-reported',
        exact,
      }),
    });
  }
  writeFileSync(join(scratch, 'retained-stats.json'), JSON.stringify(retainedStats));
  process.exit(0);
}
for (const row of JSON.parse(readFileSync(join(scratch, 'retained-stats.json'))))
  writeFileSync(rowPath(row.collection, row.key), JSON.stringify(row));
await returnProgress({ runQuery: run, runMutation: run }, stage, input, 'owner', {
  snapshot,
  previous,
  final,
  generationId: generation._id,
  generation,
  partial: true,
  metadataOnly: true,
  ownerDerived,
  cursor: preparedCursor,
});
console.log(
  JSON.stringify({
    status: 'PASS',
    validationMs,
    elapsedMs: Math.round(performance.now() - started),
    peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
    contextPages: pages,
    uncachedIndividualReads: sourcePages,
    cacheBytes: cachedBytes,
    calls,
    copy,
    metadataBytes,
    retainedViewFileRowsRead: retainedViewFileRows,
    retainedViewFileRowsAvailable: JSON.parse(readFileSync(join(scratch, 'retained-view-files-count.json'))),
  }),
);
