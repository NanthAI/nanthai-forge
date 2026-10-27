// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import './projectWorkIndex-progress-fixture.mjs'; // Compile outside the measured action process.
test('all post-parent index phases fit the dogfood call and action memory budgets', async t => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--max-old-space-size=384', 'tests/projectWorkIndex-phases-worker.mjs'],
    {
      env: { ...process.env, FORGE_TEST_PRECOMPILED: '1' },
      maxBuffer: 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout.match(/PHASE_RESULT (.+)/)[1]);
  assert(result.remaining.calls <= 15000, JSON.stringify(result));
  assert(result.maxSourceWindowBytes <= 2 * 1024 * 1024, JSON.stringify(result));
  assert(result.maxRpcBytes < 600000);
  assert.equal(result.counts.views, 2167);
  assert.equal(result.counts.runs, 1471);
  assert.equal(result.counts.events, 5000);
  assert.equal(result.counts.notes, 5000);
  assert.equal(result.counts.sourceBlobs, 32000);
  assert.equal(result.counts.sourceTreePaths, 30);
  assert.equal(result.calls['projectWork:events'], 100);
  t.diagnostic(JSON.stringify(result));
});

test('a resumed dogfood coordinator action stays below 512 MiB without retaining historical database rows', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'forge-phase-memory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pins = join(directory, 'pins.json');
  await promisify(execFile)(process.execPath, ['tests/projectWorkIndex-phases-worker.mjs', 'fixture', pins], {
    env: { ...process.env, FORGE_TEST_PRECOMPILED: '1' },
    maxBuffer: 1024 * 1024,
  });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--expose-gc', '--max-old-space-size=128', 'tests/projectWorkIndex-phases-worker.mjs', 'action', pins],
    {
      env: { ...process.env, FORGE_TEST_PRECOMPILED: '1' },
      maxBuffer: 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout.match(/ACTION_RESULT (.+)/)[1]);
  assert.equal(result.pending, true);
  assert(result.maxRssBytes < 512 * 1024 * 1024, JSON.stringify(result));
  assert(result.maxSourceWindowBytes <= 2 * 1024 * 1024);
  t.diagnostic(JSON.stringify(result));
});

const { randomUUID } = await import('node:crypto');
const { getFunctionName } = await import('convex/server');
const { moduleUrl } = await import('./convex-module.mjs');
const { metadataRequest } = await import('../dist/work-metadata.js');
const { indexedRecord } = await import('../dist/work-hosted-index.js');
const { replayStep } = await import(moduleUrl('../convex/projectWorkIndexBuildJournal.ts'));
const buildStore = await import(moduleUrl('../convex/projectWorkIndexBuildStore.ts'));
const { state } = await import('./hosted-fixture.mjs');
const { fixture, upload } = await import('./project-exchange-fixture.mjs');
const states = await import(moduleUrl('../convex/projectWorkIndexBuildStates.ts'));
const diffstats = await import(moduleUrl('../convex/projectWorkIndexBuildDiffstats.ts'));
const { viewContext } = await import(moduleUrl('../convex/projectWorkIndexBuildProjection.ts'));

function journalFixture(count = 50) {
  const intentId = randomUUID(),
    head = 'a'.repeat(64);
  const selected = { projectId: 'project', owner: 'owner', generationId: 'generation' };
  const project = { key: randomUUID(), work: { initialRevision: 1, revision: count + 1 } };
  const backup = { digest: 'b'.repeat(64) };
  const initial = indexedRecord('intents', intentId, '', 0, {
    id: intentId,
    outcome: 'Synthetic',
    base: head,
    status: 'active',
    notes: [],
    noteCount: 0,
    createdAt: 'now',
    constraints: '',
  });
  const rows = new Map(initial.map(row => [JSON.stringify([row.collection, row.key]), row]));
  const events = Array.from({ length: count }, (_, i) => {
    const command = { action: 'note', intentId, kind: 'comment', text: `Note ${i}` };
    return {
      operationId: randomUUID(),
      revision: i + 2,
      previousRevision: i + 1,
      actor: 'owner',
      at: 'now',
      command: JSON.stringify(command),
      request: metadataRequest(command),
    };
  });
  const calls = [];
  const ctx = {
    runQuery: async (ref, args) => {
      calls.push(getFunctionName(ref));
      if (getFunctionName(ref) === 'projectWork:events')
        return { page: events, isDone: true, continueCursor: 'end' };
      assert.equal(getFunctionName(ref), 'projectWorkIndexBuildStore:lookups');
      assert(args.keys.length <= 100);
      return args.keys.map(key => rows.get(JSON.stringify([key.collection, key.key])) ?? null);
    },
  };
  const generation = {
    metadata: JSON.stringify({
      schema: 17,
      sourceKind: 'native',
      sourceHead: head,
      counts: { intents: 1, events: 0, notes: 0 },
    }),
  };
  const cursor = {
    phase: 'journal',
    field: 0,
    record: 0,
    source: 0,
    replayRevision: 1,
    journalCursor: 'legacy-one-event-cursor',
  };
  return { ctx, selected, project, backup, generation, events, rows, calls, cursor, intentId };
}

