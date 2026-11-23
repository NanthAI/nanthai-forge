// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { testDeploymentOrigin } from './trusted-origin.mjs';
import { assertCommandWeight } from '../scripts/agent-weight.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { controls, environment } from './hosted-source-efficiency-fixture.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { existsSync } from 'node:fs';
import { sourceTree } from '../dist/source-tree.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { finishGates } from '../dist/agent-default-gates.js';
import { runPreflight } from '../dist/agent-preflight.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { sourceDispatch } from '../dist/hosted-source-job-controller.js';
import { digest } from '../dist/hash.js';
import { composeAgentSource, selectAgentLane, agentState } from '../dist/hosted-agent-source.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { readObjectRecipe } from '../dist/object-chunks.js';

const { catalogPages } = await import(moduleUrl('../convex/projectObjectFind.ts'));

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
async function changedSave(
  t,
  legacy,
  scale = false,
  provider = 'synthetic',
  contract = false,
  { baselineGeneration, wrap, retryLost = false, retryContract, catalogFileCount } = {},
) {
  environment(t);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  process.env.FORGE_SOURCE_PROVIDER = 'convex';
  const s = await composeFixture();
  const fileCount = catalogFileCount ?? 3000;
  const files = Array.from({ length: fileCount }, (_, i) =>
    s.file(
      `f${String(i).padStart(Math.max(4, String(fileCount - 1).length), '0')}`,
      `first\noriginal-${i}\nlast\n`,
    ),
  );
  const baseline = s.state(files),
    entry = await s.lane(baseline),
    state = JSON.parse(s.objects.get(baseline.sha256));
  if (catalogFileCount) {
    const pins = [...files.map(({ blob }) => blob), baseline.sha256];
    const pinsSet = new Set(pins);
    for (const page of catalogPages(
      pins.map(digest => ({
        digest,
        size: s.objects.get(digest).length,
        ...(digest === baseline.sha256
          ? { stateGeneration: 1, stateSize: { fileCount, manifestBytes: baseline.size } }
          : {}),
      })),
    ))
      s.insert('projectObjectCatalog', { projectId: s.projectId, origin: 'synthetic', ...page });
    for (const row of s.tables.projectObjects.values())
      if (pinsSet.has(row.digest)) s.tables.projectObjects.delete(row._id);
  }
  if (baselineGeneration !== undefined)
    for (const row of s.tables.projectObjects.values())
      if (row.digest === baseline.sha256)
        s.patch('projectObjects', row._id, { stateGeneration: baselineGeneration });
  const root = checkout(t, s, entry, state);
  if (scale) dogfood(s);
  const c = controls(t, s);
  s.patch('hostedProjects', s.projectId, { r2Writes: true });
  const exchange = new ConvexExchange(
    testDeploymentOrigin('https://fixture.invalid'),
    'synthetic',
    s.projectId,
    randomUUID(),
    null,
  );
  exchange.client = wrap ? wrap(c.client, s, c) : c.client;
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
  let pending;
  try {
    pending = await saveHostedLane(root, command, transport, contract);
  } catch (error) {
    if (!retryLost) throw error;
    // The CLI retries the same save operation after an unknown reply (possibly upgraded since).
    pending = await saveHostedLane(root, command, transport, retryContract ?? contract);
  }
  const args = { projectId: s.projectId, jobId: pending.jobId };
  if (provider === 'convex') {
    // With source-submit-run the submitting action already dispatched and ran step 0.
    if (!contract?.submitRun) {
      await c.call('projectConvexSource:dispatch', args);
      await c.call('projectConvexSource:step', { ...args, step: 0 });
    }
    // A step that finished the job published inside its commit: the submit replied with the outcome.
    let terminal = pending;
    if (!pending.outcome) {
      await c.call('projectHostedSaveJobs:complete', args);
      terminal = await saveHostedLane(root, command, exchange, contract);
    }
    const output = terminal.outcome.result;
    const stats = {
      ...c.stats(),
      overlapWrites: overlapWrites(),
      storageCalls: c.storageCalls(),
      wallMs: performance.now() - started,
    };
    stats.totalCalls = stats.calls + stats.storageCalls;
    let stateBytes = s.objects.get(output.head);
    if (!stateBytes) {
      const rows = new Map([...s.tables.projectObjects.values()].map(row => [row.digest, row]));
      const recipe = JSON.parse(s.objects.get(rows.get(output.head).recipe.digest));
      const chunks = await Array.fromAsync(
        readObjectRecipe(recipe, async ({ sha256, size }) => {
          const pack = rows.get(sha256)?.pack;
          return pack
            ? s.objects.get(pack.digest).subarray(pack.offset, pack.offset + size)
            : s.objects.get(sha256);
        }),
      );
      stateBytes = Buffer.concat(chunks);
    }
    const saved = JSON.parse(stateBytes);
    assert.equal(saved.files.length, fileCount);
    assert.equal(readHostedLaneCheckout(root).tree, sourceTree(saved.files));
    return {
      stats,
      calls: c.calls,
      s,
      c,
      root,
      command,
      transport,
      first: pending,
      files,
      started,
      stateBytes,
    };
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

function assertSaveWriteBudget(run, ceiling) {
  // Issue 0de95ef2 budgets one compact save-head fact in the existing save mutation.
  const metricWrites = run.s.counts
    .flatMap(row => row.written)
    .filter(table => table === 'projectMetricFacts').length;
  assert.equal(metricWrites, 1, 'one indexed save-head fact per changed save');
  const feedWrites = run.s.counts
    .flatMap(row => row.written)
    .filter(table => table === 'projectFeedEvents').length;
  assert.equal(feedWrites, 1, 'one feed event per changed save');
  // Issue b6588425 line 3: one sharded account-limiter counter row per save (convex/accountLimits.ts).
  const limitWrites = run.s.counts
    .flatMap(row => row.written)
    .filter(table => table === 'deviceAttempts').length;
  assert.equal(limitWrites, 1, 'one account counter write per save');
  // Item 411727ba: the saved list of the Lane's overlap row lives in path-hash bucket rows, one per distinct bucket
  // of the changed paths (at most one per changed file), written by the same mutation as the slim overlap row.
  const bucketWrites = run.s.counts
    .flatMap(row => row.written)
    .filter(table => table === 'projectHostedOverlapChanges').length;
  assert(bucketWrites >= 1 && bucketWrites <= 10, `${bucketWrites} bucket rows for a ten-file save`);
  assert(
    run.stats.writes - run.stats.overlapWrites - bucketWrites - metricWrites - feedWrites - limitWrites <=
      ceiling,
    JSON.stringify(run.stats),
  );
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
    // Writes 98 -> 99 (9c8490a4 presence): the Lane's slim presence row is rewritten with the save's
    // new paths in the same mutation. Calls and reads are unchanged.
    // Writes 99 -> 101 (a91b9b69 storage quota): each of the two upload batches that reserves new
    // objects updates one project usage counter row. Calls and reads per object are unchanged.
    assertSaveWriteBudget(run, 101);
    const prior = run.c.calls.length;
    await saveHostedLane(run.root, run.command, run.transport);
    assert.equal(run.c.calls.length - prior, 1, 'same-op terminal retry only prepares/returns the receipt');
  });
});

