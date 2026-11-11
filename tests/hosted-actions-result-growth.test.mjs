// SPDX-License-Identifier: Apache-2.0
// Issue d0f8472a: per-call Convex cost of Actions shard results must not grow with the
// reports earlier shards already stored. Drives the real HTTP handler with inline logs
// (the runner's common path) over a realistic report set and meters every mutation.
import test from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
setFlagsFromString('--expose_gc');
const collectGarbage = runInNewContext('gc');
import assert from 'node:assert/strict';
import { landingStorage } from './landing-storage-fixture.mjs';
import { bootstrapInterval } from '../scripts/bootstrap-interval.mjs';
import { speedBudgets } from '../dist/speed-budgets.js';
import { judgeCosts, formatCostVerdicts } from '../dist/cost-budgets.js';
import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { actionsIssuer } from '../dist/github-actions-oidc.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { checkPin } from '../dist/hosted-check.js';
import { savePin } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { applyCheckRetryBudget, capCheckReports } from '../dist/check-report-cap.js';
import { checkFileSummary } from '../dist/check-file-summary.js';
import { mergeShardReports, settlePoolPending } from '../dist/hosted-actions-pool.js';
const timingStore = await import(moduleUrl('../convex/projectHostedTestTimings.ts'));
const batchStore = await import(moduleUrl('../convex/projectHostedActionsBatchStore.ts'));
const batchCollector = await import(moduleUrl('../convex/projectHostedActionsBatch.ts'));
const { resultSlotKey, resultEnvelopeBody, notifyPackedResultBatch } =
  await import('../dist/hosted-actions-result-batch.js');
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const sessions = await import(moduleUrl('../convex/projectHostedActionsSession.ts'));
const plans = await import(moduleUrl('../convex/projectHostedActionsPlan.ts'));
const results = await import(moduleUrl('../convex/projectHostedActionsResults.ts'));
const webhooks = await import(moduleUrl('../convex/projectHostedActionsWebhook.ts'));
const finalOutput = await import(moduleUrl('../convex/projectHostedActionsOutput.ts'));
const { rootForOutput } = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
const { canonicalPayload } = await import('../dist/hosted-source-operation.js');
const { handle } = await import(moduleUrl('../convex/projectHostedActionsHttp.ts'));

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const repository = 'synthetic/project',
  audience = 'https://forge.example';
const claims = () => ({
  iss: actionsIssuer,
  aud: audience,
  exp: Date.now() / 1000 + 300,
  nbf: Date.now() / 1000 - 30,
  iat: Date.now() / 1000 - 30,
  repository,
  workflow_ref: `${repository}/.github/workflows/forge-check.yml@refs/heads/main`,
  workflow_sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  event_name: 'workflow_dispatch',
  run_id: '123',
  run_attempt: '1',
  runner_environment: 'github-hosted',
  repository_visibility: 'private',
});
function oidc() {
  const encode = input => Buffer.from(JSON.stringify(input)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: 'synthetic-key' })}.${encode(claims())}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
const jwks = () =>
  Response.json({
    keys: [
      {
        ...createPublicKey(privateKey).export({ format: 'jwk' }),
        kid: 'synthetic-key',
        use: 'sig',
        alg: 'RS256',
      },
    ],
  });
function variables(t, values) {
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}
/** About this repository's size: 886 test files, paths of 33 characters, two flaky files. */
const files = Array.from(
  { length: 886 },
  (_, i) => `tests/hosted-growth-${String(i).padStart(4, '0')}.test.mjs`,
);
const report = i =>
  i % 443 === 7
    ? {
        durationMs: 2345.678,
        failed: false,
        flaky: true,
        firstError: `AssertionError: synthetic flaky failure ${i} `.repeat(8),
        attempts: [
          { durationMs: 1200.5, failed: true },
          { durationMs: 1145.2, failed: false },
        ],
      }
    : { durationMs: 1000 + ((i * 37) % 9000) + 0.123, failed: false };