test('journal page applies repeated keys in order, retries exact output, and retains legacy cursors', async () => {
  const f = journalFixture();
  const run = cursor => replayStep(f.ctx, f.selected, {}, f.backup, f.generation, f.project, cursor);
  const after = structuredClone(f.cursor),
    result = await run(after);
  assert.equal(after.replayRevision, 51);
  assert.equal(after.phase, 'cleanup');
  const intent = result.entries.find(row => row.collection === 'intents');
  assert.equal(JSON.parse(intent.value).noteCount, 50);
  assert.deepEqual(
    result.entries.filter(row => row.collection === 'notes').map(row => JSON.parse(row.value).text),
    Array.from({ length: 50 }, (_, i) => `Note ${i}`),
  );
  assert.deepEqual(
    await run(structuredClone(f.cursor)),
    result,
    'lost uncommitted reply repeats the exact page',
  );
  assert.equal(
    f.calls.filter(name => name === 'projectWorkIndexBuildStore:lookups').length,
    2,
    'one deduplicated exact-key window per page, rather than one RPC per event key',
  );
  f.events[4].previousRevision++;
  await assert.rejects(run(structuredClone(f.cursor)), e => e.code === 'INVALID_WORK_JOURNAL');
});

test('build lookup windows retain current authority and project isolation', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('project', { _id: 'project', owner: 'owner' });
  s.tables.projectWorkGenerations.set('generation', { _id: 'generation', projectId: 'project' });
  const args = { projectId: 'project', owner: 'owner', generationId: 'generation', keys: [] };
  assert.deepEqual(await buildStore.lookups._handler(s.ctx, args), []);
  await assert.rejects(
    buildStore.lookups._handler(s.ctx, { ...args, owner: 'stranger' }),
    e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE',
  );
  s.tables.hostedProjects.set('other', { _id: 'other', owner: 'owner' });
  await assert.rejects(
    buildStore.lookups._handler(s.ctx, { ...args, projectId: 'other' }),
    e => e.code === 'WORK_STALE',
  );
  s.tables.hostedProjects.get('project').removal = 'deleting';
  await assert.rejects(
    buildStore.lookups._handler(s.ctx, args),
    e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE',
  );
});

test('batched State and file reads preserve exact pins, incomplete bytes, and fresh authority', async () => {
  const s = fixture();
  const before = await upload(s, Buffer.from('old\n')),
    after = await upload(s, Buffer.from('new\n'));
  const makeState = async blob =>
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
  const a = await makeState(before),
    b = await makeState(after);
  const request = { projectId: 'project', actor: 'owner', requests: [{ before: a, after: b, pins: [] }] };
  const [changed] = await states.batch._handler(s.ctx, request);
  assert.deepEqual(changed.paths, ['one']);
  const files = { projectId: 'project', actor: 'owner', files: [{ before, after }, { after }, { before }] };
  assert.deepEqual(await diffstats.compare._handler(s.ctx, files), [
    { add: 1, del: 1, exact: true },
    { add: 1, del: 0, exact: true },
    { add: 0, del: 1, exact: true },
  ]);
  await assert.rejects(
    states.batch._handler(s.ctx, {
      ...request,
      requests: [{ before: { ...a, size: a.size + 1 }, after: b, pins: [] }],
    }),
  );
  s.tables.hostedProjects.get('project').removal = 'deleting';
  await assert.rejects(
    states.batch._handler(s.ctx, request),
    e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    diffstats.compare._handler(s.ctx, files),
    e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE',
  );
});

