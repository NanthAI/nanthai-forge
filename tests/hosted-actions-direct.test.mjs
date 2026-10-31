// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify, sign, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { verifyActionsOidc, validateActionsClaims, actionsIssuer } from '../dist/github-actions-oidc.js';
import { actionsPreflightSignature } from '../dist/hosted-actions-preflight.js';
import { hostedActionsCapabilities } from '../dist/hosted-actions-capabilities.js';
import { hostedCheckRunSchema } from '../dist/hosted-check.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { checkPin } from '../dist/hosted-check.js';
import { savePin } from '../dist/hosted-save.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
const { githubAppJwt, installationToken, actionsPermissions } = await import(
  moduleUrl('../convex/githubAppToken.ts')
);
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const packs = await import(moduleUrl('../convex/projectSourcePacks.ts'));
const sessions = await import(moduleUrl('../convex/projectHostedActionsSession.ts'));
const preflight = await import(moduleUrl('../convex/projectHostedActionsPreflight.ts'));
const source = await import(moduleUrl('../convex/projectHostedActionsSource.ts'));
const plans = await import(moduleUrl('../convex/projectHostedActionsPlan.ts'));
const results = await import(moduleUrl('../convex/projectHostedActionsResults.ts'));
const webhooks = await import(moduleUrl('../convex/projectHostedActionsWebhook.ts'));
const { handle } = await import(moduleUrl('../convex/projectHostedActionsHttp.ts'));