async function landing(t, shards, batch = false, packed = false, r2Reports = false) {
  variables(t, {
    FORGE_CHECK_REPORTS_R2: r2Reports ? '1' : '0',
    CONVEX_SITE_URL: audience,
    CONVEX_CLOUD_URL: 'https://forge.convex.cloud',
    FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-check-key',
    FORGE_GITHUB_REPO_BINDINGS: '',
    R2_ACCOUNT_ID: 'synthetic-account',
    R2_BUCKET: 'synthetic-bucket',
    R2_ACCESS_KEY_ID: 'synthetic-access',
    R2_SECRET_ACCESS_KEY: 'synthetic-secret',
  });
  const s = await checksFixture(),
    storage = new Map(),
    scheduled = [];
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${s.projectId}=${repository}`;
  s.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async (delay, ref, input) => {
        scheduled.push({ name: getFunctionName(ref), input });
        return `scheduled-${scheduled.length}`;
      },
      cancel: async () => {},
    };
    ctx.storage = { getMetadata: async id => storage.get(id) ?? null };
  });
  const runner = {
    provider: 'github-actions',
    repository,
    runsOn: 'ubuntu-latest',
    runtime: hostedActionsRuntime,
    environmentFingerprint: s.runner.environmentFingerprint,
  };
  const configuration = await s.configure({ kind: 'runner', configuration: runner }, s.configuration.digest);
  const run = await s.enqueue(s.selection({ expectedConfiguration: configuration.digest }));
  const id = { projectId: s.projectId, runId: run.id };
  const reserved = JSON.parse(await s.transaction('reserve', direct.reserve, id));
  await s.transaction('observe', direct.observe, {
    ...id,
    fence: reserved.fence,
    outcome: 'accepted',
    executionId: '123',
  });
  const r = await s.status(run.id),
    groups = Array.from({ length: shards - 1 }, (_, i) => [`tests/synthetic-${i}.test.mjs`]);
  const pins = {
    head: r.request.expectedHead,
    definition: r.check.definition,
    selection: { scope: 'full', reason: 'synthetic', tests: groups.flat() },
    groups,
    standard: true,
    interaction: false,
    command: ['node', 'scripts/forge-check.mjs'],
  };
  const recipe = { ...pins, pin: checkPin(pins) };
  storage.set('selection', savePin(recipe.selection));
  storage.set('recipe', savePin(recipe));
  await s.transaction('prepare', plans.prepare, {
    ...id,
    claims: JSON.stringify(claims()),
    recipe: JSON.stringify(recipe),
    lockfile: 'e'.repeat(64),
    selectionStorage: 'selection',
    recipeStorage: 'recipe',
    ...(batch ? { resultsBatch: true } : {}),
    ...(packed ? { resultsPacked: true } : {}),
  });
  const logs = new Map(),
    inbox = new Map(),
    r2 = { classA: 0, classB: 0, bytesPut: 0, deletes: 0 };
  let logUploadBytes = 0;
  let memoryBase = process.memoryUsage().heapUsed,
    memoryPeak = memoryBase,
    measureMemory = false;
  // The working-set guard excludes reclaimable garbage from earlier fixture calls.
  // Sampling after GC at existing I/O boundaries measures retained collector memory,
  // not an invented exact peak of every transient allocation inside V8.
  const sampleMemory = () => {
    if (!measureMemory) return;
    collectGarbage();
    memoryPeak = Math.max(memoryPeak, process.memoryUsage().heapUsed);
  };
  const memory = {
    reset: (enabled = false) => {
      measureMemory = enabled;
      if (enabled) collectGarbage();
      memoryBase = memoryPeak = process.memoryUsage().heapUsed;
    },
    growth: () => Math.max(0, memoryPeak - memoryBase),
  };

  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sampleMemory();
    if (url === `${actionsIssuer}/.well-known/jwks`) return jwks();
    const parsedUrl = new URL(url),
      key = parsedUrl.pathname;
    if (parsedUrl.searchParams.get('list-type') === '2') {
      r2.classA++;
      return new Response(
        `<ListBucketResult>${[...inbox.keys()]
          .map(key => `<Contents><Key>${key}</Key></Contents>`)
          .join('')}</ListBucketResult>`,
      );
    }
    if (init?.method === 'PUT') {
      logUploadBytes += Buffer.byteLength(init.body);
      r2.classA++;
      r2.bytesPut += Buffer.byteLength(init.body);
      if (inbox.has(key)) return new Response(null, { status: 412 });
      inbox.set(key, Buffer.from(init.body));
      return new Response(null, { status: 200 });
    }
    if (init?.method === 'DELETE') {
      r2.deletes++;
      inbox.delete(key);
      return new Response(null, { status: 204 });
    }
    r2.classB++;
    if (!init?.method || init.method === 'GET') {
      return new Response(inbox.get(key) ?? null, { status: inbox.has(key) ? 200 : 404 });
    }

    if (init.method === 'HEAD' && key.includes('/check-results/'))
      return new Response(null, { status: inbox.has(key) ? 200 : 404 });
    const known = [...logs.keys()].find(sha => url.includes(sha));
    const bytes = known
      ? logs.get(known)
      : Buffer.from(
          canonicalPayload(rootForOutput(id, '123', [...s.tables.projectHostedOutputHeads.values()][0])),
        );
    return new Response(null, {
      status: 200,
      headers: {
        'content-length': String(bytes.length),
        'x-amz-checksum-sha256': Buffer.from(digest(bytes), 'hex').toString('base64'),
      },
    });
  });
  const modules = {
    projectHostedActionsOutput: finalOutput,
    projectHostedActionsSession: sessions,
    projectHostedActionsResults: results,
    projectHostedActionsBatchStore: batchStore,
    projectHostedTestTimings: timingStore,
  };
  const ctx = {
    runMutation: async (ref, input) => {
      sampleMemory();
      const name = getFunctionName(ref),
        [module, method] = name.split(':');
      const value = await s.transaction(name, modules[module][method], input);
      sampleMemory();
      return value;
    },
  };
  const responses = [],
    sent = new Map(),
    started = new Date(Date.now() - 60_000).toISOString();
  const send = async (index, status = 200) => {
    const bytes = Buffer.from(`synthetic shard ${index} log `.repeat(64));
    logs.set(digest(bytes), bytes);
    const per = Math.ceil(files.length / shards);
    const result = sent.get(index) ?? {
      index,
      exitCode: 0,
      log: {
        object: { sha256: digest(bytes), size: bytes.length },
        failureSummary: '',
      },
      contractReports: Object.fromEntries(
        files.slice(index * per, (index + 1) * per).map((file, i) => [file, report(index * per + i)]),
      ),
      execution: { startedAt: started, endedAt: new Date().toISOString() },
    };
    sent.set(index, result);
    const before = s.counts.length;
    const response = await handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({
          ...id,
          fence: reserved.fence,
          command: {
            kind: 'result',
            result,
            logBytes: bytes.toString('base64'),
          },
        }),
      }),
    );
    assert.equal(response.status, status);
    const text = await response.text();
    responses.push(Buffer.byteLength(text));
    return { body: JSON.parse(text), meters: s.counts.slice(before) };
  };
  const post = async result => {
    const response = await handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({
          ...id,
          fence: reserved.fence,
          command: { kind: 'result', result },
        }),
      }),
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const stored = () =>
    JSON.parse([...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === id.runId).value);
  // The provider's signed completed event: a pass needs it (Issue 432164bf).
  const conclude = async (conclusion = 'success') => {
    const reply = await s.transaction('webhook', webhooks.receive, {
      payload: JSON.stringify({
        action: 'completed',
        repository: { full_name: repository },
        workflow_run: {
          id: 123,
          run_attempt: 1,
          display_title: `forge-check/${id.runId}`,
          event: 'workflow_dispatch',
          path: '.github/workflows/forge-check.yml',
          head_branch: 'main',
          head_sha: 'a'.repeat(40),
          created_at: new Date().toISOString(),
          conclusion,
        },
      }),
    });
    if (reply) {
      const work = JSON.parse(reply);
      if (work.reportBatch)
        await batchCollector.collectResultBatch(ctx, work.identity, work.conclusion, work.reportBatch);
    }
  };
  return {
    memory,
    logUploadBytes: () => logUploadBytes,
    s,
    id,
    send,
    post,
    stored,
    responses,
    conclude,
    inbox,
    ctx,
    logs,
    r2,
    scheduled,
    fence: reserved.fence,
  };
}
const sum = (meters, key) => meters.reduce((n, m) => n + m[key], 0);
const kb = n => Math.round(n / 102.4) / 10;

async function measure(t, shards, replays = []) {
  const l = await landing(t, shards),
    calls = [];
  let body;
  for (let index = 0; index < shards; index++) {
    const sent = await l.send(index);
    body = sent.body;
    calls.push({ index, meters: sent.meters, response: l.responses.at(-1) });
    if (replays.includes(index)) {
      const again = await l.send(index);
      calls.push({
        index,
        replay: true,
        meters: again.meters,
        response: l.responses.at(-1),
      });
    }
  }
  assert.equal(body.actions.verdictPending, true, 'the last result holds the pass for the provider');
  const completionStart = l.s.counts.length;
  await l.conclude();
  const completionMeters = l.s.counts.slice(completionStart);
  const row = [...l.s.tables.projectHostedCheckRuns.values()].find(row => row.runId === l.id.runId);
  return {
    l,
    calls,
    completionMeters,
    body: l.stored(),
    runRowBytes: Buffer.byteLength(JSON.stringify(row)),
  };
}
function perFunction(calls) {
  const out = {};
  for (const call of calls)
    for (const m of call.meters) {
      const f = (out[m.name] ??= {
        calls: 0,
        readDocs: 0,
        readKB: 0,
        writeDocs: 0,
        writeKB: 0,
      });
      f.calls++;
      f.readDocs += m.documents;
      f.readKB += m.readBytes / 1024;
      f.writeDocs += m.writes;
      f.writeKB += m.writeBytes / 1024;
    }
  for (const f of Object.values(out))
    for (const k of ['readKB', 'writeKB']) f[k] = Math.round(f[k] * 10) / 10;
  return out;
}

test('shard result cost is flat in accumulated reports at 1, 4, 8 and 12 shards', async t => {
  const rows = [];
  for (const shards of [1, 4, 8, 12]) {
    const { calls, body, runRowBytes } = await measure(t, shards);
    assert.equal(body.status, 'passed');
    assert.equal(body.testFiles.counts.total, files.length);
    assert.equal(Object.keys(body.contractReports).length, files.length);
    const progress = calls.slice(0, -1).map(call => call.meters.find(m => m.name.endsWith(':result')));
    const outputs = calls.map(call => call.meters.find(m => m.name.endsWith(':output')));
    rows.push({
      shards,
      runRowKB: kb(runRowBytes),
      // Non-final shard results: first and last show whether cost grows with stored reports.
      resultReadKB: progress.map(m => kb(m.readBytes)),
      resultWriteKB: progress.map(m => kb(m.writeBytes)),
      outputReadKB: outputs.map(m => kb(m.readBytes)),
      responseKB: calls.map(call => kb(call.response)),
      perFunction: perFunction(calls),
    });
  }
  t.diagnostic(JSON.stringify(rows));
});

test('cost guard: twelve CI shards, realistic reports, inline logs, two replays and provider conclusion stay within the ledger', async t => {
  const { l, calls, body, runRowBytes, completionMeters } = await measure(t, 12, [2, 5]);
  assert.equal(body.status, 'passed');
  const replays = calls.filter(call => call.replay);
  assert.equal(replays.length, 2);
  // Count the complete ingest window, including the provider conclusion, rather than only
  // the result mutation. One completed run here is one check/landing; setup is outside it.
  const meters = [...calls.flatMap(call => call.meters), ...completionMeters];
  const measured = {
    calls: calls.length + 1 + meters.length, // HTTP actions + provider HTTP action + nested mutations
    readBytes: sum(meters, 'readBytes'),
    writeBytes: sum(meters, 'writeBytes'),
    responseBytes: calls.reduce((n, call) => n + call.response, 0),
    logUploadBytes: l.logUploadBytes(),
  };
  const verdicts = judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'ci-result-fixture', measured);
  for (const line of formatCostVerdicts(verdicts)) t.diagnostic(line);
  t.diagnostic(`ci-result measured ${JSON.stringify(measured)}`);
  assert.equal(
    verdicts.length,
    5,
    'CI ingest calls, DB reads/writes, response and log-upload bytes are budgeted',
  );
  assert.deepEqual(
    verdicts.filter(v => v.status === 'fail'),
    [],
  );
  // The historical diagnostic-only test accepted another whole run's I/O. Prove the ledger
  // rejects that class of regression, independently of nominal action-duration assumptions.
  const seeded = judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'ci-result-fixture', {
    ...measured,
    readBytes: measured.readBytes * 2,
  });
  assert.equal(seeded.find(v => v.metric === 'readBytes').status, 'fail');
  t.diagnostic(
    JSON.stringify({
      runRowKB: kb(runRowBytes),
      httpCalls: calls.length,
      responseKB: kb(calls.reduce((n, call) => n + call.response, 0)),
      perFunction: perFunction(calls),
      readKB: kb(
        sum(
          calls.flatMap(call => call.meters),
          'readBytes',
        ),
      ),
      writeKB: kb(
        sum(
          calls.flatMap(call => call.meters),
          'writeBytes',
        ),
      ),
    }),
  );
});

/** The previous release's per-result fold over the run row, kept here as the reference. */
function referenceFold(steps, shardCount) {
  let reports = {},
    pending = [];
  return steps.map((step, k) => {
    const merged = mergeShardReports(reports, step.contractReports ?? {});
    const pool = settlePoolPending(merged, pending, step.pool?.yielded ?? [], k + 1 === shardCount);
    pending = pool.pending;
    reports = capCheckReports(applyCheckRetryBudget(pool.reports)).reports;
    return { reports, pending, testFiles: checkFileSummary(reports) };
  });
}
const failing = (file, error) => ({
  durationMs: 5,
  failed: true,
  ...(error ? { firstError: error } : {}),
});
const flake = error => ({
  durationMs: 7,
  failed: false,
  flaky: true,
  firstError: error,
  attempts: [
    { durationMs: 3, failed: true },
    { durationMs: 4, failed: false },
  ],
});
/** Pool yields, a doubt run reporting the same file twice (failed then failed without excerpt,
 * passed after failed), 40 excerpted failures (cap 32), five flakes (budget 3), passing files. */
function trickySteps(shards) {
  const name = (prefix, i) => `tests/${prefix}-${String(i).padStart(3, '0')}.test.mjs`;
  const steps = Array.from({ length: shards }, (_, index) => ({
    index,
    exitCode: 0,
    contractReports: {},
  }));
  for (let i = 0; i < 120; i++)
    steps[i % shards].contractReports[name('pass', i)] = {
      durationMs: 10 + i,
      failed: false,
    };
  for (let i = 0; i < 40; i++)
    steps[(i * 7) % shards].contractReports[name('fail', i)] = failing(
      name('fail', i),
      `Error ${i} `.repeat(30),
    );
  for (let i = 0; i < 5; i++) steps[(i + 1) % shards].contractReports[name('flake', i)] = flake(`flake ${i}`);
  steps[0].pool = {
    yielded: [name('pool', 0), name('pool', 1), name('pass', 1)],
  };
  steps[1].contractReports[name('pool', 0)] = failing(name('pool', 0), 'pool failure');
  steps[2].contractReports[name('pool', 0)] = failing(name('pool', 0));
  steps[2].contractReports[name('fail', 3)] = { durationMs: 1, failed: false };
  steps[3].contractReports[name('fail', 5)] = failing(name('fail', 5));
  for (const step of steps)
    if (step.contractReports && Object.values(step.contractReports).some(r => r.failed)) step.exitCode = 1;
  return steps;
}

test('replay equals the per-result fold: progress summaries, pool, budget, cap and final reports', async t => {
  for (const order of [
    [0, 1, 2, 3, 4, 5],
    [5, 3, 1, 0, 2, 4],
  ]) {
    const steps = trickySteps(6),
      l = await landing(t, 6),
      arrived = order.map(index => steps[index]);
    const expected = referenceFold(arrived, 6);
    let body;
    for (const [k, step] of arrived.entries()) {
      body = await l.post(step);
      if (k < 5) {
        // Progress keeps the same summary and pool state, without the full reports in the run row.
        assert.deepEqual(body.testFiles, expected[k].testFiles);
        assert.deepEqual(body.poolPending ?? [], expected[k].pending);
        assert.equal(l.stored().contractReports, undefined);
      }
    }
    const final = expected.at(-1);
    assert.equal(body.status, 'failed');
    assert.deepEqual(body.contractReports, final.reports);
    assert.deepEqual(body.testFiles, final.testFiles);
    // An unreported pool file fails the check (its excerpt may fall outside the 32 retained).
    assert.equal(body.contractReports['tests/pool-001.test.mjs'].failed, true);
    // Five flakes against a shared budget of three: two fail.
    assert.equal(
      Object.entries(body.contractReports).filter(([f, r]) => f.includes('flake') && r.failed).length,
      2,
    );
    // Terminal: raw shard copies and the progress row are gone; replays still answer by index.
    const rows = [...l.s.tables.projectHostedActionsResults.values()];
    assert.equal(rows.length, 6);
    assert(rows.every(row => row.reports === undefined && row.state === undefined && row.index >= 0));
    assert.equal((await l.post(arrived[2])).status, 'failed');
  }
});

test('a check cancelled between shards keeps exactly the reports its shards sent', async t => {
  const steps = trickySteps(6),
    l = await landing(t, 6);
  for (const step of steps.slice(0, 3)) await l.post(step);
  await l.s.cancel(l.id.runId);
  const run = l.stored();
  assert.equal(run.status, 'cancelled');
  const expected = referenceFold(steps.slice(0, 3), 6).at(-1);
  assert.deepEqual(run.contractReports, expected.reports);
  assert.deepEqual(run.testFiles, expected.testFiles);
  assert([...l.s.tables.projectHostedActionsResults.values()].every(row => row.reports === undefined));
});

test('growth guard: a later shard result reads and writes no more than an early one plus its own reports', async t => {
  const { calls } = await measure(t, 12);
  const progress = calls.slice(0, -1).map(call => call.meters.find(m => m.name.endsWith(':result')));
  const outputs = calls.map(call => call.meters.find(m => m.name.endsWith(':output')));
  // Shard results carry about 6 KB of reports each; the 886 file names add 36 bytes per file at most.
  const slack = 40 * 1024;
  for (const m of progress) {
    assert(m.readBytes <= progress[0].readBytes + slack, `result read ${m.readBytes}`);
    assert(m.writeBytes <= progress[0].writeBytes + slack, `result write ${m.writeBytes}`);
    assert(m.writes <= progress[0].writes + 1, `result writes ${m.writes}`);
    assert.equal(m.written.filter(table => table === 'projectHostedCheckRuns').length, 1, 'one run write');
  }
  for (const m of outputs) assert(m.readBytes <= outputs[0].readBytes + 4096, `output read ${m.readBytes}`);
  for (const call of calls.slice(0, -1)) assert(call.response < 24 * 1024, `response ${call.response}`);
});

test('the run row is read once per shard call: output reads 2 documents, an early result under 8 KB', async t => {
  // Issue 75cb5074: actionsSession's row is passed through, not loaded again by output authorize or callback.
  const { calls } = await measure(t, 4);
  for (const call of calls) {
    const output = call.meters.find(m => m.name.endsWith(':output'));
    assert(output.documents <= 2, `output read ${output.documents} documents`);
  }
  const first = calls[0].meters.find(m => m.name.endsWith(':result'));
  assert(first.readBytes < 8 * 1024, `early result read ${first.readBytes}`);
});

test('the last shard reads about one copy of the reports, not every shard record twice; no prepare call', async t => {
  // Issue 75cb5074: before, the last result read 190 KB at 4 shards and 215 KB at 12 (the run row
  // read back after its own write, the progress row twice, one JSON object per passing file),
  // and output prepare read the finished run row again.
  const rows = [];
  for (const shards of [4, 12]) {
    const { calls, runRowBytes } = await measure(t, shards);
    const last = calls.at(-1).meters,
      result = last.find(m => m.name.endsWith(':result')),
      apply = last.find(m => m.name.endsWith(':apply'));
    rows.push({ shards, resultReadKB: kb(result.readBytes), applyReadKB: kb(apply.readBytes) });
    // The finished run row holds every file's report, so it is the unit: one copy plus a little.
    assert(result.readBytes <= 1.2 * runRowBytes, `last result read ${result.readBytes} of ${runRowBytes}`);
    assert(result.readBytes <= 100 * 1024, `last result read ${result.readBytes}`);
    // The completion (with its terminal lookups) runs on the provider's completed event now.
    assert.equal(result.readDocumentsByTable.projectHostedCheckRuns, 1, 'run row read once');
    assert(!last.some(m => m.name.endsWith(':prepare')), 'prepare folded into the final result');
    assert(apply.readBytes <= runRowBytes + 4096, `apply read ${apply.readBytes}`);
    assert.equal(
      calls.flatMap(call => call.meters).filter(m => m.name.endsWith(':apply')).length,
      1,
      'one apply',
    );
  }
  t.diagnostic(JSON.stringify(rows));
});

test("a failing early shard's file and first error reach the landing reply", async t => {
  const { checkFailureDetail } = await import('../dist/check-failure-detail.js');
  const l = await landing(t, 4),
    file = 'tests/hosted-growth-0300.test.mjs',
    error = 'AssertionError: synthetic shard one failure';
  const steps = [0, 1, 2, 3].map(index => ({
    index,
    exitCode: index === 1 ? 1 : 0,
    contractReports: Object.fromEntries(
      files
        .slice(index * 222, (index + 1) * 222)
        .map(name => [name, name === file ? failing(name, error) : { durationMs: 10, failed: false }]),
    ),
  }));
  let body;
  for (const step of steps) body = await l.post(step);
  assert.equal(body.status, 'failed');
  assert.equal(body.contractReports[file].firstError, error);
  assert.equal(body.contractReports['tests/hosted-growth-0001.test.mjs'].durationMs, 10);
  assert.equal(Object.keys(body.contractReports).length, files.length);
  const detail = checkFailureDetail(body);
  assert(detail.includes(file) && detail.includes('synthetic shard one failure'), detail);
});

test('shard rows written before the compact shape still replay to the same reports', async t => {
  // A run in flight across the deploy has raw rows {reports, yielded}; the replay reads both shapes.
  const steps = trickySteps(6),
    l = await landing(t, 6);
  for (const step of steps.slice(0, 5)) await l.post(step);
  for (const row of l.s.tables.projectHostedActionsResults.values())
    if (row.reports !== undefined) {
      const saved = JSON.parse(row.reports);
      row.reports = canonicalPayload({
        reports: {
          ...Object.fromEntries(
            Object.entries(saved.durations).map(([file, durationMs]) => [
              file,
              { durationMs, failed: false },
            ]),
          ),
          ...saved.reports,
        },
        yielded: saved.yielded,
      });
    }
  const body = await l.post(steps[5]);
  assert.deepEqual(body.contractReports, referenceFold(steps, 6).at(-1).reports);
});

test('unsealed output: the committed result stands and prepare refuses exactly as before', async t => {
  const l = await landing(t, 2);
  await l.send(0);
  // An output stream that never sealed: the final manifest must not be published.
  [...l.s.tables.projectHostedOutputHeads.values()][0].streams++;
  const { body, meters } = await l.send(1, 403);
  assert.equal(body.reason, 'authorization');
  assert.deepEqual(
    meters.map(m => m.name),
    [
      'projectHostedActionsResults:output',
      'projectHostedActionsResults:result',
      'projectHostedActionsOutput:prepare',
    ],
  );
  assert.equal(l.stored().actions.verdictPending, true);
  await l.conclude();
  assert.equal(l.stored().status, 'passed');
  assert(![...l.s.tables.projectHostedOutputHeads.values()][0].final);
});

test('Issue 0c457ae4: 5,000 test files complete through the hosted result path and every read', async t => {
  // Convex rejects an object of more than 1024 fields in any return value, argument or document,
  // which rolled the last shard back and stalled every check above 1024 test files. The fixture
  // applies that limit to every function call; this run crosses it almost five times over.
  const { read } = await import('./hosted-checks-fixture.mjs');
  const { culpritFailures, probeVerdict } = await import('../dist/culprit-bisect.js');
  const { summarizeCheckRun } = await import('../dist/hosted-check-summary.js');
  const { checkFailureDetail } = await import('../dist/check-failure-detail.js');
  const { checkConvexValue } = await import('./convex-args.mjs');
  const many = Array.from({ length: 5000 }, (_, i) => `tests/limit-${String(i).padStart(4, '0')}.test.mjs`);
  const failed = many[4321],
    shards = 8,
    per = Math.ceil(many.length / shards);
  const l = await landing(t, shards);
  const steps = Array.from({ length: shards }, (_, index) => ({
    index,
    exitCode: index === 5 ? 1 : 0,
    contractReports: Object.fromEntries(
      many
        .slice(index * per, (index + 1) * per)
        .map((file, i) => [
          file,
          file === failed ? failing(file, 'synthetic failure') : { durationMs: 1 + i, failed: false },
        ]),
    ),
  }));
  let body;
  for (const step of steps) body = await l.post(step);
  assert.equal(body.status, 'failed');
  assert.equal(Object.keys(body.contractReports).length, many.length);
  assert.equal(body.testFiles.counts.total, many.length);
  const run = l.stored();
  assert.equal(run.status, 'failed');
  assert.equal(Object.keys(run.contractReports).length, many.length);
  // A replayed shard result after the terminal returns the finished run again.
  assert.equal((await l.post(steps[2])).status, 'failed');
  // Reads: status, summary and the per-file consumers (failure detail, culprit bisect).
  const status = JSON.parse(
    await l.s.transaction('checkStatus', read.status, { projectId: l.id.projectId, runId: l.id.runId }),
  );
  assert.equal(Object.keys(status.contractReports).length, many.length);
  const summary = JSON.parse(
    await l.s.transaction('checkSummary', read.summary, { projectId: l.id.projectId, runId: l.id.runId }),
  );
  assert.equal(summary.status, 'failed');
  assert.deepEqual(summarizeCheckRun(run).status, 'failed');
  assert(checkFailureDetail(run).includes(failed));
  assert.deepEqual(culpritFailures(run), [{ file: failed, excerpt: 'synthetic failure' }]);
  assert.equal(probeVerdict(run, [failed]), 'fail');
  // Timings were recorded from the finished run as one JSON text field.
  const timings = [...l.s.tables.projectHostedTestTimings.values()];
  assert.equal(timings.length, 1);
  assert.equal(typeof timings[0].history, 'string');
  for (const table of Object.keys(l.s.tables))
    for (const row of l.s.tables[table].values()) checkConvexValue(row, table);
  const runRow = [...l.s.tables.projectHostedCheckRuns.values()].find(row => row.runId === l.id.runId);
  t.diagnostic(JSON.stringify({ files: many.length, shards, runRowKB: kb(Buffer.byteLength(runRow.value)) }));
});

async function batchedLanding(t, shards, steps, { conclude = true, replay = false, r2Reports = false } = {}) {
  const l = await landing(t, shards, true, r2Reports, r2Reports);
  const r = l.stored();
  for (const result of steps)
    l.inbox.set(
      `/synthetic-bucket/${resultSlotKey(r, result.index)}`,
      Buffer.from(resultEnvelopeBody({ result })),
    );
  const input = { ...l.id, fence: r.fence, executionId: r.executionId, claims: JSON.stringify(claims()) };
  const start = l.s.counts.length;
  const collect = async () => {
    const response = await handle._handler(
      l.ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({ ...l.id, fence: r.fence, command: { kind: 'results' } }),
      }),
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  l.memory.reset(r2Reports);
  await collect();
  if (replay) await collect();
  if (conclude) await l.conclude();
  return { ...l, meters: l.s.counts.slice(start), input };
}

test('batched CI results: one verdict fold per check run, immutable replay, provider attestation and failure details', async t => {
  for (const failed of [false, true]) {
    const steps = Array.from({ length: 12 }, (_, index) => ({
      index,
      exitCode: failed && index === 4 ? 1 : 0,
      contractReports: {
        [`tests/batch-${index}.test.mjs`]: {
          failed: failed && index === 4,
          durationMs: 10,
          ...(failed && index === 4 ? { firstError: 'synthetic batch failure' } : {}),
        },
      },
    }));
    const l = await batchedLanding(t, 12, steps, { conclude: false, replay: true });
    assert.equal(l.stored().status, failed ? 'failed' : 'running');
    const ingests = l.meters.filter(m => m.name === 'projectHostedActionsResults:batch');
    assert.equal(ingests.length, 2, 'one new batch plus one unchanged retry');
    assert.equal(
      ingests[0].written.filter(t => t === 'projectHostedCheckRuns').length,
      1,
      'one run write for twelve shard results',
    );
    assert.equal(
      ingests[1].written.filter(t => t === 'projectHostedCheckRuns').length,
      0,
      'replayed batch writes no new verdict',
    );
    if (failed) {
      const { checkFailureDetail } = await import('../dist/check-failure-detail.js');
      assert.match(checkFailureDetail(await l.s.status(l.id.runId)), /batch-4.*synthetic batch failure/s);
    } else {
      assert.equal(
        [...l.s.tables.projectHostedCheckRuns.values()][0].verdictKey,
        undefined,
        'supervisor results alone never enter the reusable verdict index',
      );
      await l.conclude();
      assert.equal(l.stored().status, 'passed');
      assert(
        [...l.s.tables.projectHostedCheckRuns.values()][0].verdictKey,
        'only the signed provider conclusion makes the verdict reusable',
      );
    }
  }
});

test('batch report fold retains shared retry budget, excerpt caps, pool failures and per-file details', async t => {
  const steps = trickySteps(6),
    expected = referenceFold(steps, 6).at(-1);
  const l = await batchedLanding(t, 6, steps);
  assert.equal(l.stored().status, 'failed');
  assert.deepEqual((await l.s.status(l.id.runId)).contractReports, expected.reports);
  assert.deepEqual(l.stored().testFiles, expected.testFiles);
});

test('batch authority rejects stale fences, foreign executions, substituted indices and changed replay bytes', async t => {
  const l = await landing(t, 2, true),
    r = l.stored();
  const input = { ...l.id, fence: r.fence, executionId: r.executionId, claims: JSON.stringify(claims()) };
  for (const changed of [{ fence: r.fence + 1 }, { executionId: 'other' }])
    await assert.rejects(batchCollector.collectResultBatch(l.ctx, { ...input, ...changed }));
  l.inbox.set(
    `/synthetic-bucket/${resultSlotKey(r, 0)}`,
    Buffer.from(resultEnvelopeBody({ result: { index: 1, exitCode: 0 } })),
  );
  await assert.rejects(batchCollector.collectResultBatch(l.ctx, input));
  assert.equal(l.stored().counts.completed, 0);
  l.inbox.set(
    `/synthetic-bucket/${resultSlotKey(r, 0)}`,
    Buffer.from(resultEnvelopeBody({ result: { index: 0, exitCode: 0 } })),
  );
  await batchCollector.collectResultBatch(l.ctx, input);
  await assert.rejects(
    l.s.transaction('batch-replay', results.batch, {
      ...input,
      results: JSON.stringify([{ index: 0, exitCode: 1 }]),
    }),
  );
  assert.equal(l.stored().counts.completed, 1);
});

test('identical tree and definition reuse a provider-attested verdict without writing another run or result', async t => {
  const l = await batchedLanding(t, 2, [
    { index: 0, exitCode: 0 },
    { index: 1, exitCode: 0 },
  ]);
  const original = l.stored();
  const start = l.s.counts.length;
  const reused = await l.s.enqueue({ ...original.request, operationId: crypto.randomUUID() });
  assert.equal(reused.id, original.id);
  assert.equal(l.s.tables.projectHostedCheckRuns.size, 1);
  const writes = l.s.counts.slice(start).flatMap(m => m.written);
  assert(!writes.includes('projectHostedCheckRuns'));
  assert(!writes.includes('projectHostedActionsResults'));
  assert(!writes.includes('projectHostedCheckShards'));
  await assert.rejects(
    l.s.enqueue({
      ...original.request,
      operationId: crypto.randomUUID(),
      expectedEnvironment: '0'.repeat(64),
    }),
    code('EVIDENCE_CHANGED'),
  );
});

test('batched reports: 20,000 all-pass and all-fail files use one pinned object, no result rows and bounded headers', async t => {
  const detail = await import(moduleUrl('../convex/projectHostedCheckDetail.ts'));
  const { foldShardStep } = await import(moduleUrl('../convex/projectHostedActionsReports.ts'));
  const { read } = await import('./hosted-checks-fixture.mjs');
  for (const failed of [false, true]) {
    const many = Array.from({ length: 20000 }, (_, i) => `tests/batch-limit-${i}.test.mjs`);
    const steps = Array.from({ length: 12 }, (_, index) => ({
      index,
      exitCode: failed ? 1 : 0,
      contractReports: Object.fromEntries(
        many
          .filter((_, i) => i % 12 === index)
          .map(file => [
            file,
            {
              failed,
              durationMs: 10,
              ...(failed
                ? { firstError: 'retained failure' }
                : file === many[0]
                  ? {
                      flaky: true,
                      firstError: 'retained flaky error',
                      attempts: [
                        { failed: true, durationMs: 20 },
                        { failed: false, durationMs: 10 },
                      ],
                    }
                  : {}),
            },
          ]),
      ),
    }));
    const l = await batchedLanding(t, 12, steps, { conclude: false, r2Reports: true });
    assert(
      l.memory.growth() < 64 * 1024 * 1024,
      `collector retained heap at I/O boundaries grew ${l.memory.growth()}`,
    );
    t.diagnostic(JSON.stringify({ failed, collectorBoundaryLiveHeapGrowth: l.memory.growth() }));
    const row = [...l.s.tables.projectHostedCheckRuns.values()][0];
    assert.equal(l.s.tables.projectHostedActionsResults.size, 0);
    assert.equal(l.stored().contractReports, undefined);
    assert(
      Buffer.byteLength(JSON.stringify(row)) < 12 * 1024,
      `whole run row ${Buffer.byteLength(JSON.stringify(row))}`,
    );
    assert(Buffer.byteLength(JSON.stringify(JSON.stringify(l.stored().testFiles))) <= 8192);
    assert.deepEqual(l.stored().testFiles.counts, {
      total: 20000,
      failed: failed ? 20000 : 0,
      flaky: failed ? 0 : 1,
    });
    let expected = { reports: {}, pending: [] };
    for (const [i, step] of steps.entries())
      expected = foldShardStep(expected, {
        reports: step.contractReports,
        yielded: [],
        complete: i === steps.length - 1,
      });
    const pointer = l.stored().reportPointer;
    const objects = [...l.inbox].filter(([key]) => key.includes('/reports/'));
    assert.equal(objects.length, 1);
    assert.equal(digest(objects[0][1]), pointer.digest);
    assert.deepEqual(JSON.parse(objects[0][1]), expected.reports);
    const detailCtx = {
      auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
      runQuery: (_ref, input) => l.s.transaction('detail-read', detail.retained, input),
    };
    let cursor = null,
      restored = {};
    do {
      const value = await detail.reports._handler(detailCtx, { ...l.id, cursor });
      assert(Buffer.byteLength(value) <= 256 * 1024);
      const page = JSON.parse(value);
      Object.assign(restored, page.contractReports);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(restored, expected.reports);
    await assert.rejects(l.s.transaction('old-client', read.status, l.id), code('CLI_UPGRADE_REQUIRED'));
    const head = JSON.parse(
      await l.s.transaction('header-status', read.status, { ...l.id, features: ['check-report-detail'] }),
    );
    assert.equal(head.contractReports, undefined);
    const start = l.s.counts.length;
    await l.conclude(failed ? 'failure' : 'success');
    const webhook = l.s.counts.slice(start).find(m => m.name === 'webhook');
    assert(webhook.readBytes < 24 * 1024, `webhook reads ${webhook.readBytes}`);
    assert(webhook.writeBytes < 24 * 1024, `webhook writes ${webhook.writeBytes}`);
    assert.equal(l.stored().status, failed ? 'failed' : 'passed');
    const timedRow = [...l.s.tables.projectHostedCheckRuns.values()][0];
    assert(
      Buffer.byteLength(JSON.stringify(timedRow)) < 12 * 1024,
      'the terminal row including timing stamps stays bounded',
    );
    assert(timedRow.reportTimingParts.length >= 1, 'duration arguments are retained with replay identity');
    assert.equal(timedRow.reportTimingComplete, true);
    const historyBefore = [...l.s.tables.projectHostedTestTimings.values()][0].history;
    await l.conclude(failed ? 'failure' : 'success');
    assert.equal(
      [...l.s.tables.projectHostedTestTimings.values()][0].history,
      historyBefore,
      'timing argument pages replay without a second EWMA sample',
    );
    assert(!l.scheduled.some(task => task.name === 'projectHostedTestTimings:record'));
    const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
    const indexes = schema.tables.projectHostedCheckRuns.export().indexes;
    assert.equal(indexes.length, 9);
    for (const index of indexes) {
      const selected = await l.s.transaction(
        `run-index-${index.indexDescriptor}`,
        {
          isQuery: true,
          _handler: ctx =>
            ctx.db
              .query('projectHostedCheckRuns')
              .withIndex(index.indexDescriptor, q =>
                index.fields.reduce((q, field) => q.eq(field, timedRow[field]), q),
              )
              .unique(),
        },
        {},
      );
      assert.equal(selected._id, timedRow._id, index.indexDescriptor);
    }
    if (!failed) {
      const projected = [...l.s.tables.projectFinishReadRows.values()].find(
        row => row.kind === 'projectMetricCheckRuns' && row.runId === l.id.runId,
      );
      const metric = JSON.parse(projected.value);
      assert.equal(metric.flaky.total, 1);
      assert.equal(metric.flaky.files[0].firstError, 'retained flaky error');
      assert.deepEqual(metric.flaky.files[0].attempts, expected.reports[many[0]].attempts);
    }
  }
});

async function resultPathBytes(t, batch, packed = batch, r2Reports = false) {
  const l = await landing(t, 12, batch, packed, r2Reports),
    run = l.stored(),
    steps = [];
  const planReplyBytes = Buffer.byteLength(
    JSON.stringify(batch ? { run, resultBatch: await batchCollector.resultBatchTargets(run, packed) } : run),
  );
  const targets = batch ? await batchCollector.resultBatchTargets(run, packed) : null;
  const collect = async () => {
    replyBytes += Buffer.byteLength(
      JSON.stringify(
        await batchCollector.collectResultBatch(l.ctx, {
          ...l.id,
          fence: run.fence,
          executionId: run.executionId,
          claims: JSON.stringify(claims()),
        }),
      ),
    );
  };
  const per = Math.ceil(files.length / 12);
  const start = l.s.counts.length;
  const r2Before = { ...l.r2 };
  let replyBytes = 0;
  for (let index = 0; index < 12; index++) {
    if (!batch) {
      const sent = await l.send(index);
      replyBytes += Buffer.byteLength(JSON.stringify(sent.body));
    } else {
      const bytes = Buffer.from(`synthetic shard ${index} log `.repeat(64));
      l.logs.set(digest(bytes), bytes);
      const result = {
        index,
        exitCode: 0,
        log: { object: { sha256: digest(bytes), size: bytes.length }, failureSummary: '' },
        contractReports: Object.fromEntries(
          files.slice(index * per, (index + 1) * per).map((file, i) => [file, report(index * per + i)]),
        ),
        execution: {
          startedAt: new Date(Date.now() - 60000).toISOString(),
          endedAt: new Date().toISOString(),
        },
      };
      steps.push(result);
      await fetch(
        `https://synthetic-account.r2.cloudflarestorage.com/synthetic-bucket/${resultSlotKey(run, index)}`,
        {
          method: 'PUT',
          headers: { 'if-none-match': '*' },
          body: resultEnvelopeBody({
            result,
            ...(packed ? { packed: true } : {}),
            logBytes: bytes.toString('base64'),
          }),
        },
      );
      if (packed) await notifyPackedResultBatch(targets, index, fetch, collect);
      else await fetch('https://synthetic-account.r2.cloudflarestorage.com/synthetic-bucket/?list-type=2');
    }
  }
  if (batch) {
    if (!packed)
      await fetch(
        `https://synthetic-account.r2.cloudflarestorage.com/synthetic-bucket/${resultSlotKey(run, 'coordinator')}`,
        {
          method: 'PUT',
          headers: { 'if-none-match': '*' },
          body: 'collect',
        },
      );
    if (!packed) await collect();
  }
  await l.conclude();
  for (const task of l.scheduled.filter(task => task.name === 'projectHostedTestTimings:record'))
    await l.s.transaction(task.name, timingStore.record, task.input);
  const meters = l.s.counts.slice(start),
    perFunction = {};
  for (const m of meters) {
    const f = (perFunction[m.name] ??= { calls: 0, readBytes: 0, writeBytes: 0 });
    f.calls++;
    f.readBytes += m.readBytes;
    f.writeBytes += m.writeBytes;
  }
  return {
    mutations: meters.length,
    readBytes: sum(meters, 'readBytes'),
    writeBytes: sum(meters, 'writeBytes'),
    replyBytes,
    planReplyBytes,
    perFunction,
    r2: Object.fromEntries(Object.entries(l.r2).map(([key, value]) => [key, value - r2Before[key]])),
    calls: meters.length + (batch ? 1 : 12),
  };
}

