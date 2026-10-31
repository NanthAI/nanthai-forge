// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs } from './convex-args.mjs';
// These checks hook Convex storage reads (memo, metadata, tampering), which still serve legacy
// rows; R2 reads are covered by tests/r2-read-path.test.mjs.
import { fixture, legacyObject as upload } from './project-exchange-fixture.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const store = await import(moduleUrl('../convex/projectViewDiffstatStore.ts'));
const { compute } = await import(moduleUrl('../convex/projectViewDiffstats.ts'));
const indexStore = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));

async function setup() {
  const s = fixture(),
    old = await upload(s, Buffer.from('old\n')),
    next = await upload(s, Buffer.from('new\nline\n'));
  const state = async blob =>
    upload(
      s,
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: [{ path: 'one', blob: blob.sha256, mode: 'file' }],
          message: '',
          at: 'now',
        }),
      ),
    );
  const base = await state(old),
    head = await state(next);
  Object.assign(s.tables.hostedProjects.get('project'), {
    work: {
      backupId: 'backup',
      generationId: 'generation',
      revision: 1,
      initialRevision: 0,
      operationId: 'synthetic',
    },
  });
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    _creationTime: 1,
    projectId: 'project',
    backupId: 'backup',
    status: 'ready',
    format: HOSTED_WORK_INDEX_FORMAT,
    revision: 1,
    initialRevision: 0,
    nextBatch: 0,
    metadata: '{}',
  });
  s.tables.projectWorkRecords.set('view', {
    _id: 'view',
    _creationTime: 1,
    projectId: 'project',
    generationId: 'generation',
    collection: 'views',
    key: 'view',
    parent: '',
    position: 0,
    value: JSON.stringify({ id: 'view', base: base.sha256, head: head.sha256, status: 'clean' }),
  });
  for (const pin of [base, head, old, next])
    s.tables.projectWorkRecords.set(pin.sha256, {
      _id: pin.sha256,
      _creationTime: 1,
      projectId: 'project',
      generationId: 'generation',
      collection: 'sourceBlobs',
      key: pin.sha256,
      parent: '',
      position: 0,
      value: JSON.stringify(pin),
    });
  const calls = [],
    run = s.ctx.runQuery;
  s.ctx.runMutation = s.ctx.runQuery = async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push(name);
    const [module, method] = name.split(':');
    const selected = { projectViewDiffstatStore: store, projectWorkIndexStore: indexStore }[module]?.[method];
    if (selected) {
      checkArgs(selected, args, name);
      return selected._handler(s.ctx, args);
    }
    return run(ref, args);
  };
  s.ctx.runAction = () => assert.fail('one opened View uses one action, with bounded inline comparisons');
  const input = { projectId: 'project', generationId: 'generation', viewId: 'view' };
  return { s, input, calls, base, head };
}

test('opening a missing View diffstat computes once, saves it and makes the second open metadata-only', async t => {
  const { s, input, calls } = await setup();
  checkArgs(compute, input, 'projectViewDiffstats:compute');
  let reads = 0;
  const get = s.ctx.storage.get;
  s.ctx.storage.get = async id => {
    reads++;
    return get(id);
  };
  const stats = JSON.parse(await compute._handler(s.ctx, input));
  assert.deepEqual(stats, { files: 1, add: 2, del: 1, exact: true, provenance: 'server-computed' });
  assert(reads >= 4);
  const before = reads,
    prior = calls.length;
  t.diagnostic(
    JSON.stringify({
      firstOpenInternalCalls: prior,
      sourceReads: reads,
      firstOpenActions: 1,
      secondOpenCompareCalls: 0,
    }),
  );
  assert.deepEqual(JSON.parse(await compute._handler(s.ctx, input)), stats);
  assert.equal(reads, before);
  assert.deepEqual(calls.slice(prior), ['projectViewDiffstatStore:read']);
  assert.equal(
    [...s.tables.projectWorkRecords.values()].filter(row => row.collection === 'diffstats').length,
    1,
  );
  assert.equal(s.scheduled.length, 0, 'idle schedules nothing');
});

test('owner counts retain their label until an explicit server comparison replaces them', async () => {
  const { s, input, base, head } = await setup();
  const value = { files: 1, add: 99, del: 99, exact: true, provenance: 'owner-reported' };
  s.tables.projectWorkRecords.set('stats', {
    _id: 'stats',
    _creationTime: 1,
    projectId: 'project',
    generationId: 'generation',
    collection: 'diffstats',
    key: `${base.sha256}:${head.sha256}`,
    parent: '',
    position: 0,
    value: JSON.stringify(value),
  });
  const get = s.ctx.storage.get;
  s.ctx.storage.get = () => assert.fail('owner counts need no source bytes');
  assert.deepEqual(JSON.parse(await compute._handler(s.ctx, input)), value);
  s.ctx.storage.get = get;
  assert.equal(JSON.parse(await compute._handler(s.ctx, { ...input, recomputeOwner: true })).add, 2);
  assert.equal(JSON.parse(s.tables.projectWorkRecords.get('stats').value).provenance, 'server-computed');
});

test('lazy reads and saves recheck actor, project and current generation, including revocation during IO', async () => {
  const { s, input } = await setup();
  const code = expected => error => (error.data?.code ?? error.code) === expected;
  s.caller(null);
  await assert.rejects(compute._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  s.caller('stranger');
  await assert.rejects(compute._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  s.caller('owner');
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  await assert.rejects(compute._handler(s.ctx, { ...input, projectId: 'other' }), code('WORK_STALE'));
  await assert.rejects(compute._handler(s.ctx, { ...input, generationId: 'different' }), code('WORK_STALE'));
  const get = s.ctx.storage.get;
  s.ctx.storage.get = async id => {
    const bytes = await get(id);
    s.tables.hostedProjects.get('project').removal = 'deleting';
    return bytes;
  };
  await assert.rejects(compute._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  assert.equal(
    [...s.tables.projectWorkRecords.values()].some(row => row.collection === 'diffstats'),
    false,
  );
  delete s.tables.hostedProjects.get('project').removal;
  await assert.rejects(
    store.save._handler(s.ctx, {
      ...input,
      actor: 'stranger',
      base: 'a',
      head: 'b',
      stats: { files: 0, exact: false, provenance: 'server-computed' },
    }),
    code('PROJECT_UNAVAILABLE'),
  );
});