/** Owner-proven repository bindings are a deployment setting; tests bind their own synthetic project. */
const bindRepository = (t, projectId, repo) => {
  const prior = process.env.FORGE_GITHUB_REPO_BINDINGS;
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${projectId}=${repo}`;
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_GITHUB_REPO_BINDINGS;
    else process.env.FORGE_GITHUB_REPO_BINDINGS = prior;
  });
};

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sha = 'a'.repeat(40),
  repository = 'synthetic/project',
  audience = 'https://forge.example';
const claims = (changes = {}) => ({
  iss: actionsIssuer,
  aud: audience,
  exp: Date.now() / 1000 + 300,
  nbf: Date.now() / 1000 - 30,
  iat: Date.now() / 1000 - 30,
  repository,
  workflow_ref: `${repository}/.github/workflows/forge-check.yml@refs/heads/main`,
  workflow_sha: sha,
  ref: 'refs/heads/main',
  event_name: 'workflow_dispatch',
  run_id: '123',
  run_attempt: '1',
  runner_environment: 'github-hosted',
  ...changes,
});
function variables(t, values) {
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}
function oidc(value = claims()) {
  const encode = input => Buffer.from(JSON.stringify(input)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: 'synthetic-key' })}.${encode(value)}`;
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
async function fixture(t, shards = 2, runsOn = 'ubuntu-latest') {
  variables(t, {
    CONVEX_SITE_URL: audience,
    CONVEX_CLOUD_URL: 'https://forge.convex.cloud',
    FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-check-key',
    R2_ACCOUNT_ID: 'synthetic-account',
    R2_BUCKET: 'synthetic-bucket',
    R2_ACCESS_KEY_ID: 'synthetic-access',
    R2_SECRET_ACCESS_KEY: 'synthetic-secret',
  });
  const s = await checksFixture(),
    scheduled = [],
    cancelled = [],
    storage = new Map();
  s.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async (delay, ref, input) => {
        const id = `scheduled-${scheduled.length}`;
        scheduled.push({ id, delay, name: getFunctionName(ref), input });
        return id;
      },
      cancel: async id => cancelled.push(id),
    };
    ctx.storage = { getMetadata: async id => storage.get(id) ?? null };
  });
  const runner = {
    provider: 'github-actions',
    repository,
    runsOn,
    runtime: hostedActionsRuntime,
    environmentFingerprint: s.runner.environmentFingerprint,
  };
  bindRepository(t, s.projectId, repository);
  const configuration = await s.configure({ kind: 'runner', configuration: runner }, s.configuration.digest);
  const run = await s.enqueue(s.selection({ expectedConfiguration: configuration.digest }));
  const id = { projectId: s.projectId, runId: run.id };
  const call = (module, method, args) => s.transaction(`direct-${method}`, module[method], args);
  const reserve = () => call(direct, 'reserve', id);
  const bind = async () => {
    const reserved = await reserve();
    await call(direct, 'observe', { ...id, fence: reserved.fence, outcome: 'accepted', executionId: '123' });
    return reserved;
  };
  const input = (overrides = {}) => ({ ...id, claims: JSON.stringify(claims()), ...overrides });
  const prepare = async () => {
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
    const selectionStorage = 'selection-storage',
      recipeStorage = 'recipe-storage';
    storage.set(selectionStorage, {
      sha256: savePin(recipe.selection).sha256,
      size: savePin(recipe.selection).size,
    });
    storage.set(recipeStorage, { sha256: savePin(recipe).sha256, size: savePin(recipe).size });
    return call(plans, 'prepare', {
      ...input(),
      recipe: JSON.stringify(recipe),
      lockfile: 'e'.repeat(64),
      selectionStorage,
      recipeStorage,
    });
  };
  return { ...s, scheduled, cancelled, storage, run, id, input, call, reserve, bind, prepare };
}
test('App JWT uses RS256 for GitHub PKCS#1 and PKCS#8; installation is derived per call', async t => {
  for (const type of ['pkcs1', 'pkcs8']) {
    const jwt = await githubAppJwt('12345', privateKey.export({ type, format: 'pem' }));
    const [header, payload, signature] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '12345');
    assert(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    );
  }
  const calls = [];
  const request = async (url, init) => {
    calls.push([url, init]);
    return Response.json(url.endsWith('/installation') ? { id: 9 } : { token: 'synthetic-token' });
  };
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  });
  bindRepository(t, 'synthetic-project', repository);
  for (let i = 0; i < 2; i++)
    assert.equal(
      await installationToken({}, 'synthetic-project', repository, actionsPermissions, request),
      'synthetic-token',
    );
  assert.equal(calls.length, 4);
  assert.equal(calls[0][0], 'https://api.github.com/repos/synthetic/project/installation');
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    repositories: ['project'],
    permissions: { actions: 'write', contents: 'read' },
  });
});
test('OIDC cryptography and all pinned claims reject substitution', async () => {
  assert.equal((await verifyActionsOidc(oidc(), audience, async () => jwks())).run_id, '123');
  for (const changes of [
    { repository: 'wrong/repo' },
    { workflow_ref: `${repository}/.github/workflows/wrong.yml@refs/heads/main` },
    { ref: 'refs/heads/other' },
    { run_id: '999' },
    { run_attempt: '2' },
    { workflow_sha: 'b'.repeat(40) },
    { aud: 'wrong' },
    { exp: 0 },
    { nbf: Date.now() / 1000 + 100 },
    { event_name: 'pull_request' },
  ])
    assert.throws(() =>
      validateActionsClaims(claims(changes), { audience, repository, executionId: '123', workflowSha: sha }),
    );
  const pinned = { audience, repository, executionId: '123', workflowSha: sha };
  // A run configured for GitHub-hosted labels never accepts a self-hosted runner's token.
  assert.throws(
    () =>
      validateActionsClaims(claims({ runner_environment: 'self-hosted' }), { ...pinned, selfHosted: false }),
    code('EVIDENCE_CHANGED'),
  );
  assert.equal(
    validateActionsClaims(claims({ runner_environment: 'self-hosted' }), { ...pinned, selfHosted: true })
      .run_id,
    '123',
  );
  const token = oidc(),
    [h, p, s] = token.split('.');
  const bad = `${h}.${p}.${(s[0] === 'a' ? 'b' : 'a') + s.slice(1)}`;
  await assert.rejects(
    verifyActionsOidc(bad, audience, async () => jwks()),
    code('EVIDENCE_CHANGED'),
  );
});
test('concurrent dispatch reservation and lost reply send one GitHub dispatch with no retry', async t => {
  const s = await fixture(t);
  bindRepository(t, s.id.projectId, 'synthetic/project');
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  let dispatches = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/installation')) return Response.json({ id: 9 });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-token' });
    assert(url.endsWith('/forge-check.yml/dispatches'));
    const body = JSON.parse(init.body);
    assert.equal(body.ref, 'main');
    assert.equal(body.inputs.runId, s.run.id);
    assert.equal(body.inputs.deployment, audience);
    assert.equal(body.inputs.runs_on, JSON.stringify('ubuntu-latest'));
    dispatches++;
    throw new Error('Synthetic lost reply after GitHub accepted the dispatch.');
  });
  const ctx = { runMutation: (ref, input) => s.call(direct, getFunctionName(ref).split(':')[1], input) };
  await Promise.all([direct.dispatch._handler(ctx, s.id), direct.dispatch._handler(ctx, s.id)]);
  await direct.dispatch._handler(ctx, s.id);
  assert.equal(dispatches, 1);
  assert.equal((await s.status(s.run.id)).status, 'unknown');
  // The fake records attempted scheduler calls across OCC retries; only the committed ID exists in Convex.
  const retained = (await s.status(s.run.id)).actions.watchdog;
  assert.equal(s.scheduled.filter(item => item.id === retained && item.name.endsWith(':expire')).length, 1);
  await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'requested', null)) });
  assert.equal((await s.call(sessions, 'session', s.input())).executionId, '123');
});
test('dispatch retains custom and array runner labels, and self-hosted OIDC completes the session', async t => {
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  let expected;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/installation')) return Response.json({ id: 9 });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-token' });
    assert(url.endsWith('/forge-check.yml/dispatches'));
    assert.deepEqual(JSON.parse(JSON.parse(init.body).inputs.runs_on), expected);
    return Response.json({ workflow_run_id: 123 });
  });
  for (const runsOn of ['blacksmith-4vcpu-ubuntu-2404', ['self-hosted', 'linux', 'x64']]) {
    expected = runsOn;
    const s = await fixture(t, 2, runsOn);
    bindRepository(t, s.id.projectId, 'synthetic/project');
    const ctx = { runMutation: (ref, input) => s.call(direct, getFunctionName(ref).split(':')[1], input) };
    await direct.dispatch._handler(ctx, s.id);
    assert.equal((await s.status(s.run.id)).executionId, '123');
    const selfHosted = claims({ runner_environment: 'self-hosted' });
    assert.equal(
      (await verifyActionsOidc(oidc(selfHosted), audience, async () => jwks())).runner_environment,
      'self-hosted',
    );
    const session = await s.call(sessions, 'session', s.input({ claims: JSON.stringify(selfHosted) }));
    assert.equal(session.executionId, '123');
    await assert.rejects(
      s.call(
        sessions,
        'session',
        s.input({ claims: JSON.stringify({ ...selfHosted, repository: 'other/repo' }) }),
      ),
      code('EVIDENCE_CHANGED'),
    );
  }
});
function webhook(s, action = 'completed', conclusion = 'cancelled', overrides = {}) {
  return {
    action,
    repository: { full_name: repository },
    workflow_run: {
      id: 123,
      run_attempt: 1,
      display_title: `forge-check/${s.run.id}`,
      event: 'workflow_dispatch',
      path: '.github/workflows/forge-check.yml',
      head_branch: 'main',
      head_sha: sha,
      created_at: new Date().toISOString(),
      conclusion,
      ...overrides,
    },
  };
}
test('duplicate results are immutable and complete shard evidence is needed to pass', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  const first = {
    index: 0,
    exitCode: 0,
    contractReports: { 'tests/synthetic-0.test.mjs': { durationMs: 5, failed: false } },
    testFiles: { counts: { total: 0, failed: 0, flaky: 0 }, failed: [], flaky: [] },
  };
  const send = result => s.call(results, 'result', { ...s.input(), result: JSON.stringify(result) });
  await send(first);
  assert.equal((await send(first)).counts.completed, 1);
  await assert.rejects(send({ ...first, exitCode: 1 }), code('WORK_OPERATION_CHANGED'));
  const terminal = await send({ index: 1, exitCode: 0 });
  assert.equal(terminal.status, 'passed');
  assert.equal(terminal.contractReports['tests/synthetic-0.test.mjs'].durationMs, 5);
  assert.deepEqual(terminal.testFiles.counts, { total: 1, failed: 0, flaky: 0 });
  const histories = [...s.tables.projectHostedTestTimings.values()];
  assert.equal(histories.length, 1);
  const history = JSON.parse(histories[0].history);
  assert.equal(history.files['tests/synthetic-0.test.mjs'].durationMs, 5);
  assert.deepEqual(history.runs, [s.run.id]);
  const session = await s.call(sessions, 'session', { ...s.input(), timings: true });
  assert.equal(session.run.id, s.run.id);
  assert.deepEqual(JSON.parse(session.timingHistory), history);
  assert.equal((await send(first)).status, 'passed');
  assert.equal([...s.tables.projectHostedTestTimings.values()][0].history, histories[0].history);
  assert.equal(s.cancelled.length, 1);
  const scheduled = s.scheduled.length;
  await s.call(direct, 'expire', { ...s.id, fence: terminal.fence });
  assert.equal(s.scheduled.length, scheduled);
});

