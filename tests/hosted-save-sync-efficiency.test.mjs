// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { controls, environment } from './hosted-source-efficiency-fixture.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { sourceDispatch } from '../dist/hosted-source-job-controller.js';
import { digest } from '../dist/hash.js';
import { composeAgentSource, selectAgentLane, agentState } from '../dist/hosted-agent-source.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

function checkout(t, s, entry, state, changed = true) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-efficiency-')),
    root = join(directory, 'checkout');
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: s.projectId,
        laneId: entry.laneId,
        intentId: s.intentId,
        head: entry.head,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head: s.baseline.sha256, receiptId: 'main-0' },
        authority: { mode: 'server', epoch: 1 },
      },
      state,
      scope: [],
      materialized: state.files.slice(0, 10).map(file => file.path),
    }),
  );
  for (const file of state.files.slice(0, 10))
    writeFileSync(
      join(root, file.path),
      changed ? `first\nchanged-${file.path}\nlast\n` : s.objects.get(file.blob),
    );
  return root;
}
function dogfood(s) {
  // Unselected histories must not change reads/calls. Rows deliberately contain
  // no valid selected source pins, so accidental hydration fails the test too.
  for (const [kind, count] of [
    ['intent', 600],
    ['lane', 560],
    ['save', 2800],
    ['candidate', 2200],
    ['job', 1500],
  ])
    for (let i = 0; i < count; i++)
      s.insert('projectHostedRecordHeads', {
        projectId: s.projectId,
        kind,
        key: `unselected-${kind}-${i}`,
        version: 0,
        parent: '',
        status: 'unselected',
        recordId: `unselected-body-${i}`,
      });
  for (let i = 0; i < 575; i++)
    s.insert('projectHostedAcceptances', {
      projectId: s.projectId,
      receiptId: `unselected-${i}`,
      submissionId: 'unselected',
      attemptId: 'unselected',
      sequence: i,
      value: '{}',
    });
  for (let i = 0; i < 2500; i++)
    s.insert('projectHostedStates', {
      projectId: s.projectId,
      head: `unselected-${i}`,
      size: 0,
      input: '{}',
      output: '{}',
      jobId: 'unselected',
    });
  for (let i = 0; i < 32000; i++)
    s.insert('projectObjects', {
      projectId: s.projectId,
      digest: `unselected-${i}`,
      size: 0,
      nonce: 'synthetic',
      removed: false,
    });
}
async function changedSave(t, legacy, scale = false, provider = 'synthetic') {
  environment(t);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  process.env.FORGE_SOURCE_PROVIDER = 'convex';
  const s = await composeFixture();
  const files = Array.from({ length: 3000 }, (_, i) =>
    s.file(`f${String(i).padStart(4, '0')}`, `first\noriginal-${i}\nlast\n`),
  );
  const baseline = s.state(files),
    entry = await s.lane(baseline),
    state = JSON.parse(s.objects.get(baseline.sha256));
  const root = checkout(t, s, entry, state);
  if (scale) dogfood(s);
  const c = controls(t, s);
  s.patch('hostedProjects', s.projectId, { r2Writes: true });
  const exchange = new ConvexExchange(
    'https://fixture.invalid',
    'synthetic',
    s.projectId,
    randomUUID(),
    null,
  );
  exchange.client = c.client;
  const command = { operationId: randomUUID(), message: 'ten-file save' };
  s.counts.length = 0;
  const overlapWrites = () =>
    s.counts.reduce(
      (total, row) => total + row.written.filter(table => table === 'projectHostedOverlapLanes').length,
      0,
    );
  const started = performance.now();
  const transport = legacy
    ? {
        projectId: s.projectId,
        client: c.client,
        uploadFile: exchange.uploadFile.bind(exchange),
        upload: exchange.upload.bind(exchange),
        missing: exchange.missing.bind(exchange),
      }
    : exchange;
  const pending = await saveHostedLane(root, command, transport);
  const args = { projectId: s.projectId, jobId: pending.jobId };
  if (provider === 'convex') {
    await c.call('projectConvexSource:dispatch', args);
    await c.call('projectConvexSource:step', { ...args, step: 0 });
    await c.call('projectHostedSaveJobs:complete', args);
    const terminal = await saveHostedLane(root, command, exchange);
    const output = terminal.outcome.result;
    assert.equal(JSON.parse(s.objects.get(output.head)).files.length, 3000);
    const stats = {
      ...c.stats(),
      overlapWrites: overlapWrites(),
      storageCalls: c.storageCalls(),
      wallMs: performance.now() - started,
    };
    stats.totalCalls = stats.calls + stats.storageCalls;
    return { stats, calls: c.calls, s, c, root, command, transport };
  }
  const owner = randomUUID();
  await c.call('projectSourceJobApi:claim', { ...args, owner, leaseMs: 60000 });
  const job = JSON.parse(
    await c.call('projectSourceJobApi:advance', {
      ...args,
      owner,
      token: 1,
      command: JSON.stringify({ kind: 'reserve', recovery: false }),
    }),
  );
  const dispatch = sourceDispatch(s.projectId, job);
  const reservation = { ...args, input: JSON.stringify(dispatch), token: randomUUID() };
  await c.call('projectSourceProviderApi:reserve', reservation);
  await c.call('projectSourceProviderApi:created', { ...reservation, executionId: 'synthetic-execution' });
  const callback = async result => {
    const body = {
      schema: 1,
      projectId: s.projectId,
      jobId: dispatch.jobId,
      operationId: dispatch.operationId,
      attempt: dispatch.attempt,
      fence: dispatch.fence,
      authorityEpoch: 1,
      inputDigest: dispatch.inputDigest,
      provider: dispatch.provider,
      worker: dispatch.worker,
      runtime: dispatch.runtime,
      executionId: 'synthetic-execution',
      result,
    };
    await c.call('projectSourceJobApi:callback', {
      projectId: s.projectId,
      callback: JSON.stringify(body),
    });
  };
  await callback({ status: 'heartbeat', sequence: 1 });
  const http = c.http(dispatch);
  const worker = legacy ? { describe: http.describe, read: http.read, upload: http.upload } : http;
  const output = await buildHostedSourceState(dispatch.input, worker);
  await callback({ status: 'completed', output: output.output });
  await c.call('projectHostedSaveJobs:complete', args);
  const stats = {
    ...c.stats(),
    overlapWrites: overlapWrites(),
    wallMs: performance.now() - started,
    rssBytes: process.memoryUsage().rss,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    worker: output.metrics,
  };
  assert(output.metrics.maxChunkBytes <= 1024 * 1024);
  assert(output.metrics.maxUploadWindowBytes <= 8 * 1024 * 1024);
  const result = JSON.parse(s.objects.get(output.head));
  assert.equal(result.files.length, 3000);
  assert.deepEqual(result.files[2999], files[2999]);
  assert.equal(result.files[0].blob, digest(`first\nchanged-${files[0].path}\nlast\n`));
  assert(!s.counts.some(row => row.touched.includes('projectWorkRecords')));
  return { stats, calls: c.calls, s, c, root, command, transport };
}

