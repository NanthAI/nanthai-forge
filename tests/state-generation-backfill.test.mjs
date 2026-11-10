// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { deriveStateGenerationPage } from '../dist/state/generation-page.js';
import { digest } from '../dist/hash.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
const api = await import(moduleUrl('../convex/projectStateGeneration.ts'));
const actions = await import(moduleUrl('../convex/projectStateGenerationActions.ts'));
const objects = await import(moduleUrl('../convex/projectObjects.ts'));

async function fixture(count, { r2, registered = true, fanIn = 1 } = {}) {
  const s = recordsFixture(),
    { projectId } = await s.setup(),
    identity = { projectId, actor: 'owner', operationId: randomUUID() },
    states = [];
  for (let i = 0; i < count; i++) {
    const parents = i
        ? [
            ...new Set([
              states[i - 1].head,
              ...(fanIn > 1
                ? [states[Math.floor((i - 1) / 2)].head, states[Math.floor((i - 1) / 3)].head]
                : []),
            ]),
          ]
        : [],
      bytes = Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents,
          files: [],
          message: `${i}`,
          at: '2026-01-01T00:00:00.000Z',
        }),
      );
    const head = digest(bytes),
      key = `v1/p/${projectId}/o/${head}`;
    await s.ctx.db.insert('projectObjects', {
      projectId,
      digest: head,
      size: bytes.length,
      nonce: 'synthetic',
      removed: false,
      location: 'r2',
      r2Key: key,
      r2Committed: true,
    });
    r2?.objects.set(`/synthetic/${key}`, bytes);
    states.push({ head, size: bytes.length, parents });
  }
  const candidates =
    registered === 'reverse'
      ? states.toReversed()
      : registered === 'tip'
        ? states.slice(-1)
        : registered
          ? states
          : [];
  for (const state of candidates)
    await s.ctx.db.insert('projectHostedStates', {
      projectId,
      head: state.head,
      size: state.size,
      input: state.head,
      jobId: 'synthetic',
      output: state.head,
    });
  s.ctx.runQuery = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectStateGeneration:page') return s.call(name, api.page, args);
    if (name === 'projectStateGeneration:levels') return s.call(name, api.levels, args);
    if (name === 'projectObjects:resolve') return s.call(name, objects.resolve, args);
    assert.fail(name);
  };
  s.ctx.runMutation = async (ref, args) => {
    const name = getFunctionName(ref);
    assert.equal(name, 'projectStateGeneration:commit');
    return s.call(name, api.commit, args);
  };
  return { ...s, identity, states };
}
test('2500/5000 States: one metadata scan, parents-first page writes, retry-safe and O(pages)', async t => {
  for (const count of [2500, 5000]) {
    const s = await fixture(count);
    let cursor = null,
      done = false,
      pages = 0;
    const start = s.counts.length;
    while (!done) {
      const page = JSON.parse(
        await s.call('preview', api.page, { ...s.identity, cursor, pending: [], preview: true }),
      );
      assert(page.rows.length <= 100);
      const states = page.rows.map(row => s.states.find(state => state.head === row.head));
      const external = [
        ...new Set(
          states.flatMap(state => state.parents).filter(id => !states.some(state => state.head === id)),
        ),
      ];
      const levels = external.length
        ? await s.call('levels', api.levels, { ...s.identity, heads: external })
        : [];
      const derived = deriveStateGenerationPage(
        states,
        new Map(levels.filter(row => row.generation !== null).map(row => [row.head, row.generation])),
      );
      const result = JSON.parse(
        await s.call('apply', api.commit, { ...s.identity, states: derived.assigned }),
      );
      assert.equal(result.assigned, states.length);
      assert.deepEqual(derived.pending, []);
      assert.equal(
        JSON.parse(await s.call('replay', api.commit, { ...s.identity, states: derived.assigned })).assigned,
        0,
      );
      cursor = page.cursor;
      done = page.done;
      pages++;
    }
    assert.equal(pages, Math.ceil(count / 100) + 1);
    const rows = [...s.tables.projectObjects.values()];
    assert.deepEqual(
      rows.map(row => row.stateGeneration),
      Array.from({ length: count }, (_, i) => i + 1),
    );
    const metrics = s.counts.slice(start),
      documents = metrics.reduce((n, c) => n + c.documents, 0),
      writes = metrics.reduce((n, c) => n + c.writes, 0);
    assert.equal(writes, count);
    assert(documents <= count * 4.1);
    t.diagnostic(
      JSON.stringify({
        count,
        pages,
        functions: s.counts.slice(start).length,
        documents,
        writes,
        numericGenerationBytes: count * 8,
      }),
    );
    await assert.rejects(
      s.call('deny', api.page, {
        ...s.identity,
        actor: 'stranger',
        cursor: null,
        pending: [],
        preview: true,
      }),
      error => ['PROJECT_UNAVAILABLE', 'AUTH_REQUIRED'].includes(error.code),
    );
  }
});