test('retained shard execution intervals make Actions runner seconds observed; a missing interval stays unknown', async t => {
  for (const timed of [2, 1]) {
    const s = await fixture(t);
    await s.bind();
    await s.prepare();
    const start = Date.parse(s.run.at);
    const send = (index, seconds) =>
      s.call(results, 'result', {
        ...s.input(),
        result: JSON.stringify({
          index,
          exitCode: 0,
          ...(index < timed
            ? {
                execution: {
                  startedAt: new Date(start).toISOString(),
                  endedAt: new Date(start + seconds * 1000).toISOString(),
                },
              }
            : {}),
        }),
      });
    await send(0, 90);
    const terminal = await send(1, 30);
    assert.equal(terminal.status, 'passed');
    const shards = [...s.tables.projectHostedCheckShards.values()].map(row => JSON.parse(row.value));
    assert.equal(shards.filter(shard => shard.execution).length, timed);
    if (timed === 2) {
      assert.equal(terminal.cost.status, 'observed');
      assert.equal(terminal.cost.seconds, 120);
      assert.equal(terminal.cost.estimatedCostUsd, null, 'runner minutes are never a bill');
    } else assert.deepEqual(terminal.cost, { status: 'unknown' });
  }
});
test('implausible runner clocks are dropped without failing the shard', async () => {
  const { shardExecution, actionsExecutionCost } = await import('../dist/hosted-actions-direct.js');
  const runAt = '2026-10-30T10:00:00.000Z',
    now = Date.parse('2026-10-30T11:00:00.000Z');
  const interval = (from, to) => ({ startedAt: from, endedAt: to });
  assert.equal(shardExecution(interval(runAt, '2026-10-30T10:02:00.000Z'), runAt, now).seconds, 120);
  assert.equal(shardExecution(interval('2026-10-30T10:02:00.000Z', runAt), runAt, now), undefined);
  assert.equal(shardExecution(interval('2026-10-30T09:00:00.000Z', runAt), runAt, now), undefined);
  assert.equal(shardExecution(interval(runAt, '2026-10-30T12:00:00.000Z'), runAt, now), undefined);
  assert.equal(shardExecution(undefined, runAt, now), undefined);
  const cost = actionsExecutionCost({ id: 'run', execution: { seconds: 12, shards: 2 } }, 2);
  assert.equal(cost.status, 'observed');
  assert.equal(cost.seconds, 12);
  assert.deepEqual(actionsExecutionCost({ id: 'run', execution: { seconds: 5, shards: 1 } }, 2), {
    status: 'unknown',
  });
  assert.deepEqual(actionsExecutionCost({ id: 'run' }, 2), { status: 'unknown' });
});
test('Actions timing history is advisory, project-scoped and records completed failures only once', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  const firstSession = await s.call(sessions, 'session', { ...s.input(), timings: true });
  assert.deepEqual(JSON.parse(firstSession.timingHistory), { version: 1, files: {}, runs: [] });
  const send = result => s.call(results, 'result', { ...s.input(), result: JSON.stringify(result) });
  const file = 'tests/synthetic-0.test.mjs';
  const first = {
    index: 0,
    exitCode: 1,
    contractReports: {
      [file]: { durationMs: 250, failed: true },
      'tests/incomplete.test.mjs': { failed: true },
    },
  };
  await send(first);
  assert.equal(s.tables.projectHostedTestTimings.size, 0);
  const terminal = await send({ index: 1, exitCode: 0 });
  assert.equal(terminal.status, 'failed');
  const session = await s.call(sessions, 'session', { ...s.input(), timings: true });
  const history = JSON.parse(session.timingHistory);
  assert.deepEqual(Object.keys(history.files), [file]);
  assert.equal(history.files[file].durationMs, 250);
  await send(first);
  assert.equal([...s.tables.projectHostedTestTimings.values()][0].history, session.timingHistory);
  await assert.rejects(
    s.call(sessions, 'session', { ...s.input({ fence: 99 }), timings: true }),
    code('WORK_STALE'),
  );
  const otherProject = s.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'Other project',
    currentBackup: null,
    revision: 0,
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  await assert.rejects(s.call(sessions, 'session', { ...s.input(), projectId: otherProject, timings: true }));
  assert.equal(s.tables.projectHostedTestTimings.size, 1);
});