test('ten changed files in a 3,000-file tree fit the complete save budget at dogfood history size', async t => {
  await t.test('retained recipe and single-transfer path', async t => {
    const run = await changedSave(t, true);
    t.diagnostic(
      JSON.stringify({
        before: run.stats,
        functions: Object.fromEntries(
          [...new Set(run.calls)].map(name => [name, run.calls.filter(value => value === name).length]),
        ),
      }),
    );
    assert(run.stats.calls > 100);
  });
  await t.test('batched raw path', async t => {
    const run = await changedSave(t, false, true);
    t.diagnostic(
      JSON.stringify({
        after: run.stats,
        functions: Object.fromEntries(
          [...new Set(run.calls)].map(name => [name, run.calls.filter(value => value === name).length]),
        ),
      }),
    );
    assert(run.stats.calls <= 30, JSON.stringify(run.calls));
    assert.equal(run.stats.overlapWrites, 1, 'one atomic path projection update per changed save');
    assert(run.stats.writes - run.stats.overlapWrites <= 98, JSON.stringify(run.stats));
    const prior = run.c.calls.length;
    await saveHostedLane(run.root, run.command, run.transport);
    assert.equal(run.c.calls.length - prior, 1, 'same-op terminal retry only prepares/returns the receipt');
  });
});

test('unchanged save has no object or worker calls', async t => {
  environment(t);
  const s = await composeFixture(),
    entry = await s.lane(s.baseline);
  const root = checkout(t, s, entry, JSON.parse(s.objects.get(s.baseline.sha256)), false);
  const c = controls(t, s),
    exchange = new ConvexExchange('https://fixture.invalid', 'synthetic', s.projectId, randomUUID(), null);
  exchange.client = c.client;
  s.counts.length = 0;
  const terminal = await saveHostedLane(root, { operationId: randomUUID(), message: 'unchanged' }, exchange);
  assert.equal(terminal.outcome.result.unchanged, true);
  assert.equal(c.calls.length, 2);
  t.diagnostic(JSON.stringify({ unchanged: c.stats() }));
});