for (const order of ['reverse', 'tip'])
  test(`${order}: 100/800/2500-State apply bounds body reads independently of candidate order and missing headers`, async t => {
    const r2 = fakeSourceR2(t);
    for (const count of [100, 800, 2500]) {
      r2.requests.length = 0;
      r2.objects.clear();
      const s = await fixture(count, { r2, registered: order }),
        start = s.counts.length,
        uniqueBytes = s.states.reduce((sum, state) => sum + state.size, 0),
        started = performance.now();
      let cursor = null,
        pending = [],
        done = false,
        steps = 0,
        assigned = 0,
        sourceBytes = 0,
        maxBytes = 0,
        maxStates = 0,
        maxCursorBytes = 0;
      while (!done) {
        const result = JSON.parse(
          await actions.step._handler(s.ctx, {
            ...s.identity,
            cursor,
            pending,
            preview: false,
          }),
        );
        ({ cursor, pending, done } = result);
        steps++;
        assigned += result.assigned;
        sourceBytes += result.sourceBytes;
        maxBytes = Math.max(maxBytes, result.sourceBytes);
        maxStates = Math.max(maxStates, result.states);
        maxCursorBytes = Math.max(maxCursorBytes, Buffer.byteLength(cursor));
        assert(
          steps <= count + Math.ceil(count / 100) * 2 + 2,
          'finite discovery plus parent-ordered verification',
        );
        assert(result.sourceBytes <= 2 * 1024 * 1024);
        assert(result.states <= 100);
        assert(r2.requests.length <= count * 2, 'each State body is read at most twice');
        assert(sourceBytes <= uniqueBytes * 2, 'no unresolved-dependant body amplification');
      }
      assert.equal(assigned, count);
      assert.deepEqual(
        [...s.tables.projectObjects.values()].map(row => row.stateGeneration),
        Array.from({ length: count }, (_, i) => i + 1),
      );
      const metrics = s.counts.slice(start),
        functions = steps + metrics.length,
        documents = metrics.reduce((sum, c) => sum + c.documents, 0),
        writes = metrics.reduce((sum, c) => sum + c.writes, 0);
      t.diagnostic(
        JSON.stringify({
          order,
          count,
          steps,
          functions,
          documents,
          writes,
          gets: r2.requests.length,
          uniqueBytes,
          sourceBytes,
          maxBytes,
          maxStates,
          maxCursorBytes,
          wallMs: performance.now() - started,
          rss: process.memoryUsage().rss,
        }),
      );
      assert(functions <= count * 4.2 + 50, 'page-batched discovery/function bound');
      assert(documents <= count * 12 + 200, 'no repeated unresolved-row scans');
      assert.equal(writes, count);
      assert(
        r2.requests.every(method => method === 'GET'),
        'no byte rewrites',
      );
      assert(maxCursorBytes < count * 200 + 2048, 'continuation holds compact dependency hints only');
      const idle = s.counts.length;
      await Promise.resolve();
      assert.equal(s.counts.length, idle);
      assert.equal(s.tables.projectSourceSteps.size, 0);
    }
  });