test('first planning session bootstraps weights from bounded, already retained terminal reports', async t => {
  const s = await fixture(t);
  const previousId = randomUUID(),
    file = 'tests/synthetic-0.test.mjs';
  s.insert('projectHostedCheckRuns', {
    projectId: s.projectId,
    runId: previousId,
    candidateId: s.run.request.candidateId,
    status: 'passed',
    value: JSON.stringify({
      ...s.run,
      id: previousId,
      status: 'passed',
      endedAt: '2026-01-01T00:00:00.000Z',
      contractReports: { [file]: { durationMs: 300, failed: false } },
    }),
  });
  await s.bind();
  const session = await s.call(sessions, 'session', { ...s.input(), timings: true });
  const history = JSON.parse(session.timingHistory);
  assert.equal(history.files[file].durationMs, 300);
  assert.deepEqual(history.runs, [previousId]);
  assert.equal(s.tables.projectHostedTestTimings.size, 0, 'planning does not write history');
  const meter = s.counts.at(-1);
  assert(meter.documents < 10);
  assert.equal(
    meter.touched.filter(table => table === 'projectHostedCheckRuns').length,
    3,
    'current run and two bounded terminal lookups',
  );
  await s.prepare();
  await s.call(results, 'result', {
    ...s.input(),
    result: JSON.stringify({
      index: 0,
      exitCode: 0,
      contractReports: { [file]: { durationMs: 100, failed: false } },
    }),
  });
  await s.call(results, 'result', { ...s.input(), result: JSON.stringify({ index: 1, exitCode: 0 }) });
  const stored = JSON.parse([...s.tables.projectHostedTestTimings.values()][0].history);
  assert.equal(stored.files[file].durationMs, 240);
  assert.deepEqual(stored.runs, [previousId, s.run.id]);
});
test('webhook backstops cancellation, failure, timeout and missing evidence; does not fabricate a pass', async t => {
  for (const [conclusion, status] of [
    ['cancelled', 'cancelled'],
    ['failure', 'failed'],
    ['timed_out', 'interrupted'],
    ['success', 'interrupted'],
  ]) {
    const s = await fixture(t);
    await s.bind();
    await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'completed', conclusion)) });
    assert.equal((await s.status(s.run.id)).status, status);
    await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'completed', conclusion)) });
    assert.equal(s.cancelled.length, 1);
  }
});
test('OIDC/session and webhook retain epoch, actor and dispatch fencing before replay', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  await assert.rejects(
    s.call(sessions, 'session', s.input({ claims: JSON.stringify(claims({ run_id: '999' })) })),
    code('EVIDENCE_CHANGED'),
  );
  await assert.rejects(s.call(sessions, 'session', s.input({ fence: 99 })), code('WORK_STALE'));
  await assert.rejects(
    s.call(webhooks, 'receive', {
      payload: JSON.stringify(webhook(s, 'completed', 'cancelled', { id: 999 })),
    }),
    code('EVIDENCE_CHANGED'),
  );
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.call(sessions, 'session', s.input()), code('SOURCE_AUTHORITY_CHANGED'));
  await assert.rejects(s.call(direct, 'expire', { ...s.id, fence: 1 }), code('SOURCE_AUTHORITY_CHANGED'));
});
test('bounded source windows at doubled dogfood scale stay O(pages); idle schedules zero', async t => {
  const started = performance.now(),
    s = await fixture(t, 9);
  await s.bind();
  await s.prepare();
  await s.call(sessions, 'session', s.input());
  await s.call(sessions, 'session', { ...s.input(), timings: true });
  const pins = Array.from({ length: 6000 }, (_, i) => s.put(`synthetic source ${i}`));
  const baseline = s.counts.length,
    scheduled = s.scheduled.length;
  let calls = 0,
    maxPage = 0,
    maxMetadataBytes = 0;
  for (let start = 0; start < pins.length; start += 400) {
    const rows = await s.call(source, 'resolve', {
      ...s.input(),
      digests: pins.slice(start, start + 400).map(pin => pin.sha256),
    });
    calls++;
    maxPage = Math.max(maxPage, rows.length);
    maxMetadataBytes = Math.max(maxMetadataBytes, Buffer.byteLength(JSON.stringify(rows)));
    assert(maxMetadataBytes < 512 * 1024);
    assert(rows.every(row => row.url && row.descriptor.recipe === null));
  }
  assert.equal(calls, 15);
  assert.equal(maxPage, 400);
  assert.equal(s.scheduled.length, scheduled);
  const meters = s.counts.slice(baseline),
    documents = meters.reduce((n, m) => n + m.documents, 0);
  assert(documents <= 6200);
  assert(meters.every(m => m.writes === 0));
  const preparedRun = await s.status(s.run.id);
  const spawnInput = {
    ...s.id,
    fence: preparedRun.fence,
    signature: actionsPreflightSignature(preparedRun, 'synthetic-check-key'),
  };
  for (let index = 0; index < 9; index++) {
    assert.deepEqual(await s.call(preflight, 'check', spawnInput), { status: 'active' });
    await s.call(results, 'result', {
      ...s.input(),
      result: JSON.stringify({
        index,
        exitCode: 0,
        log: { object: { sha256: 'f'.repeat(64), size: 16 }, failureSummary: '' },
      }),
    });
  }
  assert.equal((await s.status(s.run.id)).status, 'passed');
  const runMeters = s.counts.filter(m => m.name === 'checkEnqueue' || m.name.startsWith('direct-'));
  const totalReads = runMeters.reduce((n, m) => n + m.documents, 0),
    totalWrites = runMeters.reduce((n, m) => n + m.writes, 0);
  assert(totalReads < 6500);
  assert(totalWrites < 200);
  const terminalSchedules = s.scheduled.length;
  await s.call(direct, 'expire', { ...s.id, fence: 1 });
  await s.call(sessions, 'session', s.input());
  assert.equal(s.scheduled.length, terminalSchedules);
  // Preserve the old budget independently; the approved pre-spawn query is +1/job.
  const legacyBudget = (n, jobs) => 2 * Math.ceil(n / 400) + jobs * 5 + 17;
  assert(legacyBudget(3000, 9) <= 80);
  assert(legacyBudget(6000, 9) <= 92);
  const budget = (n, jobs) => legacyBudget(n, jobs) + jobs;
  const preflights = s.counts.filter(m => m.name === 'direct-check');
  assert.equal(preflights.length, 9);
  assert(preflights.every(m => m.writes === 0 && m.documents <= 5));
  t.diagnostic(
    JSON.stringify({
      objects: pins.length,
      sourceCalls: calls,
      totalReads,
      totalWrites,
      documents,
      maxPage,
      maxMetadataBytes,
      writes: meters.reduce((n, m) => n + m.writes, 0),
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
      preflightQueries: preflights.length,
      preflightReads: preflights.reduce((n, m) => n + m.documents, 0),
      legacyCheckCalls3000Full: legacyBudget(3000, 9),
      checkCalls3000Full: budget(3000, 9),
      checkCalls3000Scoped: budget(3000, 2),
      checkCalls6000Full: budget(6000, 9),
    }),
  );
});
test('HTTP rejects forged OIDC before any source or database access', async t => {
  variables(t, { CONVEX_SITE_URL: audience });
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const response = await handle._handler(
    {
      runMutation: () => {
        throw new Error('Must not reach database.');
      },
    },
    new Request(`${audience}/checks/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oidc(claims({ aud: 'other' }))}` },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, 'authorization');
});