test('CI byte ledger: interleaved identical 12-shard report sets cut I/O and CI reply bytes', async t => {
  const pairs = [];
  for (let pair = 0; pair < 11; pair++) {
    const before = await resultPathBytes(t, false),
      after = await resultPathBytes(t, true);
    assert(after.mutations < before.mutations);
    assert(after.readBytes < before.readBytes);
    assert(after.writeBytes < before.writeBytes);
    assert(after.replyBytes < 1024, 'the CI reply has only run identity, status and counts');
    pairs.push({ before, after });
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const measured = Object.fromEntries(
    ['calls', 'readBytes', 'writeBytes', 'replyBytes', 'planReplyBytes'].map(key => [
      key,
      median(pairs.map(p => p.after[key])),
    ]),
  );
  Object.assign(measured, {
    r2ClassA: pairs[0].after.r2.classA,
    r2ClassB: pairs[0].after.r2.classB,
    r2BytesPut: median(pairs.map(p => p.after.r2.bytesPut)),
  });
  const verdicts = judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'ci-batch-fixture', measured);
  for (const line of formatCostVerdicts(verdicts)) t.diagnostic(line);
  assert(!verdicts.some(v => v.status === 'fail'), 'CI batching byte ledger regressed');
  const model = row =>
    ((row.readBytes + row.writeBytes) / 1e6) * 0.2 +
    ((row.replyBytes + row.planReplyBytes) / 1e6) * 0.12 +
    row.r2.classA * 0.0045 +
    row.r2.classB * 0.00036;
  const differences = pairs.map(p => model(p.after) - model(p.before));
  const interval = bootstrapInterval(differences, { seed: 1, resamples: 10000 });
  assert(
    interval.excludesZero && interval.medianDifference < 0,
    'modeled billed I/O, CI egress and R2 costs fall together',
  );
  t.diagnostic(
    JSON.stringify({
      before: pairs[0].before,
      after: pairs[0].after,
      measured,
      usdPer1000: {
        before: median(pairs.map(p => model(p.before))),
        after: median(pairs.map(p => model(p.after))),
        interval,
      },
      pairs: pairs.map(p => ({
        beforeIo: p.before.readBytes + p.before.writeBytes,
        afterIo: p.after.readBytes + p.after.writeBytes,
      })),
    }),
  );
});