test('forged continuation dependency hints cannot mint a generation or bypass current ownership', async t => {
  const r2 = fakeSourceR2(t),
    s = await fixture(5, { r2, registered: 'tip' });
  let cursor = JSON.stringify({
      scan: JSON.stringify({ phase: 'done', page: null, partition: null }),
      deferred: [{ head: s.states.at(-1).head, parents: [] }],
    }),
    pending = [],
    done = false,
    steps = 0;
  await assert.rejects(
    actions.step._handler(s.ctx, { ...s.identity, actor: 'stranger', cursor, pending, preview: false }),
    error => ['PROJECT_UNAVAILABLE', 'AUTH_REQUIRED'].includes(error.data?.code ?? error.code),
  );
  while (!done) {
    const result = JSON.parse(
      await actions.step._handler(s.ctx, { ...s.identity, cursor, pending, preview: false }),
    );
    ({ cursor, pending, done } = result);
    assert(++steps < 15);
  }
  assert.deepEqual(
    [...s.tables.projectObjects.values()].map(row => row.stateGeneration),
    [1, 2, 3, 4, 5],
  );
});

test('5000-State scheduling continuation fits one operator request and still re-verifies each assignment', async t => {
  const r2 = fakeSourceR2(t),
    s = await fixture(5000, { r2, registered: false });
  const scheduled = JSON.parse(
    await actions.step._handler(s.ctx, {
      ...s.identity,
      cursor: JSON.stringify({
        scan: JSON.stringify({ phase: 'done', page: null, partition: null }),
        deferred: s.states.map(({ head, parents }) => ({ head, parents })),
        sizes: s.states.map(({ head, size }) => [head, size]),
      }),
      pending: [],
      preview: false,
    }),
  );
  const request = { ...s.identity, cursor: scheduled.cursor, pending: scheduled.pending, preview: false },
    requestBytes = Buffer.byteLength(JSON.stringify(request));
  assert(
    requestBytes < 240 * 1024,
    'private continuation must fit the operator CLI argument at double scale',
  );
  assert.equal(r2.requests.length, 0, 'scheduling hints prove no level');
  assert([...s.tables.projectObjects.values()].every(row => row.stateGeneration === undefined));
  const result = JSON.parse(await actions.step._handler(s.ctx, request));
  assert.equal(result.assigned, 100);
  assert.equal(r2.requests.length, 100, 'assignments require exact source reads');
  assert.deepEqual(
    [...s.tables.projectObjects.values()].slice(0, 100).map(row => row.stateGeneration),
    Array.from({ length: 100 }, (_, i) => i + 1),
  );
  t.diagnostic(JSON.stringify({ states: 5000, requestBytes, verified: result.assigned }));
});

