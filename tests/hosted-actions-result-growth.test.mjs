// SPDX-License-Identifier: Apache-2.0
// Issue d0f8472a: per-call Convex cost of Actions shard results must not grow with the
// reports earlier shards already stored. Drives the real HTTP handler with inline logs
// (the runner's common path) over a realistic report set and meters every mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { actionsIssuer } from '../dist/github-actions-oidc.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { checkPin } from '../dist/hosted-check.js';
import { savePin } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { applyCheckRetryBudget, capCheckReports } from '../dist/check-report-cap.js';
import { checkFileSummary } from '../dist/check-file-summary.js';
import { mergeShardReports, settlePoolPending } from '../dist/hosted-actions-pool.js';
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const sessions = await import(moduleUrl('../convex/projectHostedActionsSession.ts'));
const plans = await import(moduleUrl('../convex/projectHostedActionsPlan.ts'));
const results = await import(moduleUrl('../convex/projectHostedActionsResults.ts'));
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

async function landing(t, shards) {
  variables(t, {
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
    storage = new Map();
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${s.projectId}=${repository}`;
  s.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async () => 'scheduled',
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
  const reserved = await s.transaction('reserve', direct.reserve, id);
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
  });
  const logs = new Map();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === `${actionsIssuer}/.well-known/jwks`) return jwks();
    if (init.method === 'PUT') return new Response(null, { status: 200 });
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
  };
  const ctx = {
    runMutation: (ref, input) => {
      const name = getFunctionName(ref),
        [module, method] = name.split(':');
      return s.transaction(name, modules[module][method], input);
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
  return { s, id, send, post, stored, responses };
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
  const row = [...l.s.tables.projectHostedCheckRuns.values()].find(row => row.runId === l.id.runId);
  return {
    l,
    calls,
    body,
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

test('realistic 8-shard landing with two replayed results: per-function totals', async t => {
  const { calls, body, runRowBytes } = await measure(t, 8, [2, 5]);
  assert.equal(body.status, 'passed');
  const replays = calls.filter(call => call.replay);
  assert.equal(replays.length, 2);
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
    assert.equal(result.readDocumentsByTable.projectHostedCheckRuns, 3, 'run rows read once');
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
  assert.equal(l.stored().status, 'passed');
  assert(![...l.s.tables.projectHostedOutputHeads.values()][0].final);
});