test('unchanged save has no object or worker calls', async t => {
  environment(t);
  const s = await composeFixture();
  const baseline = s.state(Array.from({ length: 3000 }, (_, i) => s.file(`f${i}`, `source-${i}`)));
  const entry = await s.lane(baseline);
  const root = checkout(t, s, entry, JSON.parse(s.objects.get(baseline.sha256)), false);
  const c = controls(t, s),
    exchange = new ConvexExchange(
      testDeploymentOrigin('https://fixture.invalid'),
      'synthetic',
      s.projectId,
      randomUUID(),
      null,
    );
  exchange.client = c.client;
  s.counts.length = 0;
  const terminal = await saveHostedLane(root, { operationId: randomUUID(), message: 'unchanged' }, exchange);
  assert.equal(terminal.outcome.result.unchanged, true);
  assertCommandWeight('saveUnchanged', { calls: c.calls.length, reads: c.stats().documents });
  t.diagnostic(JSON.stringify({ saveUnchanged: c.stats() }));
  const marker = readHostedLaneCheckout(root);
  assert.equal(marker.tree, sourceTree(marker.state.files));
  // Simulate a metadata-only State before this saved head: same full 3,000-file source,
  // different ancestry/message/time. No source lookup or rehash belongs in the gate.
  const before = c.calls.length;
  const gateStarted = performance.now();
  runPreflight(
    root,
    entry.laneId,
    'f'.repeat(64),
    {
      status: 'planned',
      scope: 'none',
      reason: 'synthetic pass',
      tests: [],
      estimateMinutes: 0,
      command: null,
    },
    marker.tree,
  );
  const localAdvice = {
    unacknowledgedOverlaps: { items: [] },
    changedPaths: { paths: ['tests/selected.test.mjs'], complete: true },
  };
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(
    join(root, 'tests/selected.test.mjs'),
    "import test from 'node:test'; test('selected', () => {});",
  );
  assert.equal(
    finishGates(root, effectiveAgentDefaults(), { ...marker.selection, tree: marker.tree }, localAdvice)
      .preflight.status,
    'passed',
  );
  assert.throws(
    () =>
      finishGates(root, effectiveAgentDefaults(), { ...marker.selection, tree: sourceTree([]) }, localAdvice),
    error => error.code === 'PREFLIGHT_REQUIRED',
  );
  assert.equal(c.calls.length, before, 'same and changed tree gates add zero Convex calls');
  t.diagnostic(
    JSON.stringify({
      unchanged: c.stats(),
      gateExtraCalls: c.calls.length - before,
      gateWallMs: performance.now() - gateStarted,
      sourceFiles: marker.state.files.length,
      rssBytes: process.memoryUsage().rss,
    }),
  );
});