test('OIDC HTTP commits one bounded log with its shard result and reconciles a lost reply', async t => {
  const s = await fixture(t, 1);
  await s.bind();
  await s.prepare();
  const bytes = Buffer.from('synthetic bounded failure summary');
  const { digest } = await import('../dist/hash.js');
  const result = {
    index: 0,
    exitCode: 7,
    log: { object: { sha256: digest(bytes), size: bytes.length }, failureSummary: 'synthetic failure' },
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === `${actionsIssuer}/.well-known/jwks`) return jwks();
    if (init.method === 'PUT') return new Response(null, { status: 200 });
    assert.equal(init.method, 'HEAD');
    const finalRoot = [...s.tables.projectHostedOutputHeads.values()][0];
    if (url.includes('checks') && !url.includes(digest(bytes))) {
      const { rootForOutput } = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
      const { canonicalPayload } = await import('../dist/hosted-source-operation.js');
      const rootBytes = Buffer.from(canonicalPayload(rootForOutput(s.id, '123', finalRoot)));
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(rootBytes.length),
          'x-amz-checksum-sha256': Buffer.from(digest(rootBytes), 'hex').toString('base64'),
        },
      });
    }
    return new Response(null, {
      status: 200,
      headers: {
        'content-length': String(bytes.length),
        'x-amz-checksum-sha256': Buffer.from(digest(bytes), 'hex').toString('base64'),
      },
    });
  });
  const finalOutput = await import(moduleUrl('../convex/projectHostedActionsOutput.ts'));
  const modules = {
    projectHostedActionsOutput: finalOutput,
    projectHostedActionsSession: sessions,
    projectHostedActionsResults: results,
  };
  const ctx = {
    runMutation: (ref, input) => {
      const [name, method] = getFunctionName(ref).split(':');
      return s.call(modules[name], method, input);
    },
  };
  const send = () =>
    handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({ ...s.id, fence: 1, command: { kind: 'result', result } }),
      }),
    );
  const first = await send();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, 'failed');
  const duplicate = await send();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).counts.completed, 1);
  assert.equal(s.tables.projectHostedOutputChunks.size, 1);
  assert([...s.tables.projectHostedOutputHeads.values()][0].final);
  assert.equal(s.tables.projectHostedOutputStreams.size, 1);
});
test('an inline log is authorized, stored and verified inside the one result call', async t => {
  const s = await fixture(t, 1);
  await s.bind();
  await s.prepare();
  const bytes = Buffer.from('synthetic inline failure summary');
  const { digest } = await import('../dist/hash.js');
  const result = {
    index: 0,
    exitCode: 7,
    log: { object: { sha256: digest(bytes), size: bytes.length }, failureSummary: 'synthetic failure' },
  };
  const puts = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === `${actionsIssuer}/.well-known/jwks`) return jwks();
    if (init.method === 'PUT') {
      puts.push(Buffer.from(init.body));
      return new Response(null, { status: 200 });
    }
    const finalRoot = [...s.tables.projectHostedOutputHeads.values()][0];
    if (url.includes('checks') && !url.includes(digest(bytes))) {
      const { rootForOutput } = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
      const { canonicalPayload } = await import('../dist/hosted-source-operation.js');
      const rootBytes = Buffer.from(canonicalPayload(rootForOutput(s.id, '123', finalRoot)));
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': String(rootBytes.length),
          'x-amz-checksum-sha256': Buffer.from(digest(rootBytes), 'hex').toString('base64'),
        },
      });
    }
    return new Response(null, {
      status: 200,
      headers: {
        'content-length': String(bytes.length),
        'x-amz-checksum-sha256': Buffer.from(digest(bytes), 'hex').toString('base64'),
      },
    });
  });
  const finalOutput = await import(moduleUrl('../convex/projectHostedActionsOutput.ts'));
  const modules = {
    projectHostedActionsOutput: finalOutput,
    projectHostedActionsSession: sessions,
    projectHostedActionsResults: results,
  };
  const mutations = [];
  const ctx = {
    runMutation: (ref, input) => {
      mutations.push(getFunctionName(ref));
      const [name, method] = getFunctionName(ref).split(':');
      return s.call(modules[name], method, input);
    },
  };
  const send = logBytes =>
    handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({ ...s.id, fence: 1, command: { kind: 'result', result, logBytes } }),
      }),
    );
  // Bytes that differ from the declared log are refused before any database access.
  const wrong = await send(Buffer.from('short').toString('base64'));
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).reason, 'validation');
  assert.deepEqual(mutations, []);
  const first = await send(bytes.toString('base64'));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, 'failed');
  assert.deepEqual(puts[0], bytes);
  // One output and one result mutation per job; no separate output action or session read.
  assert.deepEqual(mutations.slice(0, 2), [
    'projectHostedActionsResults:output',
    'projectHostedActionsResults:result',
  ]);
  assert(!mutations.includes('projectHostedActionsSession:session'));
  assert.equal(s.tables.projectHostedOutputChunks.size, 1);
  assert([...s.tables.projectHostedOutputHeads.values()][0].final);
  assert.equal(s.tables.projectHostedOutputStreams.size, 1);
});

test('watchdog settles a dispatch with no reply or webhook once; cancelled pre-dispatch schedules no watchdog', async t => {
  const s = await fixture(t);
  await s.reserve();
  await s.call(direct, 'expire', { ...s.id, fence: 1 });
  assert.equal((await s.status(s.run.id)).status, 'interrupted');
  const size = s.scheduled.length;
  await s.call(direct, 'expire', { ...s.id, fence: 1 });
  assert.equal(s.scheduled.length, size);
  const other = await fixture(t);
  await other.cancel(other.run.id);
  assert.equal(await other.reserve(), null);
  assert.equal(other.scheduled.filter(item => item.name.endsWith(':expire')).length, 0);
});

test('App runner configuration derives runtime and environment without installation or credential secrets', async t => {
  const s = await fixture(t);
  const configure = await import(moduleUrl('../convex/projectHostedActionsConfigure.ts'));
  const definitions = await import(moduleUrl('../convex/projectHostedCheckDefinitions.ts'));
  const request = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    expected: s.run.request.expectedConfiguration,
    repository,
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runMutation: (_ref, input) => s.transaction('direct-configure', definitions.configure, input),
  };
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  });
  let lookups = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    lookups++;
    assert.equal(url, 'https://api.github.com/repos/synthetic/project/installation');
    return Response.json({ id: 9, permissions: { actions: 'write', contents: 'write' } });
  });
  const input = { projectId: s.projectId, request: JSON.stringify(request) };
  const first = JSON.parse(await configure.configure._handler(ctx, input));
  assert.equal(first.value.provider, 'github-actions');
  assert.equal(first.value.runsOn, 'ubuntu-latest');
  assert.equal(first.value.runtime, hostedActionsRuntime);
  const beforeInvalid = { lookups, transactions: s.counts.length };
  for (const runsOn of ['', 'bad\nlabel', [], [''], 'x'.repeat(257), { labels: ['linux'] }]) {
    await assert.rejects(
      configure.configure._handler(ctx, {
        projectId: s.projectId,
        request: JSON.stringify({ ...request, operationId: randomUUID(), runsOn }),
      }),
      code('BAD_ARGUMENT'),
    );
  }

  assert.equal(lookups, beforeInvalid.lookups);
  assert.equal(s.counts.length, beforeInvalid.transactions);
  assert.equal(first.value.credential, undefined);
  assert.equal(first.value.installationId, undefined);
  assert.deepEqual(JSON.parse(await configure.configure._handler(ctx, input)), first);
  await assert.rejects(
    configure.configure._handler(
      {
        auth: { getUserIdentity: async () => ({ subject: 'other' }) },
        runMutation: (_ref, args) =>
          s.transaction('direct-configure-denied', definitions.configure, args, 'other'),
      },
      input,
    ),
    code('PROJECT_UNAVAILABLE'),
  );
});
test('a first JWT cannot adopt an unacknowledged execution; cancellation after a lost reply coalesces its wake', async t => {
  const s = await fixture(t);
  await s.reserve();
  await assert.rejects(s.call(sessions, 'session', s.input()), code('EVIDENCE_CHANGED'));
  await s.cancel(s.run.id);
  await s.call(direct, 'observe', { ...s.id, fence: 1, outcome: 'accepted', executionId: '123' });
  await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'in_progress', null)) });
  assert.equal(s.scheduled.filter(item => item.name === 'projectHostedActionsWebhook:cancel').length, 1);
});
test('workflow_run uses the existing HMAC webhook boundary', async t => {
  const s = await fixture(t);
  await s.reserve();
  variables(t, { GITHUB_WEBHOOK_SECRET: 'synthetic-webhook-key' });
  const { createHmac } = await import('node:crypto');
  const { default: http } = await import(moduleUrl('../convex/http.ts'));
  const route = http.getRoutes().find(([path]) => path === '/github/webhook')[2];
  const payload = JSON.stringify(webhook(s));
  const signature = `sha256=${createHmac('sha256', 'synthetic-webhook-key').update(payload).digest('hex')}`;
  const send = signature =>
    route._handler(
      { runMutation: (_ref, input) => s.call(webhooks, 'receive', input) },
      new Request(`${audience}/github/webhook`, {
        method: 'POST',
        body: payload,
        headers: {
          'x-github-event': 'workflow_run',
          'x-github-delivery': 'synthetic-delivery',
          'x-hub-signature-256': signature,
        },
      }),
    );
  assert.equal((await send('sha256=wrong')).status, 401);
  assert.equal((await s.status(s.run.id)).status, 'dispatching');
  assert.equal((await send(signature)).status, 204);
  assert.equal((await s.status(s.run.id)).status, 'cancelled');
});

