// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, openSync, writeSync, closeSync, rmSync, openAsBlob } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { workSchema } from '../dist/work-types.js';
import { metadataRequest } from '../dist/work-metadata.js';
const { page } = await import(moduleUrl('../convex/projectWorkJournal.ts'));
const s = state([]),
  projectKey = randomUUID(),
  head = 'a'.repeat(64),
  skeleton = workSchema.parse({
    schema: 15,
    revision: 0,
    nativeHead: head,
    intents: [],
    lanes: [],
    views: [],
  });
// Build valid 100 MiB Work on disk; fixture construction never assembles full JSON on heap.
const directory = mkdtempSync(join(tmpdir(), 'forge-journal-memory-')),
  path = join(directory, 'work.json'),
  fd = openSync(path, 'wx'),
  [prefix, suffix] = JSON.stringify(skeleton).replace('"intents":[]', '"intents":[CUT]').split('CUT');
writeSync(fd, prefix);
const count = 6000;
for (let i = 0; i < count; i++) {
  const intent = {
    id: randomUUID(),
    outcome: `Synthetic ${i}`,
    base: head,
    constraints: '',
    status: 'active',
    createdAt: 'now',
    notes: Array.from({ length: 5 }, () => ({ kind: 'comment', text: 'x'.repeat(3500), at: 'now' })),
  };
  if (i === 0) workSchema.parse({ ...skeleton, intents: [intent] });
  writeSync(fd, `${i ? ',' : ''}${JSON.stringify(intent)}`);
}
writeSync(fd, suffix);
closeSync(fd);
const work = await openAsBlob(path);
assert(work.size >= 100 * 1024 * 1024);
s.files.set('large-work', { blob: work });
s.tables.projectBackups.set('backup', {
  _id: 'backup',
  projectId: 'project',
  status: 'stored',
  transport: 'objects',
  digest: 'b'.repeat(64),
  size: work.size,
  preview: { format: 'native', head, manifestDigest: 'c'.repeat(64) },
});
s.tables.hostedProjects.set('project', {
  _id: 'project',
  _creationTime: 1,
  owner: 'owner',
  key: projectKey,
  name: '100 MiB synthetic Work',
  revision: 1,
  work: { backupId: 'backup', initialRevision: 0, revision: 122, operationId: randomUUID() },
});
for (let i = 0; i < 122; i++) {
  const command = { action: 'intent', outcome: `Hosted ${i}`, constraints: '', base: head },
    id = randomUUID();
  s.tables.projectWorkEvents.set(id, {
    _id: id,
    _creationTime: i + 1,
    projectId: 'project',
    operationId: id,
    previousRevision: i,
    revision: i + 1,
    request: metadataRequest(command),
    actor: 'owner',
    at: 'now',
    command: JSON.stringify(command),
  });
}
let storageReads = 0,
  calls = 0;
s.ctx.storage.get = async () => {
  storageReads++;
  throw new Error('Full Work must never be read');
};
const dbQuery = s.ctx.db.query;
s.ctx.db.query = table => {
  const q = dbQuery(table),
    paginate = q.paginate;
  q.paginate = async opts => {
    calls++;
    assert.equal(opts.numItems, 50);
    assert.equal(opts.maximumRowsRead, 50);
    assert.equal(opts.maximumBytesRead, 256 * 1024);
    return paginate(opts);
  };
  return q;
};
global.gc();
const before = process.memoryUsage(),
  started = performance.now();
let afterRevision = 0,
  wireBytes = 0;
while (true) {
  const json = await page._handler(s.ctx, { projectId: 'project', afterRevision }),
    result = JSON.parse(json);
  wireBytes += Buffer.byteLength(json);
  assert(result.events.length <= 50);
  assert(Buffer.byteLength(json) < 256 * 1024);
  afterRevision = result.nextRevision;
  if (result.isDone) break;
}
const heapGrowthBytes = process.memoryUsage().heapUsed - before.heapUsed,
  maxRssBytes = process.resourceUsage().maxRSS * 1024;
assert.equal(calls, 3);
assert.equal(storageReads, 0);
assert(heapGrowthBytes < 16 * 1024 * 1024, `heap growth ${heapGrowthBytes}`);
assert(maxRssBytes < 512 * 1024 * 1024, `peak RSS ${maxRssBytes}`);
console.log(
  JSON.stringify({
    logicalWorkBytes: work.size,
    calls,
    storageReads,
    wireBytes,
    heapGrowthBytes,
    maxRssBytes,
    elapsedMs: Math.round(performance.now() - started),
  }),
);

rmSync(directory, { recursive: true, force: true });