test('a save refused for a live finish drops its retained capture and forwards the explicit override', async t => {
  environment(t);
  const s = await composeFixture(),
    entry = await s.lane(s.baseline);
  const root = checkout(t, s, entry, JSON.parse(s.objects.get(s.baseline.sha256)));
  const c = controls(t, s),
    exchange = new ConvexExchange(
      testDeploymentOrigin('https://fixture.invalid'),
      'synthetic',
      s.projectId,
      randomUUID(),
      null,
    );
  const prepared = [];
  exchange.client = {
    ...c.client,
    mutation: async (ref, args) => {
      if (getFunctionName(ref) === 'projectHostedSaves:prepare') {
        prepared.push(JSON.parse(args.request));
        throw new ConvexError({ code: 'LANE_FINISH_ACTIVE', message: 'Lane has an active finish.' });
      }
      return c.client.mutation(ref, args);
    },
  };
  const command = { operationId: randomUUID(), message: 'while finishing' };
  await assert.rejects(saveHostedLane(root, command, exchange), error => error.code === 'LANE_FINISH_ACTIVE');
  assert.equal(prepared[0].supersedeFinish, undefined);
  // The refusal began no server operation, so stale bytes must not be resumed later.
  assert.equal(existsSync(`${root}.forge-client/saves/${command.operationId}`), false);
  const explicit = { operationId: randomUUID(), message: 'on purpose', supersedeFinish: true };
  await assert.rejects(
    saveHostedLane(root, explicit, exchange),
    error => error.code === 'LANE_FINISH_ACTIVE',
  );
  assert.equal(prepared[1].supersedeFinish, true);
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
  // This budget test invokes the worker directly, without its heartbeat supervisor.
  // Keep its synthetic lease active independently of machine load; expiry is tested separately.
  const leaseNow = Date.now();
  t.mock.method(Date, 'now', () => leaseNow);
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
  // Writes 97 -> 98 (9c8490a4 presence): the slim presence row follows the save's new paths.
  // Writes 98 -> 100 (a91b9b69 storage quota): one usage counter write per reserving upload batch.
  assertSaveWriteBudget(run, 100);
  t.diagnostic(
    JSON.stringify({
      convex: run.stats,
      functions: Object.fromEntries(
        [...new Set(run.calls)].map(name => [name, run.calls.filter(v => v === name).length]),
      ),
    }),
  );
});

