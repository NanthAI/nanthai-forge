// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { fixture, checkpoint, modules } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { read } = await import(moduleUrl('../convex/projectSourceReview.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
async function setup(t) {
  const s = fixture(),
    source = await checkpoint(t, s),
    backupId = await modules.projectExchangeActions.publish._handler(s.ctx, source.input);
  return {
    ...s,
    source,
    input: { projectId: 'project', backupId, base: source.manifest.head, head: source.manifest.head },
  };
}

test('hosted native review reads exact source without loading the retained Work tree', async t => {
  const s = await setup(t),
    query = s.ctx.runQuery,
    workRoot = s.source.tree.root.work.tree.sha256;
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve')
      assert(!args.digests.includes(workRoot), 'source review does not load Work');
    return query(ref, args);
  };
  const index = JSON.parse(await read._handler(s.ctx, s.input));
  assert(index.available);
  assert.equal(index.paths[0].path, 'a.ts');
  const source = JSON.parse(await read._handler(s.ctx, { ...s.input, file: 'a.ts' }));
  assert.equal(source.before.text, 'export const a = 1;\n');
  assert.equal(source.after.text, source.before.text);
  assert.equal(source.backupId, s.input.backupId);
  const linked = JSON.parse(await read._handler(s.ctx, { ...s.input, file: 'a.ts', line: 1 }));
  assert.equal(linked.source.text, source.after.text);
  assert.equal(linked.source.startLine, 1);
  await assert.rejects(read._handler(s.ctx, { ...s.input, file: 'a.ts', line: 99 }), code('BAD_ARGUMENT'));
  s.caller('stranger');
  await assert.rejects(
    read._handler(s.ctx, { ...s.input, file: 'a.ts', line: 1 }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.caller('owner');
  await assert.rejects(
    read._handler(s.ctx, { ...s.input, projectId: 'foreign' }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    read._handler(s.ctx, { ...s.input, head: 'f'.repeat(64) }),
    code('SOURCE_UNAVAILABLE'),
  );
});
test('hosted review rechecks current project access after source retrieval and retains legacy download availability', async t => {
  const s = await setup(t),
    get = s.ctx.storage.get;
  s.ctx.storage.get = async id => {
    const bytes = await get(id);
    s.tables.hostedProjects.get('project').removal = 'deleting';
    return bytes;
  };
  await assert.rejects(read._handler(s.ctx, s.input), code('PROJECT_UNAVAILABLE'));
  delete s.tables.hostedProjects.get('project').removal;
  s.ctx.storage.get = get;
  const backup = s.tables.projectBackups.get(s.input.backupId);
  delete backup.transport;
  const legacy = JSON.parse(await read._handler(s.ctx, s.input));
  assert.equal(legacy.available, false);
  assert.match(legacy.reason, /existing download/);
});
test('anonymous and unrelated callers cannot retrieve review metadata; contributor revocation takes effect during a read', async t => {
  const s = await setup(t),
    before = s.reads();
  s.caller(null);
  await assert.rejects(read._handler(s.ctx, s.input), code('PROJECT_UNAVAILABLE'));
  s.caller('stranger');
  await assert.rejects(read._handler(s.ctx, s.input), code('PROJECT_UNAVAILABLE'));
  assert.equal(s.reads(), before);
  s.tables.projectContributors.set('grant', {
    _id: 'grant',
    projectId: 'project',
    contributor: 'contributor',
  });
  s.caller('contributor');
  assert(JSON.parse(await read._handler(s.ctx, s.input)).available);
  const get = s.ctx.storage.getMetadata;
  s.ctx.storage.getMetadata = async id => {
    const value = await get(id);
    s.tables.projectContributors.delete('grant');
    return value;
  };
  await assert.rejects(read._handler(s.ctx, { ...s.input, file: 'a.ts' }), code('PROJECT_UNAVAILABLE'));
});

test('warm source review reuses immutable bytes but rechecks storage health and current authorization', async t => {
  const s = await setup(t);
  const cold = JSON.parse(await read._handler(s.ctx, { ...s.input, file: 'a.ts' }));
  const before = s.reads();
  const warm = JSON.parse(await read._handler(s.ctx, { ...s.input, file: 'a.ts' }));
  assert.deepEqual(warm.comparison, cold.comparison);
  assert.equal(s.reads(), before, 'warm raw bytes avoid repeated storage body downloads');
  s.caller('stranger');
  await assert.rejects(read._handler(s.ctx, s.input), code('PROJECT_UNAVAILABLE'));
  s.caller('owner');
  s.ctx.storage.getMetadata = async () => null;
  await assert.rejects(read._handler(s.ctx, s.input), code('INVALID_WORK_BACKUP'));
});

test('Map reads stay pinned and recheck authorization, including revocation during retrieval', async t => {
  const s = await setup(t);
  const result = JSON.parse(await read._handler(s.ctx, { ...s.input, map: true }));
  assert.equal(result.map.head, s.input.head);
  assert.deepEqual(result.map.nodes, [], 'unchanged source has no touched neighbourhood');
  s.caller(null);
  await assert.rejects(read._handler(s.ctx, { ...s.input, map: true }), code('PROJECT_UNAVAILABLE'));
  s.caller('owner');
  await assert.rejects(
    read._handler(s.ctx, { ...s.input, head: 'f'.repeat(64), map: true }),
    code('SOURCE_UNAVAILABLE'),
  );
  const get = s.ctx.storage.getMetadata;
  s.ctx.storage.getMetadata = async id => {
    const value = await get(id);
    s.tables.hostedProjects.get('project').removal = 'deleting';
    return value;
  };
  await assert.rejects(read._handler(s.ctx, { ...s.input, map: true }), code('PROJECT_UNAVAILABLE'));
});

test('indexed source reviews read only selected State/file pins, preserving bytes, fallback and current access', async t => {
  const s = await setup(t);
  const baseline = JSON.parse(await read._handler(s.ctx, { ...s.input, file: 'a.ts' }));
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId: s.input.backupId,
    operationId: crypto.randomUUID(),
  });
  const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  const generationId = await indexActions.ensure._handler(s.ctx, { projectId: 'project' });
  const query = s.ctx.runQuery,
    seen = [];
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve') seen.push(...args.digests);
    return query(ref, args);
  };
  const indexed = JSON.parse(await read._handler(s.ctx, { ...s.input, file: 'a.ts' }));
  assert.deepEqual(indexed.comparison, baseline.comparison);
  assert.deepEqual(indexed.after, baseline.after);
  assert.equal(indexed.timings.manifestMs, 0);
  assert(!seen.includes(s.source.input.digest), 'no root/whole retained-object manifest read');
  const allowed = new Set([s.input.head, indexed.file.before.blob, indexed.file.after.blob]);
  assert(
    seen.every(pin => allowed.has(pin)),
    'only the selected State and file blobs are resolved',
  );
  // A missing disposable row keeps the exact original manifest path available.
  const row = [...s.tables.projectWorkRecords.values()].find(
    r => r.collection === 'sourceBlobs' && r.key === s.input.head,
  );
  assert(row);
  s.tables.projectWorkRecords.delete(row._id);
  seen.length = 0;
  const fallback = JSON.parse(await read._handler(s.ctx, { ...s.input, file: 'a.ts' }));
  assert.deepEqual(fallback.comparison, baseline.comparison);
  assert(seen.includes(s.source.input.digest));
  s.tables.projectWorkRecords.set(row._id, row);
  const value = row.value;
  const pin = JSON.parse(value);
  row.value = JSON.stringify({ ...pin, size: pin.size + 1 });
  const repaired = JSON.parse(await read._handler(s.ctx, { ...s.input, file: 'a.ts' }));
  assert.deepEqual(
    repaired.comparison,
    baseline.comparison,
    'an inconsistent derived pin falls back without denying healthy source',
  );
  row.value = value;
  s.caller('stranger');
  await assert.rejects(read._handler(s.ctx, s.input), code('PROJECT_UNAVAILABLE'));
  s.caller('owner');
  const get = s.ctx.storage.getMetadata;
  s.ctx.storage.getMetadata = async id => {
    const result = await get(id);
    s.tables.hostedProjects.get('project').removal = 'deleting';
    return result;
  };
  await assert.rejects(read._handler(s.ctx, { ...s.input, file: 'a.ts' }), code('PROJECT_UNAVAILABLE'));
  assert(generationId);
});
