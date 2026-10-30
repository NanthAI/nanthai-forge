// SPDX-License-Identifier: Apache-2.0
// Producer and consumer are separate processes. The measured consumer reads
// immutable object files on demand, matching an action's external object store.
import { readFileSync, writeFileSync, openSync, writeSync, closeSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { workSchema } from '../dist/work-types.js';
import { recordBytes } from '../dist/work-exchange-records.js';
import { buildByteTree } from '../dist/native-exchange-tree.js';
import { moduleUrl } from './convex-module.mjs';
const [mode, directory] = process.argv.slice(2);
if (mode === 'fixture') {
  const state = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: [],
      message: 'Synthetic',
      at: 'now',
    }),
  );
  const head = digest(state);
  writeFileSync(join(directory, head), state);
  const data = workSchema.parse({
    schema: 15,
    revision: 27630,
    nativeHead: head,
    intents: [],
    lanes: [],
    views: [],
  });
  const fields = [],
    hash = createHash('sha256');
  const fd = openSync(join(directory, 'work.json'), 'w');
  let size = 0,
    fieldIndex = 0;
  const append = value => {
    const bytes = Buffer.from(value);
    hash.update(bytes);
    size += bytes.length;
    writeSync(fd, bytes);
  };
  append('{');
  for (const [name, value] of Object.entries(data)) {
    append(`${fieldIndex++ ? ',' : ''}\n  ${JSON.stringify(name)}: `);
    if (name === 'intents') {
      const records = [];
      append('[');
      for (let i = 0; i < 1000; i++) {
        const intent = {
          id: randomUUID(),
          outcome: `Synthetic ${i}`,
          constraints: '',
          base: head,
          status: 'active',
          createdAt: 'now',
          notes: Array.from({ length: 32 }, (_, n) => ({
            kind: 'comment',
            text: `${i}:${n} ${'x'.repeat(3900)}`,
            at: 'now',
          })),
        };
        const bytes = recordBytes(intent),
          sha256 = digest(bytes);
        writeFileSync(join(directory, sha256), bytes);
        records.push({ key: intent.id, sha256, size: bytes.length, refs: [], status: 'active' });
        append(i ? ',\n' : '\n');
        append(bytes);
      }
      append('\n  ]');
      fields.push({ name, records });
    } else if (Array.isArray(value)) {
      append('[]');
      fields.push({ name, records: [] });
    } else {
      append(JSON.stringify(value, null, 2).replaceAll('\n', '\n  '));
      fields.push({ name, value });
    }
  }
  append('\n}');
  closeSync(fd);
  const work = { sha256: hash.digest('hex'), size };
  const objects = new Map();
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision: data.revision,
      files: [
        { path: 'work.json', ...work },
        { path: `objects/${head}`, sha256: head, size: state.length },
      ],
      unavailable: [],
      coverage: 'Synthetic memory benchmark',
    }),
  );
  const records = Buffer.from(
    JSON.stringify({ kind: 'forge-work-records', schema: 2, work, revision: data.revision, fields }),
  );
  const root = Buffer.from(
    JSON.stringify({
      kind: 'forge-native-exchange',
      schema: 2,
      work,
      manifest: buildByteTree(manifest, objects),
      records: buildByteTree(records, objects),
    }),
  );
  objects.set(digest(root), root);
  for (const [key, bytes] of objects) writeFileSync(join(directory, key), bytes);
  writeFileSync(
    join(directory, 'config.json'),
    JSON.stringify({
      work,
      root: { sha256: digest(root), size: root.length },
      manifestDigest: digest(manifest),
      revision: data.revision,
      records: 1000,
    }),
  );
  console.log(JSON.stringify({ workBytes: size, records: 1000 }));
  process.exit(0);
}
if (mode === 'before') {
  const { parseWorkBytes } = await import('../dist/work-metadata.js');
  const { materializeWork } = await import('../dist/work-hosted-index.js');
  const config = JSON.parse(readFileSync(join(directory, 'config.json')));
  const start = performance.now();
  const data = parseWorkBytes(readFileSync(join(directory, 'work.json')));
  const projection = materializeWork(
    data,
    {
      schema: 1,
      kind: 'forge-native-work-backup',
      head: data.nativeHead,
      revision: data.revision,
      files: [],
      id: randomUUID(),
      coverage: 'Synthetic',
      unavailable: [],
    },
    [],
    'objects',
  );
  console.log(
    `MEMORY_RESULT ${JSON.stringify({ workBytes: config.work.size, entries: projection.entries.length, elapsedMs: performance.now() - start, maxRSS: process.resourceUsage().maxRSS * 1024 })}`,
  );
  process.exit(0);
}
const { state } = await import('./hosted-fixture.mjs');
const actions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const s = state([]),
  config = JSON.parse(readFileSync(join(directory, 'config.json')));