test('a 10-file save commits its objects once, stages its page in submit and reads its baseline beside its input (friction f15db544)', async t => {
  const run = await changedSave(t, false, true, 'convex', { overlapEvidence: false, submitPage: true });
  const count = name => run.calls.filter(value => value === name).length;
  // Before: 21 calls (2 commitBatch actions with their pendingRows/markCommitted, 1 stage, 2 step resolves).
  assert.equal(
    count('projectObjectCommit:commitBatch'),
    1,
    'changed files and save metadata share one commit',
  );
  assert.equal(count('projectHostedSaves:stage'), 0, 'the only page rides on submit');
  assert.equal(
    count('projectConvexSourceObjects:resolve'),
    1,
    'begin hands baseline and page; only changed files resolve',
  );
  assert(run.stats.totalCalls <= 16, JSON.stringify({ stats: run.stats, functions: run.calls }));
  assertSaveWriteBudget(run, 100);
  // The receipt's server split, as sync has it: submit time and the execution's step.
  const progress = JSON.parse(
    await run.c.call('projectHostedSaves:progress', {
      projectId: run.s.projectId,
      operationId: run.command.operationId,
    }),
  );
  assert.equal(typeof progress.state.submittedAt, 'number');
  assert.equal(progress.state.serverTiming.steps.length, 1);
  assert.equal(progress.state.serverTiming.steps[0].phase, 'input>done');
  assert.equal(progress.state.serverTiming.steps[0].stop, 'done');
  assert.equal(typeof progress.state.serverTiming.publishedAt, 'number');
  t.diagnostic(
    JSON.stringify({
      convex: run.stats,
      functions: Object.fromEntries([...new Set(run.calls)].map(name => [name, count(name)])),
    }),
  );
});

test('a small save commits, submits and runs its first step in one action (source-submit-run, 1eef1b43)', async t => {
  const run = await changedSave(t, false, true, 'convex', {
    overlapEvidence: false,
    submitPage: true,
    submitRun: true,
  });
  const count = name => run.calls.filter(value => value === name).length;
  assert.equal(count('projectSourceRun:submit'), 1);
  for (const name of [
    'projectObjectCommit:commitBatch',
    'projectHostedSaveJobs:submit',
    'projectHostedSaves:stage',
    'projectConvexSource:dispatch',
    'projectConvexSource:step',
  ])
    assert.equal(count(name), 0, name);
  // The commit round still verifies every deferred upload (HEAD) before the submit stages them.
  assert.equal(count('projectObjectCommit:pendingRows'), 1);
  assert.equal(count('projectObjectCommit:markCommitted'), 1);
  // 16 -> 14: one action replaces the commit action, the submit mutation, the dispatch and the step.
  assert(run.stats.totalCalls <= 14, JSON.stringify({ stats: run.stats, functions: run.calls }));
  assertSaveWriteBudget(run, 100);
  const progress = JSON.parse(
    await run.c.call('projectHostedSaves:progress', {
      projectId: run.s.projectId,
      operationId: run.command.operationId,
    }),
  );
  assert.equal(progress.state.serverTiming.steps.length, 1);
  assert.equal(progress.state.serverTiming.steps[0].stop, 'done');
  t.diagnostic(
    JSON.stringify({
      convex: run.stats,
      functions: Object.fromEntries([...new Set(run.calls)].map(name => [name, count(name)])),
    }),
  );
});

const directContract = {
  overlapEvidence: false,
  submitPage: true,
  submitRun: true,
  prepareTargets: true,
  runPublish: true,
};
test('a direct small save: prepare returns every upload target, one PUT wave, and the submit replies with the published outcome (1eef1b43 items 1-4)', async t => {
  const run = await changedSave(t, false, true, 'convex', directContract);
  const count = name => run.calls.filter(value => value === name).length;
  // Item 1: no prepareBatch round (the save's prepare returned the blob, page and input targets).
  assert.equal(count('projectObjects:prepareBatch'), 0);
  assert.equal(count('projectHostedSaves:prepare'), 1);
  assert.equal(count('projectHostedSaves:describe'), 0);
  assert.equal(count('projectObjectDownloads:describe'), 0);
  assert.equal(count('projectSourceRun:submit'), 1);
  // Item 3: published inside the step's commit; the submit's own reply carried the outcome.
  assert.equal(run.first.outcome.status, 'completed');
  for (const name of [
    'projectHostedSaveJobs:publish',
    'projectHostedSaveJobs:complete',
    'projectHostedSaves:progress',
  ])
    assert.equal(count(name), 0, name);
  // Item 2: the step re-read none of the changed blobs this call HEAD-verified, nor the input the
  // CLI sent inline (readers still hash what they read; the commit's HEAD checked the checksum).
  const changed = new Set(run.files.slice(0, 10).map(file => digest(`first\nchanged-${file.path}\nlast\n`)));
  const reread = run.c.r2Gets.filter(id => changed.has(id));
  assert.deepEqual(reread, []);
  const inputs = [...run.s.objects].flatMap(([id, bytes]) => {
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8')).kind === 'forge-hosted-save-input' ? [id] : [];
    } catch {
      return [];
    }
  });
  assert.equal(inputs.length, 1, 'one save input');
  assert(!run.c.r2Gets.includes(inputs[0]), 'the inline input was not downloaded back');
  // 14 -> 7 calls: prepare, the submit action, its commit's two rounds, its submit, begin and commit.
  assertCommandWeight('saveChanged', { calls: run.stats.totalCalls, reads: run.stats.documents });
  assertSaveWriteBudget(run, 100);
  t.diagnostic(
    JSON.stringify({
      convex: run.stats,
      r2Gets: run.c.r2Gets.length,
      functions: Object.fromEntries([...new Set(run.calls)].map(name => [name, count(name)])),
    }),
  );
});