test('HTTP plan pairs use verified canonical R2 bytes and reuse both digests on retry', async t => {
  const s = await fixture(t);
  await s.bind();
  const r2 = fakeSourceR2(t),
    r2Fetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new URL(url).hostname === 'token.actions.githubusercontent.com'
      ? Promise.resolve(jwks())
      : r2Fetch(url, init);
  const pins = {
    head: s.run.request.expectedHead,
    definition: s.run.check.definition,
    selection: {
      scope: 'full',
      reason: 'synthetic dogfood selection',
      tests: Array.from({ length: 3000 }, (_, i) => `tests/synthetic-${i}.test.mjs`),
    },
    standard: true,
    interaction: false,
    command: ['node', 'scripts/forge-check.mjs'],
  };
  const recipePins = { ...pins, groups: [pins.selection.tests] },
    recipe = { ...recipePins, pin: checkPin(recipePins) },
    mutations = [];
  const ctx = {
    storage: {
      store() {
        assert.fail('R2 HTTP plan wrote Convex bytes');
      },
    },
    runMutation: (ref, input) => {
      const [name, method] = getFunctionName(ref).split(':');
      mutations.push(name);
      return s.call(
        { projectHostedActionsSession: sessions, projectHostedActionsPlan: plans }[name],
        method,
        input,
      );
    },
  };
  const send = () =>
    handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({
          ...s.id,
          command: { kind: 'plan', plan: { recipe, lockfile: 'e'.repeat(64) } },
        }),
      }),
    );
  r2.hooks.mismatch = true;
  assert.equal((await send()).status, 403);
  assert.equal((await s.status(s.run.id)).plan, null, 'unverified bytes never publish a plan');
  assert.deepEqual(mutations, ['projectHostedActionsSession']);
  r2.hooks.mismatch = false;
  mutations.length = 0;
  const before = process.memoryUsage().rss,
    started = performance.now();
  assert.equal((await send()).status, 200);
  assert.deepEqual(mutations, ['projectHostedActionsSession', 'projectHostedActionsPlan']);
  for (const value of [recipe.selection, recipe]) {
    const pin = savePin(value),
      key = `/synthetic/v1/p/${s.projectId}/o/${pin.sha256}`;
    assert.equal(r2.objects.get(key).toString(), canonicalPayload(value));
    const row = [...s.tables.projectObjects.values()].find(row => row.digest === pin.sha256);
    assert.equal(row.location, 'r2');
    assert.equal(row.r2Committed, true);
    assert.equal(row.storageId, undefined);
  }
  const puts = r2.requests.filter(method => method === 'PUT').length;
  mutations.length = 0;
  assert.equal((await send()).status, 200);
  assert.deepEqual(mutations, ['projectHostedActionsSession', 'projectHostedActionsPlan']);
  assert.equal(r2.requests.filter(method => method === 'PUT').length, puts);
  assert.equal(r2.objects.size, 2);
  t.diagnostic(
    JSON.stringify({
      tests: 3000,
      convexCallsPerPlan: 2,
      convexStorageBytes: 0,
      repeatedPutBytes: 0,
      rssGrowth: process.memoryUsage().rss - before,
      wallMs: Math.round(performance.now() - started),
    }),
  );
});

test('legacy HTTP session shape remains a run with additive capabilities; unknown metadata is stripped', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const modules = { projectHostedActionsSession: sessions, projectHostedActionsResults: results };
  const received = [];
  const ctx = {
    runMutation: (ref, input) => {
      const [name, method] = getFunctionName(ref).split(':');
      received.push(input);
      return s.call(modules[name], method, input);
    },
  };
  const send = (command, identity = {}) =>
    handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({ ...s.id, fence: 1, ...identity, command }),
      }),
    );
  const response = await send({ kind: 'session' });
  assert.equal(response.status, 200);
  const { capabilities, ...oldRun } = await response.json();
  assert.deepEqual(capabilities, hostedActionsCapabilities);
  assert.equal(hostedCheckRunSchema.parse(oldRun).id, s.run.id);
  // Old runners submit no extension fields. Keep the second shard pending to avoid storage finalization.
  const result = { index: 0, exitCode: 0, contractReports: {} };
  assert.equal((await send({ kind: 'result', result })).status, 200);
  assert.equal(
    (await send({ kind: 'result', futureMetadata: true, result: { ...result, futureMetadata: true } }))
      .status,
    200,
  );
  assert.deepEqual(JSON.parse(received.at(-1).result), result);
  assert.equal((await send({ kind: 'session', futureMetadata: true })).status, 200);
  const before = received.length;
  for (const [command, identity] of [
    [{ kind: 'session' }, { unexpectedIdentity: 'bad' }],
    [{ kind: 'session' }, { fence: 'bad' }],
    [{ kind: 'session', timings: 'bad' }, {}],
    [{ kind: 'sourcePack' }, {}],
    [{ kind: 'result', result: { ...result, testFiles: {} } }, {}],
    [
      {
        kind: 'output',
        index: 0,
        log: { object: { sha256: 'f'.repeat(64), size: 5, unknownPin: true }, failureSummary: '' },
      },
      {},
    ],
  ]) {
    const refused = await send(command, identity);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).reason, 'validation');
  }
  assert.equal(received.length, before);
  const storageCtx = {
    runMutation: async () => {
      throw Object.assign(new Error('private details'), { code: 'R2_VERIFY_FAILED' });
    },
  };
  const refused = await handle._handler(
    storageCtx,
    new Request(`${audience}/checks/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oidc()}` },
      body: JSON.stringify({ ...s.id, command: { kind: 'session' } }),
    }),
  );
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).reason, 'storage');
});