test('cached size hints retain exact-byte binding and fresh ownership checks', async t => {
  const r2 = fakeSourceR2(t),
    s = await fixture(2, { r2, registered: 'tip' }),
    child = s.states.at(-1),
    cursor = size =>
      JSON.stringify({
        scan: JSON.stringify({ phase: 'done', page: null, partition: null }),
        deferred: [],
        sizes: [[child.head, size]],
        verifying: true,
      });
  await assert.rejects(
    actions.step._handler(s.ctx, {
      ...s.identity,
      actor: 'stranger',
      cursor: cursor(child.size),
      pending: [child.head],
      preview: false,
    }),
    error => ['PROJECT_UNAVAILABLE', 'AUTH_REQUIRED'].includes(error.data?.code ?? error.code),
  );
  await assert.rejects(
    actions.step._handler(s.ctx, {
      ...s.identity,
      cursor: cursor(child.size + 1),
      pending: [child.head],
      preview: false,
    }),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(r2.requests.length, 0);
  assert([...s.tables.projectObjects.values()].every(row => row.stateGeneration === undefined));
});

test('unknown assignment replies resume the original dependency continuation without duplicate writes', async t => {
  const r2 = fakeSourceR2(t),
    s = await fixture(120, { r2, registered: 'reverse' });
  let cursor = null,
    pending = [],
    done = false,
    replayed = false,
    steps = 0;
  while (!done) {
    const input = { ...s.identity, cursor, pending, preview: false };
    let result = JSON.parse(await actions.step._handler(s.ctx, input));
    if (!replayed && result.assigned > 0) {
      result = JSON.parse(await actions.step._handler(s.ctx, input));
      replayed = true;
    }
    ({ cursor, pending, done } = result);
    assert(++steps < 130);
  }
  assert(replayed);
  assert.deepEqual(
    [...s.tables.projectObjects.values()].map(row => row.stateGeneration),
    Array.from({ length: 120 }, (_, i) => i + 1),
  );
  assert.equal(
    s.counts.reduce((n, c) => n + c.writes, 0),
    120,
  );
});

test('missing headers with shared multi-parent dependencies preserve levels and the two-read bound', async t => {
  const r2 = fakeSourceR2(t),
    s = await fixture(800, { r2, registered: 'tip', fanIn: 3 });
  let cursor = null,
    pending = [],
    done = false,
    steps = 0,
    sourceBytes = 0;
  while (!done) {
    const result = JSON.parse(
      await actions.step._handler(s.ctx, { ...s.identity, cursor, pending, preview: false }),
    );
    ({ cursor, pending, done } = result);
    sourceBytes += result.sourceBytes;
    assert(++steps < 850);
    assert(r2.requests.length <= 1600);
  }
  assert(sourceBytes <= 2 * s.states.reduce((sum, state) => sum + state.size, 0));
  assert.deepEqual(
    [...s.tables.projectObjects.values()].map(row => row.stateGeneration),
    Array.from({ length: 800 }, (_, i) => i + 1),
  );
  assert.equal(
    s.counts.reduce((n, c) => n + c.writes, 0),
    800,
  );
  assert(r2.requests.every(method => method === 'GET'));
});
test('real operator action preview is metadata-only; apply resumes missing imported parents without source rewrites', async t => {
  const r2 = fakeSourceR2(t),
    s = await fixture(5, { r2, registered: false });
  await s.ctx.db.insert('projectHostedStates', {
    projectId: s.identity.projectId,
    head: s.states.at(-1).head,
    size: s.states.at(-1).size,
    input: 'synthetic',
    jobId: 'synthetic',
    output: 'synthetic',
  });
  const preview = JSON.parse(
    await actions.step._handler(s.ctx, { ...s.identity, cursor: null, pending: [], preview: true }),
  );
  assert.equal(preview.missing, 1);
  assert.equal(r2.requests.length, 0);
  assert.equal(preview.writes, 0);
  let cursor = null,
    pending = [],
    done = false,
    steps = 0,
    assigned = 0;
  while (!done) {
    const result = JSON.parse(
      await actions.step._handler(s.ctx, { ...s.identity, cursor, pending, preview: false }),
    );
    cursor = result.cursor;
    pending = result.pending;
    done = result.done;
    assigned += result.assigned;
    assert(++steps < 15);
  }
  assert.equal(assigned, 5);
  assert.equal([...s.tables.projectObjects.values()].at(-1).stateGeneration, 5);
  assert(r2.requests.every(method => method === 'GET'));
  assert(![...s.tables.projectHostedRecords.values()].some(row => row.kind === 'job'));
  assert.equal(s.tables.projectSourceSteps.size, 0);
});
test('backfill cycles and missing parent evidence never mint a level', async () => {
  const s = await fixture(2),
    [a, b] = s.states;
  const result = deriveStateGenerationPage(
    [
      { ...a, parents: [b.head] },
      { ...b, parents: [a.head] },
    ],
    new Map(),
  );
  assert.deepEqual(result.assigned, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.pending.length, 2);
  assert([...s.tables.projectObjects.values()].every(row => row.stateGeneration === undefined));
});

test('wide parent levels use 100-record RPC pages with no per-parent call', async t => {
  const r2 = fakeSourceR2(t),
    s = await fixture(0, { r2 }),
    parents = [];
  for (let i = 0; i < 800; i++) {
    const bytes = Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: [],
          message: `root${i}`,
          at: '2026-01-01T00:00:00.000Z',
        }),
      ),
      head = digest(bytes);
    await s.ctx.db.insert('projectObjects', {
      projectId: s.identity.projectId,
      digest: head,
      size: bytes.length,
      nonce: 'synthetic',
      removed: false,
      location: 'r2',
      r2Key: `v1/p/${s.identity.projectId}/o/${head}`,
      r2Committed: true,
      stateGeneration: 1,
    });
    parents.push(head);
  }
  const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents,
        files: [],
        message: 'wide',
        at: '2026-01-01T00:00:00.000Z',
      }),
    ),
    head = digest(bytes),
    key = `v1/p/${s.identity.projectId}/o/${head}`;
  const row = await s.ctx.db.insert('projectObjects', {
    projectId: s.identity.projectId,
    digest: head,
    size: bytes.length,
    nonce: 'synthetic',
    removed: false,
    location: 'r2',
    r2Key: key,
    r2Committed: true,
  });
  await s.ctx.db.insert('projectHostedStates', {
    projectId: s.identity.projectId,
    head,
    size: bytes.length,
    input: head,
    jobId: 'synthetic',
    output: head,
  });
  r2.objects.set(`/synthetic/${key}`, bytes);
  const result = JSON.parse(
    await actions.step._handler(s.ctx, { ...s.identity, cursor: null, pending: [], preview: false }),
  );
  assert.equal(result.assigned, 1);
  assert.equal(s.tables.projectObjects.get(row).stateGeneration, 2);
  assert.equal(s.counts.filter(c => c.name === 'projectStateGeneration:levels').length, 8);
  assert(r2.requests.every(method => method === 'GET'));
});