const project = {
  _id: 'project',
  _creationTime: 1,
  owner: 'owner',
  key: randomUUID(),
  name: 'Synthetic memory fixture',
  currentBackup: 'backup',
  revision: 1,
  work: {
    backupId: 'backup',
    initialRevision: config.revision,
    revision: config.revision,
    operationId: randomUUID(),
  },
};
const backup = {
  _id: 'backup',
  _creationTime: 1,
  projectId: 'project',
  digest: config.root.sha256,
  size: config.root.size,
  status: 'stored',
  transport: 'objects',
  preview: { format: 'native', revision: config.revision, manifestDigest: config.manifestDigest },
};
s.tables.hostedProjects.set('project', project);
s.tables.projectBackups.set('backup', backup);
// The database is outside a production Node action. Spill indexed payloads to
// files too, rather than measuring an extra 128 MB in-memory fake database.
const insert = s.ctx.db.insert,
  patch = s.ctx.db.patch;
function externalValue(id) {
  const row = s.tables.projectWorkRecords.get(id);
  if (!row || Object.getOwnPropertyDescriptor(row, 'value')?.get) return;
  const path = join(directory, `db-value-${id}`);
  writeFileSync(path, row.value);
  Object.defineProperty(row, 'value', {
    enumerable: true,
    configurable: true,
    get: () => readFileSync(path, 'utf8'),
    set: value => writeFileSync(path, value),
  });
}
s.ctx.db.insert = async (table, fields) => {
  const id = await insert(table, fields);
  if (table === 'projectWorkRecords') externalValue(id);
  return id;
};
s.ctx.db.patch = async (id, fields) => {
  const result = await patch(id, fields);
  externalValue(id);
  return result;
};
const query = s.ctx.runQuery,
  storage = s.ctx.storage.get,
  metadata = s.ctx.db.system.get;
let calls = 0,
  readBytes = 0,
  queryCalls = 0,
  mutationCalls = 0,
  maxStepMs = 0,
  maxMutationMs = 0,
  stepStarted = 0,
  maxStepHeap = 0,
  maxStepBytes = 0,
  dbReadBytes = 0,
  dbWriteBytes = 0;
s.ctx.runQuery = async (ref, args) => {
  queryCalls++;
  const name = getFunctionName(ref);
  if (name === 'projectObjects:resolve')
    return args.digests.map(sha256 => ({
      projectId: 'project',
      digest: sha256,
      size: statSync(join(directory, sha256)).size,
      storageId: sha256,
    }));
  if (name === 'projectWork:get') return project;
  if (name === 'projectWork:events') return { page: [], isDone: true, continueCursor: '' };
  if (name === 'projectBackups:get') return { project, backup };
  const result = await query(ref, args);
  dbReadBytes += Buffer.byteLength(JSON.stringify(result));
  return result;
};
s.ctx.db.system.get = async id =>
  /^[a-f0-9]{64}$/.test(id) && existsSync(join(directory, id))
    ? { _id: id, sha256: id, size: statSync(join(directory, id)).size }
    : metadata(id);
s.ctx.storage.getMetadata = async id => ({ sha256: id, size: statSync(join(directory, id)).size });
s.ctx.storage.get = async id => {
  if (/^[a-f0-9]{64}$/.test(id) && existsSync(join(directory, id))) {
    const bytes = readFileSync(join(directory, id));
    readBytes += bytes.length;
    return new Blob([bytes]);
  }
  return storage(id);
};
const mutate = s.ctx.runMutation;
s.ctx.runMutation = async (ref, args) => {
  mutationCalls++;
  const started = performance.now();
  maxStepBytes = Math.max(maxStepBytes, Buffer.byteLength(JSON.stringify(args)));
  const result = await mutate(ref, args);
  dbWriteBytes += Buffer.byteLength(JSON.stringify(args));
  const finished = performance.now();
  maxMutationMs = Math.max(maxMutationMs, finished - started);
  if (getFunctionName(ref) === 'projectWorkIndexBuildStore:step') {
    // Include reads, projection and staging since the preceding durable page.
    maxStepMs = Math.max(maxStepMs, finished - stepStarted);
    stepStarted = finished;
  }
  maxStepHeap = Math.max(maxStepHeap, process.memoryUsage().heapUsed);
  return result;
};
const start = performance.now();
let result,
  longestActionMs = 0;
do {
  const started = performance.now();
  stepStarted = started;
  calls++;
  result = await actions.ensure._handler(s.ctx, {
    rebuild: true,
    projectId: 'project',
    continuation: calls > 1,
  });
  longestActionMs = Math.max(longestActionMs, performance.now() - started);
} while (typeof result !== 'string');
console.log(
  `MEMORY_RESULT ${JSON.stringify({ workBytes: config.work.size, records: config.records, calls, queryCalls, mutationCalls, readBytes, dbReadBytes, dbWriteBytes, maxStepMs, maxMutationMs, maxStepBytes, maxStepHeap, longestActionMs, elapsedMs: performance.now() - start, maxRSS: process.resourceUsage().maxRSS * 1024, scheduledCleanup: s.scheduled.length })}`,
);