test('a direct small save writes the same State bytes as the described save path', async t => {
  const direct = await changedSave(t, false, true, 'convex', directContract);
  const described = await changedSave(t, false, true, 'convex', {
    overlapEvidence: false,
    submitPage: true,
    submitRun: true,
  });
  const files = run =>
    JSON.parse(
      run.s.objects.get(run.first.outcome.result.head ?? readHostedLaneCheckout(run.root).selection.head),
    ).files;
  assert.deepEqual(files(direct), files(described));
  assert.equal(readHostedLaneCheckout(direct.root).tree, readHostedLaneCheckout(described.root).tree);
});

test('a direct save with upload-packs sends its blobs and page as one pack PUT that a clone reads in one run (98ee14e8)', async t => {
  const plain = await changedSave(t, false, true, 'convex', directContract);
  const run = await changedSave(t, false, true, 'convex', { ...directContract, uploadPacks: true });
  const count = (calls, name) => calls.filter(value => value === name).length;
  // Same calls as the direct save: prepare and the one submit action; no prepareBatch, no describe.
  for (const name of [
    'projectHostedSaves:prepare',
    'projectSourceRun:submit',
    'projectObjects:prepareBatch',
    'projectObjectDownloads:describe',
  ])
    assert.equal(count(run.calls, name), count(plain.calls, name), name);
  assert(run.stats.totalCalls <= plain.stats.totalCalls, JSON.stringify([run.stats, plain.stats]));
  // The client PUT 10 blobs, 1 page and the input; now the pack and the input (the step's own
  // State and tree outputs are the same in both).
  const changed = run.files.slice(0, 10).map(file => digest(`first\nchanged-${file.path}\nlast\n`));
  assert.deepEqual(
    changed.filter(id => plain.c.r2Puts.includes(id)),
    changed,
  );
  assert.equal(run.c.r2Puts.length, plain.c.r2Puts.length - 10);
  const pack = [...run.s.tables.projectObjects.values()].find(row => row.digest === changed[0]).pack.digest;
  assert(run.c.r2Puts.includes(pack));
  assert.deepEqual(
    changed.filter(id => run.c.r2Puts.includes(id)),
    [],
  );
  // The commit read the pack once and checked every member; the step re-read none of them.
  assert.deepEqual(
    run.c.r2Gets.filter(id => id === pack || changed.includes(id)),
    [pack],
  );
  const rows = changed.map(id => [...run.s.tables.projectObjects.values()].find(row => row.digest === id));
  assert(rows.every(row => row.r2Committed && row.pack?.digest === pack));
  const physical = [...run.s.tables.projectObjects.values()].find(row => row.digest === pack);
  assert.equal(physical.r2Committed, true);
  assert.equal(physical.packMembers, undefined, 'the member list is cleared once bound');
  // The same State bytes as the unpacked save.
  const files = r => JSON.parse(r.s.objects.get(r.first.outcome.result.head)).files;
  assert.deepEqual(files(run), files(plain));
  // A clone's describe groups the save's blobs into one run: one ranged GET instead of ten.
  const described = await run.c.call('projectObjectDownloads:describe', {
    projectId: run.s.projectId,
    digests: changed,
    signed: true,
    runs: true,
  });
  assert.equal(new Set(described.map(row => row.run?.id)).size, 1);
  assert.equal(described.filter(row => row.run?.url).length, 1);
});