test('source pack reservations bound project storage to two objects and delete older objects before replacement', async t => {
  variables(t, { FORGE_BLOBS: 'r2' });
  const s = await fixture(t);
  await s.bind();
  const stateRef = s.run.candidate.base.head;
  // This fixture's base pin is synthetic; register it in this project explicitly.
  if (![...s.tables.projectObjects.values()].some(row => row.digest === stateRef))
    s.insert('projectObjects', {
      projectId: s.projectId,
      digest: stateRef,
      size: 1,
      location: 'r2',
      r2Key: 'synthetic/state',
      r2Committed: true,
      removed: false,
      nonce: randomUUID(),
    });
  const object = hash => ({ stateRef, sha256: hash.repeat(64), size: 10, fileCount: 1 });
  const input = hash => ({ ...s.input(), object: JSON.stringify(object(hash)) });
  const call = (name, args) => s.call(packs, name, args);
  assert((await call('prepare', input('1'))).target.url.includes('X-Amz-Signature='));
  assert.equal(
    await call('prepare', input('2')),
    null,
    'a concurrent different upload cannot allocate a third key',
  );
  await assert.rejects(call('commit', input('2')));
  await call('commit', input('1'));
  await call('commit', input('1')); // lost reply is idempotent
  assert.equal(s.tables.projectSourcePacks.size, 1);
  assert((await call('prepare', input('2'))).target);
  await call('commit', input('2'));
  const row = [...s.tables.projectSourcePacks.values()][0];
  assert.equal(row.latest.sha256, '2'.repeat(64));
  assert.equal(row.other.sha256, '1'.repeat(64));
  assert.equal(row.other.ready, true);
  assert.equal(await call('prepare', input('3')), null, 'retired signed PUT must expire before deletion');
  const input3 = input('3');
  let now = Math.max(row.latest.expiresAt, row.other.expiresAt) + 1;
  const mutate = args =>
    s.call(
      { sourcePackPrepare: { _handler: (ctx, value) => packs.prepareSourcePack(ctx, value, now) } },
      'sourcePackPrepare',
      args,
    );
  const cleanup = await mutate(input3);
  assert.equal(cleanup.cleanup, row.other.objectKey);
  const deletions = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'DELETE');
    assert(decodeURIComponent(String(url)).includes(row.other.objectKey));
    deletions.push(url);
    return new Response(null, { status: 204 });
  });
  const actionCtx = {
    runMutation: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectSourcePacks:prepare');
      return mutate(args);
    },
  };
  assert((await packs.sourcePackCommand(actionCtx, s.input(), 'prepare', object('3'))).url);
  assert.equal(deletions.length, 1);
  await call('commit', input3);
  assert.equal([...s.tables.projectSourcePacks.values()][0].other.sha256, '2'.repeat(64));
  const session = await s.call(sessions, 'session', { ...s.input(), timings: true });
  assert.deepEqual(session.capabilities, hostedActionsCapabilities);
  assert(session.capabilities.includes('sourcePack'));
  assert.equal(session.sourcePack.sha256, '3'.repeat(64));
  assert.equal(session.sourcePack.stateRef, stateRef);
  assert.equal('expiresAt' in session.sourcePack, false);
  await assert.rejects(
    call('prepare', {
      ...input('4'),
      projectId: s.insert('hostedProjects', {
        owner: 'other',
        key: randomUUID(),
        name: 'Other project',
        currentBackup: null,
        revision: 0,
        visibility: 'private',
        sourceAuthority: { mode: 'server', epoch: 1 },
      }),
    }),
  );
  await assert.rejects(call('prepare', { ...input('4'), fence: 99 }));
  await assert.rejects(
    call('prepare', {
      ...input('4'),
      object: JSON.stringify({ ...object('4'), objectKey: 'v1/p/other/pack' }),
    }),
  );
  await assert.rejects(
    call('prepare', { ...input('4'), object: JSON.stringify({ ...object('4'), stateRef: 'f'.repeat(64) }) }),
  );
  const packCalls = s.counts.filter(c => c.touched.includes('projectSourcePacks'));
  assert(packCalls.length > 0);
  assert(packCalls.every(c => c.documents <= 20 && c.writes <= 2));
  t.diagnostic(
    JSON.stringify({
      packMaxDocuments: Math.max(...packCalls.map(c => c.documents)),
      packMaxWrites: Math.max(...packCalls.map(c => c.writes)),
      packDocuments: s.tables.projectSourcePacks.size,
    }),
  );
});

test('source pack commit verifies R2 size/checksum and reauthorizes after HEAD', async t => {
  const s = await fixture(t);
  await s.bind();
  const object = { stateRef: s.run.candidate.base.head, sha256: '1'.repeat(64), size: 10, fileCount: 1 };
  for (const observation of ['size', 'checksum', 'missing', 'valid']) {
    const commands = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      assert.equal(init.method, 'HEAD');
      return new Response(null, {
        status: observation === 'missing' ? 404 : 200,
        headers: {
          'content-length': observation === 'size' ? '11' : '10',
          'x-amz-checksum-sha256':
            observation === 'checksum' ? 'bad' : Buffer.from(object.sha256, 'hex').toString('base64'),
        },
      });
    });
    const actionCtx = {
      runMutation: async (ref, _input) => {
        commands.push(getFunctionName(ref));
        return null;
      },
    };
    if (observation === 'valid') await packs.sourcePackCommand(actionCtx, s.input(), 'commit', object);
    else await assert.rejects(packs.sourcePackCommand(actionCtx, s.input(), 'commit', object));
    assert.deepEqual(
      commands,
      observation === 'valid'
        ? ['projectHostedActionsSession:session', 'projectSourcePacks:commit']
        : ['projectHostedActionsSession:session'],
    );
  }
});

test('expired pending uploads are fenced before DELETE so late commit cannot publish a deleted pack', async t => {
  variables(t, { FORGE_BLOBS: 'r2' });
  const s = await fixture(t);
  await s.bind();
  const stateRef = s.run.candidate.base.head;
  if (![...s.tables.projectObjects.values()].some(row => row.digest === stateRef))
    s.insert('projectObjects', {
      projectId: s.projectId,
      digest: stateRef,
      size: 1,
      location: 'r2',
      r2Key: 'synthetic/state',
      r2Committed: true,
      removed: false,
      nonce: randomUUID(),
    });
  const input = hash => ({
    ...s.input(),
    object: JSON.stringify({ stateRef, sha256: hash.repeat(64), size: 10, fileCount: 1 }),
  });
  await s.call(packs, 'prepare', input('1'));
  const reserved = [...s.tables.projectSourcePacks.values()][0].other;
  const expired = reserved.expiresAt + 1;
  const cleanup = await s.call(
    { oldPack: { _handler: (ctx, args) => packs.prepareSourcePack(ctx, args, expired) } },
    'oldPack',
    input('2'),
  );
  assert.equal(cleanup.cleanup, reserved.objectKey);
  await assert.rejects(s.call(packs, 'commit', input('1')), code('WORK_STALE'));
  assert.equal([...s.tables.projectSourcePacks.values()][0].latest, undefined);
  assert.equal([...s.tables.projectSourcePacks.values()][0].other.deleting, true);
});