test('immutable result slots reconcile a lost PUT reply and refuse different retry bytes', async () => {
  const { uploadResultSlot } = await import('../dist/hosted-actions-result-batch.js');
  const target = {
    put: { url: 'https://synthetic.invalid/slot', headers: { 'if-none-match': '*' } },
    get: 'https://synthetic.invalid/slot',
  };
  let saved;
  const request = async (_url, init = {}) => {
    if (init.method !== 'PUT') return new Response(saved);
    if (saved !== undefined) return new Response(null, { status: 412 });
    saved = init.body;
    throw new TypeError('synthetic lost reply');
  };
  await assert.rejects(uploadResultSlot(target, 'original', request), TypeError);
  assert.equal(await uploadResultSlot(target, 'original', request), false);
  await assert.rejects(uploadResultSlot(target, 'changed', request), code('WORK_OPERATION_CHANGED'));
});

test('signed workflow completion recovers a lost batch coordinator without trusting the job verdict', async t => {
  const l = await landing(t, 2, true),
    run = l.stored();
  for (let index = 0; index < 2; index++)
    l.inbox.set(
      `/synthetic-bucket/${resultSlotKey(run, index)}`,
      Buffer.from(resultEnvelopeBody({ result: { index, exitCode: 0 } })),
    );
  await l.conclude();
  assert.equal(l.stored().status, 'running', 'the provider event schedules evidence collection');
  const task = l.scheduled.find(task => task.name === 'projectHostedActionsBatch:collect');
  assert(task);
  await batchCollector.collect._handler(l.ctx, task.input);
  assert.equal(l.stored().status, 'passed');
  assert([...l.s.tables.projectHostedCheckRuns.values()][0].verdictKey);
});