test('a direct save whose changed blob is stored only as a recipe is refused before any operation and saves the described way', async t => {
  const refusals = [];
  const run = await changedSave(t, false, true, 'convex', directContract, {
    wrap: (client, s) => ({
      ...client,
      mutation: async (ref, args) => {
        if (getFunctionName(ref) !== 'projectHostedSaves:prepare' || !args.uploads || refusals.length)
          return client.mutation(ref, args);
        // Another save packed this blob into a recipe between capture and prepare.
        const id = s.insert('projectObjects', {
          projectId: s.projectId,
          digest: args.uploads[0].digest,
          size: args.uploads[0].size,
          removed: false,
          nonce: randomUUID(),
          recipe: { digest: 'f'.repeat(64), size: 1 },
        });
        const operations = s.tables.projectHostedOperations.size;
        try {
          return await client.mutation(ref, args);
        } catch (error) {
          refusals.push({
            code: error.data?.code,
            began: s.tables.projectHostedOperations.size - operations,
          });
          throw error;
        } finally {
          s.tables.projectObjects.delete(id);
        }
      },
    }),
  });
  assert.deepEqual(refusals, [{ code: 'SAVE_CONTENT_RECIPE', began: 0 }]);
  const count = name => run.calls.filter(value => value === name).length;
  assert.equal(count('projectHostedSaves:prepare'), 2, 'the refused direct prepare, then the described one');
  assert(count('projectObjects:prepareBatch') >= 1, 'the described path uploads its blobs first');
  assert.equal(run.first.outcome.status, 'completed');
});

test('a direct save whose submit reply was lost replays the same operation to the same State', async t => {
  let lost = 0;
  const run = await changedSave(t, false, true, 'convex', directContract, {
    retryLost: true,
    wrap: client => ({
      ...client,
      action: async (ref, args) => {
        const reply = await client.action(ref, args);
        if (getFunctionName(ref) === 'projectSourceRun:submit' && !lost++)
          throw new Error('Synthetic reply lost after the submit ran');
        return reply;
      },
    }),
  });
  assert.equal(lost, 1);
  const count = name => run.calls.filter(value => value === name).length;
  // The retry's prepare replays the published receipt: no second upload round, run or step.
  assert.equal(count('projectSourceRun:submit'), 1);
  assert.equal(count('projectConvexSourceStore:commit'), 1);
  assert.equal(count('projectHostedSaves:prepare'), 2);
  assert.equal(run.first.outcome.status, 'completed');
});