test('20-input compose setup selects and describes in page calls while retaining order', async t => {
  const f = agentFixture(t),
    inputs = Array.from({ length: 20 }, () => ({ laneId: randomUUID() }));
  const session = {
    address: f.address,
    capabilities: f.caps,
    exchange: f.exchange,
    marker: () => null,
    main: async () => f.main,
    journal: { retain: async (_key, build) => build() },
    query: async (name, args) =>
      JSON.parse(
        await f.exchange.client.query((await import('convex/server')).makeFunctionReference(name), {
          projectId: f.address.projectId,
          ...args,
        }),
      ),
    mutation: async (name, args) =>
      JSON.parse(
        await f.exchange.client.mutation((await import('convex/server')).makeFunctionReference(name), {
          projectId: f.address.projectId,
          ...args,
        }),
      ),
  };
  for (const item of inputs) {
    const lane = await selectAgentLane(session, item.laneId);
    await agentState(session, lane.head);
  }
  const beforeSelectionCalls = f.calls.length;
  f.calls.length = 0;
  await composeAgentSource(session, { inputs, dependencies: [], message: 'budget' }, randomUUID());
  assert.equal(f.calls.filter(c => c.name === 'projectHostedComposeSelection:page').length, 1);
  assert(
    !f.calls.some(c => ['projectHostedLanes:select', 'projectObjectDownloads:describe'].includes(c.name)),
  );
  assert(f.calls.length <= 10);
  t.diagnostic(JSON.stringify({ beforeSelectionCalls, afterSetupCalls: f.calls.length }));
});

test('sync batches missing merge objects at 3,000-file scale and leaves unchanged blobs unread', async t => {
  const { syncFixture } = await import('./hosted-sync-fixture.mjs');
  const { sourceDispatch } = await import('../dist/hosted-source-job-controller.js');
  const run = async (t, legacy) => {
    environment(t);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const s = await syncFixture();
    const files = Array.from({ length: 3000 }, (_, i) =>
      s.file(`f${String(i).padStart(4, '0')}`, `a-${i}\nb\nc\n`),
    );
    const base = s.state(files),
      leftFiles = [...files],
      rightFiles = [...files];
    for (let i = 0; i < 120; i++) {
      leftFiles[i] = s.file(files[i].path, `A-${i}\nb\nc\n`);
      rightFiles[i] = s.file(files[i].path, `a-${i}\nb\nC\n`);
    }
    const left = s.state(leftFiles, [base.sha256]),
      right = s.state(rightFiles, [base.sha256]);
    const entry = await s.lane(left);
    s.register(right);
    s.moveMain(right.sha256, 'main-1');
    const request = s.request('sync', {
      laneId: entry.laneId,
      expected: s.pins(entry),
      target: { kind: 'main', head: right.sha256, receiptId: 'main-1' },
    });
    await s.prepareSync(request);
    const submitted = await s.submitSync(request);
    const job = await s.activate(submitted.jobId);
    await s.callback(job, { status: 'heartbeat', sequence: 1 });
    s.patch('hostedProjects', s.projectId, { r2Writes: true });
    if (!legacy) dogfood(s);
    const c = controls(t, s),
      dispatch = sourceDispatch(s.projectId, job),
      http = c.http(dispatch);
    const transport = legacy ? { describe: http.describe, read: http.read, upload: http.upload } : http;
    s.counts.length = 0;
    const started = performance.now();
    const output = await buildHostedSourceState(dispatch.input, transport);
    const result = JSON.parse(s.objects.get(output.head));
    assert.equal(result.files.length, 3000);
    assert.equal(s.objects.get(result.files[0].blob).toString(), 'A-0\nb\nC\n');
    assert.deepEqual(result.files[2999], files[2999]);
    assert.equal(output.metrics.downloads, 364); // input, two heads, base, 3×120 changed blobs
    assert(output.metrics.maxChunkBytes <= 1024 * 1024);
    assert(output.metrics.maxUploadWindowBytes <= 8 * 1024 * 1024);
    const stats = { ...c.stats(), wallMs: performance.now() - started, worker: output.metrics };
    t.diagnostic(JSON.stringify({ legacy, stats }));
    return stats;
  };
  let before, after;
  await t.test('single control path', async t => {
    before = await run(t, true);
  });
  await t.test('paged control path', async t => {
    after = await run(t, false);
  });
  assert(after.calls <= 20 + 2 * Math.ceil(after.worker.resolvedObjects / 100));
  assert(after.calls < before.calls / 10);
});

test('Convex source provider: complete 10-file save including new object uploads stays below 30 calls at dogfood scale', async t => {
  const run = await changedSave(t, false, true, 'convex');
  assert(run.stats.totalCalls <= 30, JSON.stringify({ stats: run.stats, functions: run.calls }));
  assert.equal(run.stats.overlapWrites, 1, 'one atomic path projection update per changed save');
  assert(run.stats.writes - run.stats.overlapWrites <= 97, JSON.stringify(run.stats));
  t.diagnostic(
    JSON.stringify({
      convex: run.stats,
      functions: Object.fromEntries(
        [...new Set(run.calls)].map(name => [name, run.calls.filter(v => v === name).length]),
      ),
    }),
  );
});