test('provider completion with missing shards retains received failure details and cannot pass', async t => {
  const l = await landing(t, 3, true),
    run = l.stored();
  l.inbox.set(
    `/synthetic-bucket/${resultSlotKey(run, 0)}`,
    Buffer.from(
      resultEnvelopeBody({
        result: {
          index: 0,
          exitCode: 1,
          contractReports: {
            'tests/interrupted.test.mjs': { failed: true, firstError: 'received before interruption' },
          },
        },
      }),
    ),
  );
  await l.conclude('failure');
  const task = l.scheduled.find(task => task.name === 'projectHostedActionsBatch:collect');
  await batchCollector.collect._handler(l.ctx, task.input);
  assert.equal(l.stored().status, 'failed');
  assert.equal(
    (await l.s.status(l.id.runId)).contractReports['tests/interrupted.test.mjs'].firstError,
    'received before interruption',
  );
  assert.equal([...l.s.tables.projectHostedCheckRuns.values()][0].verdictKey, undefined);
});

test('cancellation clears regenerable batch inbox bytes without accepting a late result', async t => {
  const l = await landing(t, 2, true),
    run = l.stored();
  l.inbox.set(
    `/synthetic-bucket/${resultSlotKey(run, 0)}`,
    Buffer.from(resultEnvelopeBody({ result: { index: 0, exitCode: 0 } })),
  );
  await l.s.cancel(l.id.runId);
  const task = l.scheduled.find(task => task.name === 'projectHostedActionsBatch:collect');
  assert(task, 'the existing terminal event schedules cleanup');
  await batchCollector.collect._handler(l.ctx, task.input);
  assert.equal(l.stored().status, 'cancelled');
  assert.equal(l.stored().counts.completed, 0);
  assert(![...l.inbox.keys()].some(key => key.includes('/check-results/')));
});