test('a 29,000-file catalog save and its original-operation replay keep retained objects in the catalog', async t => {
  const fileCount = 29_000;
  const r2 = controls => ({
    gets: controls.r2Gets.length,
    readBytes: controls.r2ReadBytes(),
    puts: controls.r2Puts.length,
    putBytes: controls.r2PutBytes(),
    heads: controls.r2Heads(),
  });
  let beforeRetry;
  let published;
  const run = await changedSave(
    t,
    false,
    false,
    'convex',
    { ...directContract, uploadPacks: true },
    {
      catalogFileCount: fileCount,
      retryLost: true,
      wrap: (client, s, c) => ({
        ...client,
        action: async (ref, args) => {
          const reply = await client.action(ref, args);
          if (getFunctionName(ref) === 'projectSourceRun:submit') {
            assert.equal(beforeRetry, undefined, 'the original save runs once');
            beforeRetry = {
              transactions: s.counts.length,
              objects: s.tables.projectObjects.size,
              repliedAt: performance.now(),
              r2: r2(c),
            };
            const result = JSON.parse(reply);
            published = (result.terminal ?? result).outcome;
            throw new Error('Synthetic reply lost after catalog-backed save publication');
          }
          return reply;
        },
      }),
    },
  );
  const output = run.first.outcome;
  assert.equal(output.status, 'completed');
  assert.deepEqual(output.result, published.result);
  const saved = JSON.parse(run.stateBytes);
  const expected = run.files.map((file, index) =>
    index < 10 ? { ...file, blob: digest(`first\nchanged-${file.path}\nlast\n`) } : file,
  );
  assert.deepEqual(saved.files, expected);
  assert.equal(saved.parents.length, 1);
  assert.equal(digest(run.stateBytes), output.result.head);
  const pages = [...run.s.tables.projectObjectCatalog.values()];
  assert.equal(pages.length, Math.ceil((fileCount + 1) / 256));
  assert.equal(
    pages.reduce((total, page) => total + page.sizes.length, 0),
    fileCount + 1,
  );
  const retained = new Set([...run.files.map(file => file.blob), saved.parents[0]]);
  const promoted = [...run.s.tables.projectObjects.values()].filter(row => retained.has(row.digest));
  assert.equal(promoted.length, 0);
  assert.equal(run.s.tables.projectObjects.size, beforeRetry.objects);
  assert.equal(run.calls.at(-1), 'projectHostedSaves:prepare');
  assert.equal(run.calls.filter(name => name === 'projectHostedSaves:prepare').length, 2);
  assert(run.stats.totalCalls <= 8, JSON.stringify(run.calls));
  const replay = run.s.counts.slice(beforeRetry.transactions);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].writes, 0);
  assert.deepEqual(r2(run.c), beforeRetry.r2);
  t.diagnostic(
    JSON.stringify({
      save: {
        calls: run.stats.totalCalls - 1,
        documentsRead: run.stats.documents - replay[0].documents,
        documentsWritten: run.stats.writes,
        wallMs: beforeRetry.repliedAt - run.started,
      },
      replay: {
        calls: 1,
        documentsRead: replay[0].documents,
        documentsWritten: replay[0].writes,
        wallMs: run.started + run.stats.wallMs - beforeRetry.repliedAt,
      },
      materializedRows: promoted.length,
      r2: beforeRetry.r2,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});

test('a direct save that crashed before its submit ran resumes from its retained request: prepare replays the targets', async t => {
  let crashed = 0;
  const run = await changedSave(t, false, true, 'convex', directContract, {
    retryLost: true,
    wrap: client => ({
      ...client,
      action: async (ref, args) => {
        if (getFunctionName(ref) === 'projectSourceRun:submit' && !crashed++)
          throw new Error('Synthetic crash before the submit ran');
        return client.action(ref, args);
      },
    }),
  });
  assert.equal(crashed, 2);
  const count = name => run.calls.filter(value => value === name).length;
  assert.equal(count('projectHostedSaves:prepare'), 2, 'the replayed prepare returned the same targets');
  assert.equal(count('projectObjects:prepareBatch'), 0);
  assert.equal(count('projectSourceRun:submit'), 1);
  assert.equal(run.first.outcome.status, 'completed');
});

test('a hinted small save gives its State the baseline generation plus one (review 3aa618e2 F1)', async t => {
  const run = await changedSave(
    t,
    false,
    true,
    'convex',
    { overlapEvidence: false, submitPage: true },
    { baselineGeneration: 7 },
  );
  assert.equal(
    run.calls.filter(value => value === 'projectConvexSourceObjects:resolve').length,
    1,
    'the baseline came from begin, not from a resolve call',
  );
  const head = readHostedLaneCheckout(run.root).selection.head;
  const row = [...run.s.tables.projectObjects.values()].find(row => row.digest === head);
  assert.equal(row.stateGeneration, 8);
  assert.deepEqual(row.stateParents, [JSON.parse(run.s.objects.get(head)).parents[0]]);
});

test('a direct save prepare looks each upload row up once: the recipe check hands its rows to target preparation (review b1448b61 N5a)', async t => {
  const run = await changedSave(t, false, true, 'convex', directContract);
  const [prepare] = run.s.counts.filter(row => row.name === 'projectHostedSaves:prepare');
  // 11 uploads (10 new blobs and the delta page) plus the input: on main each upload was looked up
  // twice, by the recipe check and again by its target (91 range reads; now 69), plus the account
  // suspend switch and limiter counter (Issue b6588425 line 3): 71.
  assert(prepare.ranges <= 71, `projectHostedSaves:prepare read ${prepare.ranges} ranges`);
});

test('a described save retried after the CLI gains prepare-upload-targets stays described: no raw re-upload (review b1448b61 N5b)', async t => {
  let crashed = 0;
  const prepares = [];
  const described = { ...directContract, prepareTargets: false };
  const run = await changedSave(t, false, true, 'convex', described, {
    retryLost: true,
    retryContract: directContract,
    wrap: client => ({
      ...client,
      mutation: async (ref, args) => {
        if (getFunctionName(ref) === 'projectHostedSaves:prepare') prepares.push(args);
        return client.mutation(ref, args);
      },
      action: async (ref, args) => {
        if (getFunctionName(ref) === 'projectSourceRun:submit' && !crashed++)
          throw new Error('Synthetic crash before the submit ran');
        return client.action(ref, args);
      },
    }),
  });
  assert.equal(run.first.outcome.status, 'completed');
  assert.equal(prepares.length, 2);
  // On main the retry ran direct: its prepare named all 11 uploads again and PUT the blobs raw.
  assert.deepEqual(
    prepares.map(args => args.uploads?.length ?? 0),
    [0, 0],
    'the retry replays the described request, uploading nothing again',
  );
});