for (const responseStatus of [202, 409])
  test(`cancelled check schedules and sends one bound App cancellation (${responseStatus}), then ignores completed webhook`, async t => {
    const s = await fixture(t);
    await s.bind();
    await s.prepare();
    bindRepository(t, s.id.projectId, repository);
    variables(t, {
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
    let cancels = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (url.endsWith('/installation')) return Response.json({ id: 9 });
      if (url.endsWith('/access_tokens')) {
        assert.deepEqual(JSON.parse(init.body).permissions, actionsPermissions);
        return Response.json({ token: 'synthetic-token' });
      }
      assert.equal(url, `https://api.github.com/repos/${repository}/actions/runs/123/cancel`);
      assert.equal(init.method, 'POST');
      cancels++;
      return new Response(null, { status: responseStatus });
    });
    assert.equal((await s.cancel(s.run.id)).status, 'cancelled');
    await s.cancel(s.run.id);
    assert.equal(s.scheduled.filter(task => task.name === 'projectHostedActionsWebhook:cancel').length, 1);
    const ctx = { runMutation: (ref, args) => s.call(webhooks, getFunctionName(ref).split(':')[1], args) };
    await Promise.all([webhooks.cancel._handler(ctx, s.id), webhooks.cancel._handler(ctx, s.id)]);
    await webhooks.cancel._handler(ctx, s.id);
    assert.equal(cancels, 1);
    const before = await s.status(s.run.id),
      tasks = s.scheduled.length;
    for (let i = 0; i < 2; i++) await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s)) });
    assert.deepEqual(await s.status(s.run.id), before);
    assert.equal(s.scheduled.length, tasks);
    assert(s.counts.filter(c => c.name === 'direct-receive').every(c => c.writes === 0));
    for (const [module, method, args] of [
      [sessions, 'session', s.input()],
      [source, 'resolve', { ...s.input(), digests: ['a'.repeat(64)] }],
      [results, 'result', { ...s.input(), result: JSON.stringify({ index: 0, exitCode: 0 }) }],
    ])
      await assert.rejects(s.call(module, method, args), code('CHECK_CANCELLED'));
    assert.equal(s.tables.projectHostedActionsResults.size, 0);
  });

test('cancellation enforces current repository binding before token minting or cancel IO', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.cancel(s.run.id);
  variables(t, { FORGE_GITHUB_REPO_BINDINGS: `${s.id.projectId}=other/repository` });
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  let installations = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert(url.endsWith('/installation'), 'no token minting or cancel IO without binding');
    installations++;
    return Response.json({ id: 9 });
  });
  const ctx = {
    runMutation: (ref, args) => s.call(webhooks, getFunctionName(ref).split(':')[1], args),
    runQuery: async ref => {
      assert.equal(getFunctionName(ref), 'githubBindingStore:page');
      return JSON.stringify({ page: [], isDone: true, continueCursor: '' });
    },
  };
  await assert.rejects(webhooks.cancel._handler(ctx, s.id), code('GITHUB_REPOSITORY_UNBOUND'));
  assert.equal(installations, 1);
});

test('cancelled HTTP calls return a distinct safe 403 that old runners already refuse', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  await s.cancel(s.run.id);
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const ctx = { runMutation: (_ref, args) => s.call(sessions, 'session', args) };
  const response = await handle._handler(
    ctx,
    new Request(`${audience}/checks/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oidc()}` },
      body: JSON.stringify({ ...s.id, command: { kind: 'session' } }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, 'cancelled');
});

test('single-call preflight rechecks cancellation, authority and exact run/fence with no writes or nested calls', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  const run = await s.status(s.run.id);
  const input = {
    ...s.id,
    fence: run.fence,
    signature: actionsPreflightSignature(run, 'synthetic-check-key'),
  };
  assert.deepEqual(await s.call(preflight, 'check', input), { status: 'active' });
  const withIdentity = identity => ({
    _handler: ctx =>
      preflight.check._handler(
        {
          db: ctx.db,
          auth: { getUserIdentity: async () => identity },
        },
        input,
      ),
  });
  // Restored shards have only their run-scoped proof. The public wrapper adds
  // no device lookup for them and can run with db/auth only, without nested IO.
  assert.deepEqual(await s.transaction('proofOnlyPreflight', withIdentity(null), {}), { status: 'active' });
  await assert.rejects(
    s.transaction(
      'revokedDevicePreflight',
      withIdentity({ subject: run.actor, forgeCredential: 'revoked-device' }),
      {},
    ),
    code('AUTH_REVOKED'),
  );
  for (const change of [{ signature: '0'.repeat(64) }, { fence: 99 }, { runId: randomUUID() }])
    await assert.rejects(s.call(preflight, 'check', { ...input, ...change }));
  const other = await fixture(t);
  await other.bind();
  await other.prepare();
  await assert.rejects(
    other.call(preflight, 'check', { ...other.id, fence: 1, signature: input.signature }),
    code('EVIDENCE_CHANGED'),
  );
  await s.cancel(s.run.id);
  assert.deepEqual(await s.call(preflight, 'check', input), { status: 'cancelled' });
  const meters = s.counts.filter(c =>
    ['direct-check', 'proofOnlyPreflight', 'revokedDevicePreflight'].includes(c.name),
  );
  assert(meters.every(c => c.writes === 0 && c.documents <= 5));
  // The query receives db/auth only: it cannot call another function or scheduler.
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.call(preflight, 'check', input), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { owner: 'other', sourceAuthority: { mode: 'server', epoch: 1 } });
  await assert.rejects(s.call(preflight, 'check', input), code('PROJECT_UNAVAILABLE'));
});

test('existing OIDC session issues preflight ticket in a header without changing oldest JSON or adding calls', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const response = await handle._handler(
    {
      runMutation: (ref, input) => {
        calls++;
        assert.equal(getFunctionName(ref), 'projectHostedActionsSession:session');
        return s.call(sessions, 'session', input);
      },
    },
    new Request(`${audience}/checks/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oidc()}` },
      body: JSON.stringify({ ...s.id, command: { kind: 'session' } }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const { capabilities, ...run } = await response.json();
  assert(capabilities.includes('session.preflight'));
  assert.equal(hostedCheckRunSchema.parse(run).id, s.run.id);
  const ticket = JSON.parse(response.headers.get('X-Forge-Actions-Preflight'));
  assert.equal(ticket.endpoint, 'https://forge.convex.cloud');
  assert.equal(ticket.signature, actionsPreflightSignature(run, 'synthetic-check-key'));
  assert.deepEqual(
    await s.call(preflight, 'check', { ...s.id, fence: run.fence, signature: ticket.signature }),
    { status: 'active' },
  );
});