test('exact-tree reuse across Candidates retains provenance and rejects unrecorded aliases or a changed definition', async t => {
  const l = await batchedLanding(t, 2, [
    { index: 0, exitCode: 0 },
    { index: 1, exitCode: 0 },
  ]);
  const original = l.stored();
  const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
  const candidate = { ...l.s.candidate, id: crypto.randomUUID(), version: 0 };
  await l.s.run('same-tree-candidate', records.writeHostedRecord, {
    ...l.s.auth,
    expectedVersion: null,
    record: candidate,
  });
  const request = { ...original.request, candidateId: candidate.id, operationId: crypto.randomUUID() };
  assert.equal((await l.s.enqueue(request)).id, original.id);
  assert.equal(
    (await l.s.enqueue(request)).id,
    original.id,
    'lost enqueue reply reconciles the original reuse',
  );
  const { read } = await import('./hosted-checks-fixture.mjs');
  const evidence = {
    ...l.id,
    actor: original.actor,
    candidateId: candidate.id,
    head: original.request.expectedHead,
    checkId: original.check.id,
    definition: original.check.definition,
    configuration: original.request.expectedConfiguration,
    environment: original.request.expectedEnvironment,
    authorityEpoch: original.request.authorityEpoch,
  };
  const requireEvidence = { _handler: (ctx, input) => read.requireHostedCheckEvidence(ctx, input) };
  assert.equal((await l.s.transaction('same-tree-evidence', requireEvidence, evidence)).id, original.id);
  await assert.rejects(
    l.s.transaction('unrecorded-alias', requireEvidence, { ...evidence, candidateId: crypto.randomUUID() }),
    code('EVIDENCE_CHANGED'),
  );
  const definition = await l.s.configure(
    {
      kind: 'definition',
      checkId: original.check.id,
      command: {
        name: 'verify',
        executable: 'node',
        args: ['scripts/changed-check.mjs'],
        environmentLabel: 'clean',
      },
    },
    original.request.expectedDefinition,
  );
  const changed = await l.s.enqueue({
    ...request,
    operationId: crypto.randomUUID(),
    expectedDefinition: definition.digest,
  });
  assert.notEqual(changed.id, original.id);
  assert.equal(changed.status, 'queued');
});