test('acceptance payload parts hydrate in exact lookup windows', async () => {
  const view = {
    id: randomUUID(),
    intentId: randomUUID(),
    inputs: [],
    dependencies: [],
    status: 'clean',
    base: 'a'.repeat(64),
    head: 'a'.repeat(64),
    at: 'now',
  };
  const acceptance = { id: randomUUID(), viewId: view.id, extension: 'x'.repeat(800000) };
  const rows = indexedRecord('_buildHostedAcceptance', acceptance.id, view.id, 0, acceptance);
  const parts = new Map(rows.slice(1).map(row => [row.key, row]));
  let lookups = 0;
  const ctx = {
    runQuery: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectWorkIndexBuildStore:lookups');
      lookups++;
      return args.keys.map(key => parts.get(key.key) ?? null);
    },
  };
  const exchange = {
    records: {
      schema: 2,
      revision: 1,
      fields: [
        { name: 'schema', value: 17 },
        { name: 'revision', value: 1 },
        { name: 'nativeHead', value: view.head },
        { name: 'hostedChannelMoves', records: [] },
      ],
    },
  };
  const data = await viewContext(ctx, {}, exchange, view, view.id, async collection =>
    collection === '_buildHostedAcceptance' ? [rows[0]] : [],
  );
  assert.deepEqual(data.hostedChannelMoves, [acceptance]);
  assert.equal(lookups, Math.ceil(parts.size / 100));
  assert(parts.size > 1);
});

test('lookup byte prefixes retain every payload part and cleanup leaves the default Intent untouched', async () => {
  const s = state([]);
  const selected = { projectId: 'project', owner: 'owner', generationId: 'generation' };
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    work: { backupId: 'backup', revision: 1 },
  });
  const cursor = JSON.stringify({ phase: 'cleanup', field: 0, record: 0, source: 0, cleanup: 0 });
  const generation = {
    _id: 'generation',
    projectId: 'project',
    status: 'building',
    backupId: 'backup',
    revision: 1,
    ensureCursor: cursor,
    nextBatch: 0,
    metadata: JSON.stringify({ schema: 17, counts: {}, defaultIntentId: 'retained-default' }),
  };
  s.tables.projectWorkGenerations.set('generation', generation);
  const keys = Array.from({ length: 100 }, (_, i) => ({ collection: 'intents:payload', key: `part:${i}` }));
  for (const key of keys)
    s.tables.projectWorkRecords.set(key.key, {
      _id: key.key,
      projectId: 'project',
      generationId: 'generation',
      ...key,
      parent: 'payload',
      position: 0,
      value: 'x'.repeat(12000),
    });
  const first = await buildStore.lookups._handler(s.ctx, { ...selected, keys });
  assert(first.length > 0 && first.length < 100);
  assert(Buffer.byteLength(JSON.stringify(first)) <= 500000);
  const { buildLookups } = await import(moduleUrl('../convex/projectWorkIndexBuildLookup.ts'));
  const all = await buildLookups(
    { runQuery: (_ref, args) => buildStore.lookups._handler(s.ctx, args) },
    selected,
    keys,
  );
  assert.deepEqual(
    all.map(row => row.key),
    keys.map(key => key.key),
  );
  const query = s.ctx.db.query;
  let intentQueries = 0;
  s.ctx.db.query = table => {
    const q = query(table),
      withIndex = q.withIndex;
    q.withIndex = (name, callback) =>
      withIndex(name, fields => {
        const eq = fields.eq.bind(fields);
        fields.eq = (key, value) => {
          if (key === 'collection' && value === 'intents') intentQueries++;
          return eq(key, value);
        };
        return callback(fields);
      });
    return q;
  };
  const result = await buildStore.step._handler(s.ctx, {
    ...selected,
    expected: cursor,
    cursor: JSON.stringify({ ...JSON.parse(cursor), cleanup: 1 }),
    entries: [],
    cleanup: '_buildSource',
  });
  assert.equal(intentQueries, 0);
  assert.equal(JSON.parse(result.metadata).defaultIntentId, 'retained-default');
});