test('2500-State source-verified operator pass is page-batched, resumable, bounded and idle-free', async t => {
  const r2 = fakeSourceR2(t),
    s = await fixture(2500, { r2 }),
    start = s.counts.length;
  let cursor = null,
    pending = [],
    done = false,
    steps = 0,
    assigned = 0,
    maxBytes = 0,
    maxStates = 0;
  const started = performance.now();
  while (!done) {
    const result = JSON.parse(
      await actions.step._handler(s.ctx, { ...s.identity, cursor, pending, preview: false }),
    );
    cursor = result.cursor;
    pending = result.pending;
    done = result.done;
    steps++;
    assigned += result.assigned;
    maxBytes = Math.max(maxBytes, result.sourceBytes);
    maxStates = Math.max(maxStates, result.states);
    assert(steps <= 27);
    assert(result.sourceBytes <= 2 * 1024 * 1024);
    assert(result.states <= 100);
  }
  assert.equal(assigned, 2500);
  assert.equal(steps, 26);
  const metrics = s.counts.slice(start),
    documents = metrics.reduce((n, c) => n + c.documents, 0),
    writes = metrics.reduce((n, c) => n + c.writes, 0),
    functions = steps + metrics.length;
  assert.equal(writes, 2500);
  assert(functions <= 155);
  assert(documents <= 15000);
  assert.equal(r2.requests.length, 2500);
  assert(r2.requests.every(method => method === 'GET'));
  const idle = s.counts.length;
  await Promise.resolve();
  assert.equal(s.counts.length, idle);
  assert.equal(s.tables.projectSourceSteps.size, 0);
  t.diagnostic(
    JSON.stringify({
      states: 2500,
      steps,
      functions,
      documents,
      writes,
      maxBytes,
      maxStates,
      wallMs: performance.now() - started,
      rss: process.memoryUsage().rss,
    }),
  );
});