test('S7: twelve packed shard objects, election and final manifest use at most 14 Class A operations, preserving exact pins and replay', async t => {
  const legacy = await resultPathBytes(t, true, false);
  const packed = await resultPathBytes(t, true, true);
  assert.equal(legacy.r2.classA, 38);
  assert.equal(packed.r2.classA, 14);
  assert(packed.calls <= legacy.calls, 'no extra Convex calls per landing');
  t.diagnostic(JSON.stringify({ legacy, packed }));
  const l = await landing(t, 2, true, true),
    run = l.stored();
  const log = Buffer.from('exact retained shard log');
  const result = {
    index: 0,
    exitCode: 0,
    log: { object: { sha256: digest(log), size: log.length }, failureSummary: '' },
  };
  const body = resultEnvelopeBody({ packed: true, result, logBytes: log.toString('base64') });
  const key = `/synthetic-bucket/${resultSlotKey(run, 0)}`;
  l.inbox.set(key, Buffer.from(body));
  l.inbox.set(
    `/synthetic-bucket/${resultSlotKey(run, 1)}`,
    Buffer.from(
      resultEnvelopeBody({ packed: true, result: { ...result, index: 1 }, logBytes: log.toString('base64') }),
    ),
  );
  await l.conclude();
  const task = l.scheduled.find(task => task.name === 'projectHostedActionsBatch:collect');
  await batchCollector.collect._handler(l.ctx, task.input);
  assert.equal(l.stored().status, 'passed');
  const pin = [...l.s.tables.projectHostedActionsResults.values()].find(row => row.index === 0).digest;
  assert.equal(pin, checkPin(result), 'the original shard result digest is unchanged');
  const chunk = JSON.parse([...l.s.tables.projectHostedOutputChunks.values()][0].value);
  assert.deepEqual(chunk.object, result.log.object);
  const { verifyOutputBytes } = await import('../dist/hosted-output-reader.js');
  assert.deepEqual(Buffer.from(verifyOutputBytes(chunk, Buffer.from(body))), log);
  await batchCollector.collect._handler(l.ctx, task.input);
  assert(l.inbox.has(key), 'terminal replay preserves the backing object');
  assert.throws(() => verifyOutputBytes(chunk, Buffer.from(body + ' ')), code('R2_OBJECT_CHECKSUM_MISMATCH'));
  const outputRead = await import(moduleUrl('../convex/projectHostedOutputRead.ts'));
  const streamId = [...l.s.tables.projectHostedOutputStreams.values()][0].streamId;
  const link = JSON.parse(
    await l.s.transaction('packed-download', outputRead.download, { ...l.id, streamId, sequence: 0 }),
  );
  const { verifyDownloadedOutput } = await import('../dist/hosted-output-reader.js');
  assert.deepEqual(
    Buffer.from(verifyDownloadedOutput(link, new Uint8Array(await (await fetch(link.url)).arrayBuffer()))),
    log,
  );
  const cleanupStore = await import(moduleUrl('../convex/projectHostedLogCleanupStore.ts'));
  const cleanup = await import(moduleUrl('../convex/projectHostedLogCleanup.ts'));
  const invoke = (ref, input) => {
    const name = getFunctionName(ref),
      method = name.split(':')[1];
    return l.s.transaction(name, cleanupStore[method], input);
  };
  await cleanup.purgeHostedLogStream(
    { runQuery: invoke, runMutation: invoke },
    {
      projectId: l.id.projectId,
      runId: l.id.runId,
      streamId,
      actor: 'owner',
    },
  );
  assert(!l.inbox.has(key), 'cleanup deletes the retired physical envelope');
  assert(
    l.inbox.has(`/synthetic-bucket/${resultSlotKey(run, 1)}`),
    'identical logical bytes in another shard keep their own physical object',
  );
  await assert.rejects(
    l.s.transaction('retired-download', outputRead.download, { ...l.id, streamId, sequence: 0 }),
    code('LOG_PROVIDER_HELD'),
  );
});

test('S7 smoke shape: source, two twelve-shard checks and exhaust maintenance stay below 80 Class A requests', async t => {
  let storage;
  await t.test('source/main race and exhaust maintenance', async child => {
    storage = await landingStorage(child, true);
  });
  const first = await resultPathBytes(t, true),
    recheck = await resultPathBytes(t, true);
  const byCaller = {
    ...storage.r2,
    ciResults: {
      classA: first.r2.classA + recheck.r2.classA,
      classB: first.r2.classB + recheck.r2.classB,
      deletes: first.r2.deletes + recheck.r2.deletes,
    },
  };
  const measured = {
    r2ClassA: Object.values(byCaller).reduce((n, c) => n + c.classA, 0),
    r2ClassB: Object.values(byCaller).reduce((n, c) => n + c.classB, 0),
  };
  const verdicts = judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'smoke-r2-fixture', measured);
  assert.equal(verdicts.length, 2);
  assert(measured.r2ClassA <= 80, 'S7 absolute smoke ceiling');
  assert(!verdicts.some(v => v.status === 'fail'));
  const seeded = judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'smoke-r2-fixture', {
    ...measured,
    r2ClassA: 81,
  });
  assert.equal(
    seeded.find(v => v.metric === 'r2ClassA').status,
    'fail',
    'one request beyond 80 fails regardless of percentage tolerance',
  );
  t.diagnostic(
    `S7 smoke R2 ${JSON.stringify({ byCaller, measured, scope: '4,096-file source/main race, two twelve-shard CI batches and 31-day exhaust maintenance; Lane/check setup, client upload/materialization, reuse, mirror, external backup/sweep and retries excluded, not live billing' })}`,
  );
});

test('packed transport keeps a full log beside the existing metadata window in one immutable object', async () => {
  const { resultSlotBytes, readResultSlot, uploadResultSlot } =
    await import('../dist/hosted-actions-result-batch.js');
  const result = {
    index: 0,
    exitCode: 0,
    contractReports: {
      [`tests/${'synthetic-'.repeat(48000)}.test.mjs`]: { failed: false, durationMs: 1 },
    },
  };
  const logBytes = Buffer.alloc(64 * 1024, 'L').toString('base64');
  const body = resultEnvelopeBody({ packed: true, result, logBytes });
  assert(Buffer.byteLength(JSON.stringify(result)) < resultSlotBytes);
  assert(Buffer.byteLength(body) > resultSlotBytes);
  assert.equal(await readResultSlot(new Response(body), true), body);
  await assert.rejects(readResultSlot(new Response(body)), code('BAD_ARGUMENT'));
  let original;
  const request = async (_url, init) => {
    if (init?.method !== 'PUT') return new Response(original);
    if (original) return new Response(null, { status: 412 });
    original = init.body;
    return new Response(null, { status: 200 });
  };
  const target = {
    put: { url: 'https://synthetic.invalid/slot', headers: { 'if-none-match': '*' } },
    get: 'https://synthetic.invalid/slot',
  };
  assert.equal(await uploadResultSlot(target, body, request), true);
  assert.equal(await uploadResultSlot(target, body, request), false);
});

