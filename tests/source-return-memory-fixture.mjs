// SPDX-License-Identifier: Apache-2.0
// Separate producer and action processes: the action reads a disk fixture and
// precompiled handlers under a 384 MiB V8 heap. resourceUsage measures lifetime
// peak RSS including Node, module imports and loading the stored fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
const { fixture, modules, upload } = await import('./project-exchange-fixture.mjs');
import { digest } from '../dist/hash.js';
import { workSchema } from '../dist/work-types.js';
const mode = process.argv[2],
  directory = process.argv[3],
  s = fixture(),
  intentId = randomUUID(),
  laneId = randomUUID();
const files = Array.from({ length: 1425 }, (_, i) => ({
  path: `synthetic-${i}.ts`,
  blob: digest(`blob-${i}`),
  mode: 'file',
}));
const state = Buffer.from(
  JSON.stringify({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files,
    message: 'Synthetic',
    at: 'now',
  }),
);
const head = digest(state);
if (mode !== 'step') await upload(s, state);
async function backup(id, revision) {
  const data = workSchema.parse({
    schema: 15,
    revision,
    nativeHead: head,
    intents: [
      {
        id: intentId,
        base: head,
        outcome: 'Synthetic memory fixture',
        constraints: '',
        status: 'active',
        createdAt: 'now',
        notes: [],
      },
    ],
    lanes: [
      {
        id: laneId,
        intentId,
        base: head,
        head,
        path: 'lane',
        name: 'Synthetic',
        assignment: '',
        target: '',
        state: 'active',
        createdAt: 'now',
        checkpoints: Array.from({ length: 12000 }, (_, i) => ({
          head,
          parent: head,
          message: `${i} ${'synthetic '.repeat(80)}`,
          at: 'now',
        })),
      },
    ],
    views: [],
  });
  const bytes = Buffer.from(JSON.stringify(data, null, 2)),
    work = await upload(s, bytes);
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision,
      files: [
        { path: 'work.json', ...work },
        { path: `objects/${head}`, sha256: head, size: state.length },
        ...files.map((file, i) => ({
          path: `objects/${file.blob}`,
          sha256: file.blob,
          size: i < 3 ? 32 * 1024 * 1024 : 1000,
        })),
      ],
      unavailable: [],
      coverage: 'Synthetic source pins; source blobs are not needed for metadata preparation.',
    }),
  );
  const root = await upload(s, manifest);
  s.tables.projectBackups.set(id, {
    _id: id,
    _creationTime: 1,
    projectId: 'project',
    operationId: randomUUID(),
    request: 'synthetic',
    nonce: 'synthetic',
    previous: null,
    digest: root.sha256,
    size: root.size,
    status: 'stored',
    transport: 'objects',
    preview: {
      manifestDigest: root.sha256,
      head,
      format: 'native',
      revision,
      intents: 1,
      lanes: 1,
      views: 0,
      runs: 0,
      files: 1427,
      unavailable: 0,
      channels: [],
    },
  });
  return bytes.length;
}
let workBytes;
if (mode !== 'step') {
  await backup('previous', 12000);
  workBytes = await backup('candidate', 12001);
}
s.tables.hostedProjects.get('project').work = {
  backupId: 'previous',
  initialRevision: 12000,
  revision: 12000,
  operationId: randomUUID(),
};
if (mode === 'build') {
  const storage = [];
  for (const [id, file] of s.files) {
    writeFileSync(join(directory, id), Buffer.from(await file.blob.arrayBuffer()));
    storage.push([id, { metadata: file.metadata, type: file.blob.type }]);
  }
  writeFileSync(
    join(directory, 'fixture.json'),
    JSON.stringify({
      tables: Object.entries(s.tables).map(([name, rows]) => [name, [...rows]]),
      storage,
      workBytes,
    }),
  );
  console.log(
    JSON.stringify({
      mode,
      workBytes,
      buildEndHeapUsed: process.memoryUsage().heapUsed,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
  process.exit(0);
}
if (mode === 'step') {
  const saved = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8'));
  // Preserve the fixture's shared database/storage ID sequence across processes.
  const ids = [
    ...saved.storage.map(([id]) => id),
    ...saved.tables.flatMap(([, rows]) => rows.map(([id]) => id)),
  ];
  const nextId = Math.max(...ids.map(id => Number(/^(?:row|file)-(\d+)$/.exec(id)?.[1] ?? -1))) + 1;
  for (let i = 0; i < nextId; i++)
    await s.ctx.db.insert('projectObjects', {
      projectId: 'project',
      digest: '0'.repeat(64),
      size: 0,
      nonce: 'restore-allocator',
      removed: false,
    });
  for (const [name, rows] of saved.tables) {
    const table = s.tables[name];
    table.clear();
    for (const [id, row] of rows) table.set(id, row);
  }
  s.files.clear();
  for (const [id, file] of saved.storage)
    s.files.set(id, {
      metadata: file.metadata,
      blob: new Blob([readFileSync(join(directory, id))], { type: file.type }),
    });
  workBytes = saved.workBytes;
}
const baseline = process.memoryUsage(),
  baselineMaxRssKiB = process.resourceUsage().maxRSS,
  get = s.ctx.storage.get;
let sampledPeakHeap = 0,
  reads = 0;
s.ctx.storage.get = async id => {
  reads++;
  sampledPeakHeap = Math.max(sampledPeakHeap, process.memoryUsage().heapUsed);
  return get(id);
};
const input = {
  projectId: 'project',
  backupId: 'candidate',
  expectedBackupId: 'previous',
  revision: 12000,
  operationId: randomUUID(),
  continuation: true,
};
await assert.rejects(
  modules.projectSourceReturn.returnSource._handler(s.ctx, input),
  e => e.data?.code === 'CLI_UPGRADE_REQUIRED',
);
assert.equal(reads, 0, 'old pushes are rejected before loading retained Work bytes');
const preparedReads = reads;
sampledPeakHeap = Math.max(sampledPeakHeap, process.memoryUsage().heapUsed);
assert(sampledPeakHeap < 384 * 1024 * 1024, `sampled heap ${sampledPeakHeap}`);
console.log(
  JSON.stringify({
    revisions: 12000,
    files: 1425,
    largeFiles: 3,
    workBytes,
    sampledPeakHeap,
    maxRssKiB: process.resourceUsage().maxRSS,
    baselineRss: baseline.rss,
    baselineMaxRssKiB,
    finalRss: process.memoryUsage().rss,
    preparedReads,
    code: 'CLI_UPGRADE_REQUIRED',
  }),
);
