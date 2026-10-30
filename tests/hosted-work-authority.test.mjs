// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const { workspace } = await import(moduleUrl('../convex/projectWorkIndex.ts'));

test('hosted workspace reads stay constant at twice dogfood size and ignore owner projections', async t => {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    key: 'synthetic',
    name: 'Hosted authority',
    sourceAuthority: { mode: 'server', epoch: 1 },
    work: { generationId: 'generation', backupId: 'backup', revision: 42 },
  });
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    projectId: 'project',
    backupId: 'backup',
    status: 'ready',
    format: HOSTED_WORK_INDEX_FORMAT,
    initialRevision: 42,
    revision: 42,
    metadata: JSON.stringify({ schema: 24, counts: { intents: 1200, lanes: 1120 } }),
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    projectId: 'project',
    digest: 'a'.repeat(64),
    transport: 'objects',
  });
  const counts = {
    intents: 600,
    landingEntries: 575,
    checkpoints: 2800,
    lanes: 560,
    views: 2200,
    runs: 1500,
    states: 2500,
  };
  let bytes = 0;
  for (const [collection, count] of Object.entries(counts))
    for (let i = 0; i < count * 2; i++) {
      const id = `${collection}-${i}`;
      const value = JSON.stringify({ id, retained: 'x'.repeat(8192) });
      bytes += Buffer.byteLength(value);
      s.tables.projectWorkRecords.set(id, {
        _id: id,
        generationId: 'generation',
        collection,
        key: id,
        value,
      });
    }
  assert.ok(bytes > 100_000_000);
  const tables = [],
    get = s.ctx.db.get,
    query = s.ctx.db.query;
  let reads = 0;
  s.ctx.db.get = async id => {
    reads++;
    return get(id);
  };
  s.ctx.db.query = table => {
    tables.push(table);
    assert.equal(table, 'projectWorkHeads', 'workspace never reads history, freshness or owner reports');
    return query(table);
  };
  s.ctx.db.insert = s.ctx.db.patch = s.ctx.db.replace = async () => assert.fail('workspace is read only');
  const heap = process.memoryUsage().heapUsed,
    start = performance.now();
  const result = JSON.parse(await workspace._handler(s.ctx, { projectId: 'project' }));
  const elapsed = performance.now() - start,
    allocated = process.memoryUsage().heapUsed - heap;
  assert.equal(result.revision, 42);
  assert.equal(result.counts.intents, 1200);
  assert.equal(Object.hasOwn(result, 'freshness'), false);
  assert.equal(result.githubMirror, null, 'retained workspace mirror status is still returned');
  assert.equal(reads, 3);
  assert.deepEqual(tables, ['projectWorkHeads']);
  assert.ok(allocated < 16 * 1024 * 1024, `workspace heap delta ${allocated}`);
  t.diagnostic(
    JSON.stringify({
      fixtureBytes: bytes,
      records: s.tables.projectWorkRecords.size,
      convexFunctionCalls: 1,
      documentGets: reads,
      indexedQueries: tables.length,
      writes: 0,
      heapDeltaBytes: allocated,
      wallMs: elapsed,
    }),
  );
});