test('S7 contract: completed packed shards reach Forge before optional pack/proof workflow completion', async t => {
  const l = await landing(t, 2, true, true),
    run = l.stored();
  // Both fixed supervisors have returned from their successful immutable uploads. The optional
  // pack/proof jobs are still running, so no workflow_run:completed event exists yet.
  const targets = await batchCollector.resultBatchTargets(run, true);
  let notifications = 0;
  for (let index = 0; index < 2; index++) {
    l.inbox.set(
      `/synthetic-bucket/${resultSlotKey(run, index)}`,
      Buffer.from(resultEnvelopeBody({ packed: true, result: { index, exitCode: 0 } })),
    );
    await notifyPackedResultBatch(targets, index, fetch, async () => {
      notifications++;
      const response = await handle._handler(
        l.ctx,
        new Request(`${audience}/checks/actions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${oidc()}` },
          body: JSON.stringify({ ...l.id, fence: run.fence, command: { kind: 'results' } }),
        }),
      );
      assert.equal(response.status, 200);
      await response.body?.cancel();
    });
  }
  assert.equal(notifications, 1);
  assert.equal(
    l.scheduled.some(task => task.name === 'projectHostedActionsBatch:collect'),
    false,
  );
  // Friction 0064c3b2 already requires this for the legacy coordinator path. A packed transport
  // must retain that behavior rather than wait for the optional workflow jobs (20-minute timeout).
  assert.equal(
    l.stored().counts.completed,
    2,
    'required shard completion must reach the existing provider-jobs verdict path before optional jobs finish',
  );
});

test('packed required-shard failure reaches Forge through the election before optional jobs complete', async t => {
  const l = await landing(t, 2, true, true),
    run = l.stored();
  const targets = await batchCollector.resultBatchTargets(run, true);
  let notifications = 0;
  for (let index = 0; index < 2; index++) {
    l.inbox.set(
      `/synthetic-bucket/${resultSlotKey(run, index)}`,
      Buffer.from(resultEnvelopeBody({ packed: true, result: { index, exitCode: index === 0 ? 7 : 0 } })),
    );
    await notifyPackedResultBatch(targets, index, fetch, async () => {
      notifications++;
      await batchCollector.collectResultBatch(l.ctx, {
        ...l.id,
        fence: run.fence,
        executionId: run.executionId,
        claims: JSON.stringify(claims()),
      });
    });
  }
  assert.equal(notifications, 1);
  assert.equal(l.stored().counts.completed, 2);
  assert.equal(l.stored().counts.failed, 1);
  assert.notEqual(l.stored().status, 'passed');
  assert.equal([...l.s.tables.projectHostedCheckRuns.values()][0].verdictKey, undefined);
});

test('S3 report object adds exactly one Class A to S7 while healthy calls and database I/O do not rise', async t => {
  const before = await resultPathBytes(t, true, true);
  const after = await resultPathBytes(t, true, true, true);
  t.diagnostic(JSON.stringify({ before, after }));
  assert(after.calls <= before.calls, JSON.stringify({ before, after }));
  assert(after.mutations <= before.mutations);
  assert(after.readBytes < before.readBytes);
  assert(after.writeBytes < before.writeBytes);
  assert.equal(after.r2.classA, before.r2.classA + 1);
  assert.equal(after.r2.classA, 15);
});

test('S3 cancel, watchdog and provider recovery fold exactly the present slots without report rows or cancelled timings', async t => {
  for (const kind of ['cancel', 'watchdog', 'provider']) {
    const l = await landing(t, 3, true, true, true),
      run = l.stored();
    for (const index of [0, 2])
      l.inbox.set(
        `/synthetic-bucket/${resultSlotKey(run, index)}`,
        Buffer.from(
          resultEnvelopeBody({
            result: {
              index,
              exitCode: 1,
              contractReports: {
                [`tests/present-${index}.test.mjs`]: {
                  failed: true,
                  durationMs: 17,
                  firstError: 'present slot',
                },
              },
            },
          }),
        ),
      );
    if (kind === 'provider') await l.conclude('failure');
    else {
      if (kind === 'cancel') await l.s.cancel(run.id);
      else await l.s.transaction('watchdog', direct.expire, { ...l.id, fence: run.fence });
      const work = l.scheduled.find(task => task.name === 'projectHostedActionsBatch:collect');
      assert(work);
      await batchCollector.collect._handler(l.ctx, work.input);
    }
    assert.equal(l.s.tables.projectHostedActionsResults.size, 0);
    assert.equal(l.stored().testFiles.counts.total, 2);
    assert.equal(l.stored().testFiles.counts.failed, 2);
    const object = [...l.inbox].find(([key]) => key.includes('/reports/'));
    assert.deepEqual(Object.keys(JSON.parse(object[1])).sort(), [
      'tests/present-0.test.mjs',
      'tests/present-2.test.mjs',
    ]);
    if (kind !== 'provider') assert.equal(l.s.tables.projectHostedTestTimings.size, 0);
    assert(!l.scheduled.some(task => task.name === 'projectHostedTestTimings:record'));
  }
});

test('S3 provider cancellation never contributes timings, including after an early failed or held passing fold', async t => {
  for (const failed of [false, true]) {
    const l = await batchedLanding(
      t,
      2,
      [0, 1].map(index => ({
        index,
        exitCode: failed ? 1 : 0,
        contractReports: { [`tests/cancelled-${index}.test.mjs`]: { failed, durationMs: 123 } },
      })),
      { r2Reports: true, conclude: false },
    );
    assert.equal(l.s.tables.projectHostedTestTimings.size, 0, 'a provisional fold never stamps timings');
    await l.conclude('cancelled');
    assert.equal(
      l.s.tables.projectHostedTestTimings.size,
      0,
      'the known cancelled conclusion never stamps timings',
    );
    const row = [...l.s.tables.projectHostedCheckRuns.values()][0];
    assert.equal(row.reportTimingStamp, undefined);
    assert.equal(row.reportConclusion, 'cancelled');
  }
});

test('S3 header-only exact-tree verdict reuse and old direct-runner refusal add no report-row reads', async t => {
  const l = await batchedLanding(
    t,
    2,
    [0, 1].map(index => ({
      index,
      exitCode: 0,
      contractReports: { [`tests/reuse-${index}.test.mjs`]: { failed: false, durationMs: 10 } },
    })),
    { r2Reports: true },
  );
  const original = l.stored(),
    start = l.s.counts.length;
  const reused = await l.s.enqueue({ ...original.request, operationId: crypto.randomUUID() });
  assert.equal(reused.id, original.id);
  assert.equal(l.s.tables.projectHostedCheckRuns.size, 1);
  assert(l.s.counts.slice(start).every(count => !count.touched.includes('projectHostedActionsResults')));
  await assert.rejects(
    l.s.transaction('old-result', results.result, {
      ...l.id,
      claims: JSON.stringify(claims()),
      fence: original.fence,
      result: JSON.stringify({ index: 0, exitCode: 0 }),
    }),
    code('CLI_UPGRADE_REQUIRED'),
  );
  assert.equal(l.s.tables.projectHostedActionsResults.size, 0);
});

test('S3 duration arguments above 768 KiB page through idempotent settlement without report-row reads', async t => {
  const names = Array.from(
    { length: 5000 },
    (_, i) => `tests/timing-${i}-${'long-path-'.repeat(16)}.test.mjs`,
  );
  const steps = Array.from({ length: 12 }, (_, index) => ({
    index,
    exitCode: 0,
    contractReports: Object.fromEntries(
      names.filter((_, i) => i % 12 === index).map(file => [file, { failed: false, durationMs: 13 }]),
    ),
  }));
  const l = await batchedLanding(t, 12, steps, { r2Reports: true });
  const row = [...l.s.tables.projectHostedCheckRuns.values()][0];
  assert(row.reportTimingParts.length > 1);
  assert.equal(row.reportTimingComplete, true);
  assert(l.s.counts.some(count => count.name === 'projectHostedTestTimings:argumentsPage'));
  assert(l.s.counts.every(count => !count.touched.includes('projectHostedActionsResults')));
  const before = [...l.s.tables.projectHostedTestTimings.values()][0].history;
  await l.conclude();
  assert.equal([...l.s.tables.projectHostedTestTimings.values()][0].history, before);
});
