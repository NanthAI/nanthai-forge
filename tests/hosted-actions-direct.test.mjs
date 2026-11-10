// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify, sign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { OPTIONAL_PACK_JOB, requiredJobsConclusion } from '../dist/hosted-check-verdict.js';
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
const verdicts = await import(moduleUrl('../convex/projectHostedActionsVerdict.ts'));
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
  repository_visibility: 'private',
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
/** GitHub's repository read: a private project dispatches only after it proves private. */
const repositoryRead = (url, visibility = 'private') =>
  url === `https://api.github.com/repos/${repository}`
    ? Response.json({ full_name: repository, private: visibility !== 'public', visibility })
    : null;
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
async function fixture(t, shards = 2, runsOn = 'ubuntu-latest', opaque = null, runnerExtra = {}) {
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
    ...runnerExtra,
  };
  bindRepository(t, s.projectId, repository);
  const configuration = await s.configure({ kind: 'runner', configuration: runner }, s.configuration.digest);
  // An opaque (bring-your-own) command replaces the standard check definition.
  const definition = opaque
    ? await s.configure(
        { kind: 'definition', checkId: s.definition.value.id, command: opaque },
        s.definition.digest,
      )
    : s.definition;
  const run = await s.enqueue(
    s.selection({ expectedConfiguration: configuration.digest, expectedDefinition: definition.digest }),
  );
  const id = { projectId: s.projectId, runId: run.id };
  // These internal mutations return JSON text (Issue 0c457ae4); tests read the value.
  const text = new Set([direct.reserve, plans.prepare, sessions.session, results.result, results.output]);
  const call = async (module, method, args) => {
    const value = await s.transaction(`direct-${method}`, module[method], args);
    return text.has(module[method]) || (module === source && args.batch) ? JSON.parse(value) : value;
  };
  // Exactly what the Convex function returns, for actions under test that parse it themselves.
  const raw = (module, method, args) => s.transaction(`direct-${method}`, module[method], args);
  const reserve = () => call(direct, 'reserve', id);
  const bind = async () => {
    const reserved = await reserve();
    await call(direct, 'observe', { ...id, fence: reserved.fence, outcome: 'accepted', executionId: '123' });
    return reserved;
  };
  const input = (overrides = {}) => ({ ...id, claims: JSON.stringify(claims()), ...overrides });
  const prepare = async (selection = null, actions = undefined, extra = {}) => {
    const r = await s.status(run.id),
      groups = opaque ? [] : Array.from({ length: shards - 1 }, (_, i) => [`tests/synthetic-${i}.test.mjs`]);
    const pins = {
      head: r.request.expectedHead,
      definition: r.check.definition,
      selection: selection ?? { scope: 'full', reason: 'synthetic', tests: groups.flat() },
      groups,
      standard: !opaque,
      interaction: false,
      command: opaque ? [opaque.executable, ...opaque.args] : ['node', 'scripts/forge-check.mjs'],
      ...(actions ? { actions } : {}),
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
      ...extra,
    });
  };
  // Every shard passed: the pass waits for GitHub's signed completed event (Issue 432164bf).
  const conclude = async (conclusion = 'success') => {
    await call(webhooks, 'receive', { payload: JSON.stringify(webhook({ run }, 'completed', conclusion)) });
    return s.status(run.id);
  };
  return {
    ...s,
    scheduled,
    cancelled,
    storage,
    run,
    id,
    input,
    call,
    raw,
    reserve,
    bind,
    prepare,
    runner,
    configuration,
    conclude,
  };
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
    const read = repositoryRead(url);
    if (read) return read;
    assert(url.endsWith('/forge-check.yml/dispatches'));
    const body = JSON.parse(init.body);
    assert.equal(body.ref, 'main');
    assert.equal(body.inputs.runId, s.run.id);
    assert.equal(body.inputs.deployment, audience);
    assert.equal(body.inputs.runs_on, JSON.stringify('ubuntu-latest'));
    dispatches++;
    throw new Error('Synthetic lost reply after GitHub accepted the dispatch.');
  });
  const ctx = { runMutation: (ref, input) => s.raw(direct, getFunctionName(ref).split(':')[1], input) };
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
test('the webhook binds an execution only after the dispatch was observed without a run id', async t => {
  const s = await fixture(t);
  const reserved = await s.call(direct, 'reserve', s.id);
  // Before the dispatch is observed a same-titled run from another actor binds nothing.
  await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'requested', null, { id: 999 })) });
  assert.equal((await s.status(s.run.id)).executionId, null);
  // A dispatch that returned an id keeps it; a different webhook run is refused.
  await s.call(direct, 'observe', {
    ...s.id,
    fence: reserved.fence,
    outcome: 'accepted',
    executionId: '123',
  });
  assert.equal((await s.status(s.run.id)).actions.dispatchedWithoutId, undefined);
  await assert.rejects(
    s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'requested', null, { id: 999 })) }),
    code('EVIDENCE_CHANGED'),
  );
  assert.equal((await s.status(s.run.id)).executionId, '123');
  // A dispatch accepted without an id (no run details) lets the webhook bind.
  const bare = await fixture(t);
  const second = await bare.call(direct, 'reserve', bare.id);
  await bare.call(direct, 'observe', { ...bare.id, fence: second.fence, outcome: 'accepted' });
  assert.equal((await bare.status(bare.run.id)).actions.dispatchedWithoutId, true);
  await bare.call(webhooks, 'receive', {
    payload: JSON.stringify(webhook(bare, 'requested', null, { id: 321 })),
  });
  assert.equal((await bare.status(bare.run.id)).executionId, '321');
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
    const read = repositoryRead(url);
    if (read) return read;
    assert(url.endsWith('/forge-check.yml/dispatches'));
    assert.deepEqual(JSON.parse(JSON.parse(init.body).inputs.runs_on), expected);
    return Response.json({ workflow_run_id: 123 });
  });
  for (const runsOn of ['blacksmith-4vcpu-ubuntu-2404', ['self-hosted', 'linux', 'x64']]) {
    expected = runsOn;
    const s = await fixture(t, 2, runsOn);
    bindRepository(t, s.id.projectId, 'synthetic/project');
    const ctx = { runMutation: (ref, input) => s.raw(direct, getFunctionName(ref).split(':')[1], input) };
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
const docsOnly = { scope: 'docs', reason: 'Every changed path matches the check’s docs paths', tests: [] };
const ciCommand = { name: 'verify', executable: 'bash', args: ['ci/check.sh'], environmentLabel: 'clean' };
test('a docs-scoped plan for an opaque command needs the check to declare docs paths, then records skipped tests', async t => {
  const undeclared = await fixture(t, 2, 'ubuntu-latest', ciCommand);
  await undeclared.bind();
  await assert.rejects(undeclared.prepare(docsOnly), code('EVIDENCE_CHANGED'));
  assert.equal((await undeclared.status(undeclared.run.id)).plan, null);
  // The same command still plans a full run.
  await undeclared.prepare();
  const declared = await fixture(t, 2, 'ubuntu-latest', { ...ciCommand, docsPaths: ['**/*.md', 'docs/**'] });
  await declared.bind();
  await declared.prepare(docsOnly);
  const plan = (await declared.status(declared.run.id)).plan;
  assert.equal(plan.shardCount, 1);
  assert.deepEqual(plan.skipped, { part: 'tests', status: 'not-affected', reason: docsOnly.reason });
});
test('a check that declares toolchains or cache plans only with that declaration pinned in its recipe', async t => {
  const actions = {
    toolchains: [{ tool: 'go', versionFile: 'go.mod' }],
    cache: { presets: ['go'] },
  };
  const declared = await fixture(t, 2, 'ubuntu-latest', {
    ...ciCommand,
    actionsToolchains: actions.toolchains,
    actionsCache: actions.cache,
  });
  await declared.bind();
  // An older runner that cannot set them up never runs the check without them.
  await assert.rejects(declared.prepare(), code('EVIDENCE_CHANGED'));
  await assert.rejects(
    declared.prepare(null, { ...actions, cache: { presets: ['cargo'] } }),
    code('EVIDENCE_CHANGED'),
  );
  assert.equal((await declared.status(declared.run.id)).plan, null);
  await declared.prepare(null, actions);
  assert.equal((await declared.status(declared.run.id)).plan.shardCount, 1);
  // Undeclared checks refuse a recipe that claims a declaration.
  const undeclared = await fixture(t, 2, 'ubuntu-latest', ciCommand);
  await undeclared.bind();
  await assert.rejects(undeclared.prepare(null, actions), code('EVIDENCE_CHANGED'));
});

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
  const held = await send({ index: 1, exitCode: 0 });
  assert.equal(held.status, 'running', "every shard passed: the pass waits for the provider's conclusion");
  assert.equal(held.actions.verdictPending, true);
  assert.equal(s.tables.projectHostedTestTimings.size, 0);
  const terminal = await s.conclude();
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
  // The watchdog and the one confirm read are both cancelled.
  assert.equal(s.cancelled.length, 2);
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
    await send(1, 30);
    const terminal = await s.conclude();
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
test('run evidence keeps the weakest isolation any shard reported; none reported stays absent', async t => {
  for (const [reported, expected] of [
    [['user', 'user'], 'user'],
    [['user', 'shared'], 'shared'],
    [['shared', 'user'], 'shared'],
    [[undefined, undefined], undefined],
  ]) {
    const s = await fixture(t);
    await s.bind();
    await s.prepare();
    for (const [index, isolation] of reported.entries())
      await s.call(results, 'result', {
        ...s.input(),
        result: JSON.stringify({ index, exitCode: 0, ...(isolation ? { isolation } : {}) }),
      });
    const terminal = await s.conclude();
    assert.equal(terminal.status, 'passed');
    assert.equal(terminal.actions.isolation, expected, reported.join());
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
  await s.conclude();
  const stored = JSON.parse([...s.tables.projectHostedTestTimings.values()][0].history);
  assert.equal(stored.files[file].durationMs, 240);
  assert.deepEqual(stored.runs, [previousId, s.run.id]);
});
test('webhook backstops cancellation, failure, timeout and missing evidence; does not fabricate a pass', async t => {
  for (const [conclusion, status] of [
    ['cancelled', 'cancelled'],
    ['failure', 'runner-unavailable'],
    ['timed_out', 'runner-unavailable'],
    ['success', 'runner-unavailable'],
  ]) {
    const s = await fixture(t);
    await s.bind();
    await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'completed', conclusion)) });
    assert.equal((await s.status(s.run.id)).status, status);
    await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'completed', conclusion)) });
    assert.equal(s.cancelled.length, 1);
  }
});
const passAll = async s => {
  await s.bind();
  await s.prepare();
  for (const index of [0, 1])
    await s.call(results, 'result', { ...s.input(), result: JSON.stringify({ index, exitCode: 0 }) });
  return s.status(s.run.id);
};
test("passing shard results alone never pass: the provider's conclusion decides (Issue 432164bf)", async t => {
  for (const [conclusion, status] of [
    ['success', 'passed'],
    ['failure', 'runner-unavailable'],
    ['timed_out', 'runner-unavailable'],
    ['cancelled', 'cancelled'],
  ]) {
    const s = await fixture(t);
    const held = await passAll(s);
    assert.equal(held.status, 'running');
    assert.equal(held.actions.verdictPending, true);
    const confirm = s.scheduled.find(item => item.name.endsWith('projectHostedActionsVerdict:confirm'));
    assert.equal(confirm.delay, 10_000, 'one fallback jobs read, scheduled once');
    assert.equal(confirm.input.jobs, true);
    assert.equal(held.actions.confirm, confirm.id);
    const settled = await s.conclude(conclusion);
    assert.equal(settled.status, status, conclusion);
    assert.ok(s.cancelled.includes(confirm.id), 'the fallback read is cancelled once the event arrives');
    if (conclusion === 'failure') assert.match(settled.failureReason, /only with the provider's success/);
    // A replayed event changes nothing.
    await s.conclude('success');
    assert.equal((await s.status(s.run.id)).status, status);
  }
});
test('a lost completed event: two jobs reads, at most two bounded reads of the run, then only the watchdog', async t => {
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const ctx = s => ({
    runMutation: (ref, input) => s.call(verdicts, getFunctionName(ref).split(':')[1], input),
  });
  const running = {
    total_count: 1,
    jobs: [{ name: 'hosted-plan', status: 'in_progress', conclusion: null }],
  };
  for (const answers of [
    ['completed:success'],
    ['in_progress', 'completed:failure'],
    ['in_progress', 'in_progress'],
  ]) {
    const s = await fixture(t);
    bindRepository(t, s.id.projectId, repository);
    const reads = [];
    t.mock.method(globalThis, 'fetch', async url => {
      if (url.endsWith('/installation')) return Response.json({ id: 9 });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-token' });
      reads.push(url);
      // A job still running in both jobs reads (a long post-step), then the run reads.
      if (url.endsWith('/jobs?per_page=100')) return Response.json(running);
      const [state, conclusion = null] = answers[reads.length - 3].split(':');
      return Response.json({ status: state, conclusion });
    });
    await passAll(s);
    const delays = [10_000, 30_000, 5 * 60_000, 30 * 60_000];
    for (let attempt = 0; attempt < answers.length + 2; attempt++) {
      const pending = s.scheduled.filter(item => item.name.endsWith('projectHostedActionsVerdict:confirm'));
      assert.equal(pending.length, attempt + 1);
      assert.equal(pending.at(-1).delay, delays[attempt]);
      assert.equal(pending.at(-1).input.jobs, attempt < 2 ? true : undefined);
      await verdicts.confirm._handler(ctx(s), pending.at(-1).input);
    }
    assert.equal(reads.length, answers.length + 2);
    assert.ok(reads.slice(2).every(url => url.endsWith(`/repos/${repository}/actions/runs/123`)));
    const run = await s.status(s.run.id);
    const expected = {
      'completed:success': 'passed',
      'completed:failure': 'runner-unavailable',
      in_progress: 'running',
    };
    assert.equal(run.status, expected[answers.at(-1)]);
    assert.equal(
      s.scheduled.filter(item => item.name.endsWith('projectHostedActionsVerdict:confirm')).length,
      answers.length + 2,
      'no further read: the 12 h watchdog is the backstop',
    );
  }
});
test('Issue 03a749a5 replay: a pass with no pack job whose completed event is lost settles within 10 s of its result', async t => {
  // The dart resolution run of 2026-11-09: one hosted-plan job ran the whole check, the plan
  // started no pack job, GitHub concluded success 3 s after the result, and the signed event never
  // settled it. Forge waited for its 5 min run read: the landing committed 297 s after GitHub.
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const job = (name, conclusion) => ({ name, status: 'completed', conclusion });
  const incidentJobs = [
    job('hosted-plan', 'success'),
    job('forge-shard-${{ matrix.shard }}', 'skipped'),
    job('forge-static', 'skipped'),
    job(OPTIONAL_PACK_JOB, 'skipped'),
    job('forge-hosted-${{ matrix.shard }}', 'skipped'),
  ];
  for (const event of ['lost', 'first']) {
    const s = await fixture(t);
    bindRepository(t, s.id.projectId, repository);
    const urls = [],
      mutations = [];
    t.mock.method(globalThis, 'fetch', async url => {
      if (url.endsWith('/installation')) return Response.json({ id: 9 });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-token' });
      urls.push(url);
      return Response.json({ total_count: incidentJobs.length, jobs: incidentJobs });
    });
    const held = await passAll(s);
    assert.equal(held.actions.packRefresh, undefined, 'the plan started no pack job');
    const reads = () => s.scheduled.filter(item => item.name.endsWith('projectHostedActionsVerdict:confirm'));
    assert.equal(reads().length, 1, 'one timer, as before: no new timer in the common path');
    const [read] = reads();
    assert.ok(read.delay <= 10_000, `the result-to-settle gap is ${read.delay} ms, at most 10 s`);
    if (event === 'first') {
      // The common path: the event arrives first and cancels the read, so it adds no call.
      assert.equal((await s.conclude('success')).status, 'passed');
      assert.ok(s.cancelled.includes(read.id));
      assert.equal(urls.length, 0);
      continue;
    }
    await verdicts.confirm._handler(
      {
        runMutation: (ref, input) => {
          mutations.push(getFunctionName(ref));
          return s.call(verdicts, getFunctionName(ref).split(':')[1], input);
        },
      },
      read.input,
    );
    const settled = await s.status(s.run.id);
    assert.equal(settled.status, 'passed', 'the read settles the pass the lost event would have');
    assert.equal(settled.actions.confirm, null, 'and leaves no further read');
    assert.deepEqual(urls, [`https://api.github.com/repos/${repository}/actions/runs/123/jobs?per_page=100`]);
    assert.deepEqual(mutations, ['projectHostedActionsVerdict:confirmed'], 'one action and one mutation');
    assert.equal(reads().length, 1);
    // The event arriving late changes nothing.
    assert.equal((await s.conclude('failure')).status, 'passed');
  }
});
test('friction 0064c3b2: a pass settles on the required jobs, never on the optional pack job', async t => {
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const job = (name, status, conclusion = null) => ({ name, status, conclusion });
  const plan = (status, conclusion) => job('hosted-plan', status, conclusion);
  const pack = job(OPTIONAL_PACK_JOB, 'in_progress');
  const skipped = [job('forge-static', 'completed', 'skipped'), job('forge-shard', 'completed', 'skipped')];
  for (const [answers, expected, reads, packRefresh] of [
    // The job that posted the last result completed; the pack job is still running: pass now.
    [[[plan('completed', 'success'), ...skipped, pack]], 'passed', 1],
    [
      [
        [plan('in_progress'), pack],
        [plan('completed', 'success'), pack],
      ],
      'passed',
      2,
    ],
    [[[plan('completed', 'failure'), pack]], 'runner-unavailable', 1],
    // Still running after both jobs reads: the run's own reads and its event decide, as before.
    [
      [
        [plan('in_progress'), pack],
        [plan('in_progress'), pack],
      ],
      'running',
      2,
    ],
  ].flatMap(row => [
    [...row, true],
    // No pack job started: its page lists the job skipped, and the read decides the same way.
    [
      row[0].map(page =>
        page.map(item => (item === pack ? job(OPTIONAL_PACK_JOB, 'completed', 'skipped') : item)),
      ),
      ...row.slice(1),
      false,
    ],
  ])) {
    const s = await fixture(t);
    bindRepository(t, s.id.projectId, repository);
    const urls = [],
      mutations = [];
    t.mock.method(globalThis, 'fetch', async url => {
      if (url.endsWith('/installation')) return Response.json({ id: 9 });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-token' });
      urls.push(url);
      const jobs = answers[urls.length - 1];
      return Response.json({ total_count: jobs.length, jobs });
    });
    const ctx = {
      runMutation: (ref, input) => {
        mutations.push(getFunctionName(ref));
        return s.call(verdicts, getFunctionName(ref).split(':')[1], input);
      },
      runQuery: async () => null,
    };
    await s.bind();
    // With or without the pack job: every held pass reads its jobs (Issue 03a749a5).
    await s.prepare(null, undefined, packRefresh ? { packRefresh: true } : {});
    for (const index of [0, 1])
      await s.call(results, 'result', { ...s.input(), result: JSON.stringify({ index, exitCode: 0 }) });
    const confirms = () =>
      s.scheduled.filter(item => item.name.endsWith('projectHostedActionsVerdict:confirm'));
    for (let attempt = 0; attempt < answers.length; attempt++) {
      const read = confirms().at(-1);
      assert.equal(read.delay, [10_000, 30_000][attempt], 'seconds after the last result, not minutes');
      assert.equal(read.input.jobs, true);
      assert.equal(read.input.target.executionId, '123');
      await verdicts.confirm._handler(ctx, read.input);
    }
    assert.equal(urls.length, reads);
    assert.ok(urls.every(url => url.endsWith(`/repos/${repository}/actions/runs/123/jobs?per_page=100`)));
    assert.deepEqual(
      [...new Set(mutations)],
      ['projectHostedActionsVerdict:confirmed'],
      'a jobs read carries its target: no pendingConfirm call',
    );
    assert.equal((await s.status(s.run.id)).status, expected);
    if (expected === 'running') {
      const fallback = confirms().at(-1);
      assert.equal(fallback.delay, 5 * 60_000);
      assert.equal(fallback.input.jobs, undefined, 'then the run reads');
      assert.equal((await s.conclude('success')).status, 'passed', 'the event still settles it');
    } else {
      // The run's completed event, after the pack job, changes nothing.
      assert.equal((await s.conclude(expected === 'passed' ? 'failure' : 'success')).status, expected);
    }
  }
});
test('requiredJobsConclusion: only complete pages, every non-pack job completed, pack job ignored', () => {
  const job = (name, status, conclusion = null) => ({ name, status, conclusion });
  const page = jobs => ({ total_count: jobs.length, jobs });
  const plan = job('hosted-plan', 'completed', 'success');
  assert.equal(requiredJobsConclusion(page([plan, job(OPTIONAL_PACK_JOB, 'in_progress')])), 'success');
  assert.equal(
    requiredJobsConclusion(page([plan, job(OPTIONAL_PACK_JOB, 'completed', 'failure')])),
    'success',
    'continue-on-error: the run conclusion ignores it too',
  );
  assert.equal(requiredJobsConclusion({ total_count: 101, jobs: [plan] }), null, 'incomplete page');
  assert.equal(requiredJobsConclusion(page([job('forge-static', 'completed', 'skipped')])), null);
  assert.equal(requiredJobsConclusion(page([job(OPTIONAL_PACK_JOB, 'completed', 'success')])), null);
  assert.equal(
    requiredJobsConclusion(page([plan, job('forge-hosted-1', 'completed', 'cancelled')])),
    'cancelled',
  );
  assert.equal(requiredJobsConclusion(page([plan, job('forge-hosted-1', 'queued')])), null);
  assert.equal(requiredJobsConclusion(null), null);
  // The name is the workflow's own: renaming the job there must rename it here.
  assert.match(
    readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8'),
    new RegExp(`name: ${OPTIONAL_PACK_JOB}\n    continue-on-error: true`),
  );
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
test('source metadata batches yield before read exhaustion and retain session and exact object checks', async t => {
  const s = await fixture(t);
  await s.bind();
  const pins = Array.from({ length: 600 }, (_, i) => s.put(`bounded prefix ${i}`));
  const metrics = { databaseQueries: { remaining: 4096 }, bytesRead: { remaining: 3 * 1024 * 1024 } };
  s.decorateContext(ctx => {
    ctx.meta = { getTransactionMetrics: async () => metrics };
  });
  const input = { ...s.input(), batch: true, digests: pins.map(pin => pin.sha256) };
  const prefix = await s.call(source, 'resolve', input);
  assert.equal(prefix.length, 100, 'byte headroom returns a prefix instead of failing the job');
  metrics.bytesRead.remaining = 16 * 1024 * 1024;
  metrics.databaseQueries.remaining = 511;
  assert.equal((await s.call(source, 'resolve', input)).length, 100, 'sparse catalogs leave index headroom');
  metrics.databaseQueries.remaining = 4096;
  for (const row of s.tables.projectObjects.values()) {
    if (input.digests.includes(row.digest)) row.size = 32 * 1024;
  }
  assert.equal(
    (await s.call(source, 'resolve', input)).length,
    400,
    'large files retain the legacy grant lookahead',
  );
  await assert.rejects(s.call(source, 'resolve', { ...input, fence: 99 }), code('WORK_STALE'));
  await assert.rejects(
    s.call(source, 'resolve', { ...input, digests: ['f'.repeat(64)] }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(s.call(source, 'resolve', { ...input, digests: ['invalid'] }), code('BAD_ARGUMENT'));
});

test('bounded source windows at doubled dogfood scale stay O(pages); idle schedules zero', async t => {
  const started = performance.now(),
    s = await fixture(t, 9);
  await s.bind();
  await s.prepare();
  await s.call(sessions, 'session', s.input());
  await s.call(sessions, 'session', { ...s.input(), timings: true });
  const pins = Array.from({ length: 6000 }, (_, i) => s.put(`synthetic source ${i}`));
  const heads = ['base', 'candidate'].map(
    message =>
      s.put(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: [],
          at: '2026-01-01T00:00:00.000Z',
          message,
        }),
      ).sha256,
  );
  const baseline = s.counts.length,
    scheduled = s.scheduled.length;
  let calls = 0,
    maxPage = 0,
    maxMetadataBytes = 0;
  await s.call(source, 'resolve', { ...s.input(), digests: heads });
  calls++;
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
  assert.equal(calls, 16);
  assert.equal(maxPage, 400);
  assert.equal(s.scheduled.length, scheduled);
  const meters = s.counts.slice(baseline),
    documents = meters.reduce((n, m) => n + m.documents, 0);
  assert(documents <= 6200);
  assert(meters.every(m => m.writes === 0));
  const batchBaseline = s.counts.length;
  await s.call(source, 'resolve', { ...s.input(), batch: true, digests: heads });
  let batchCalls = 1,
    at = 0;
  while (at < pins.length) {
    const rows = await s.call(source, 'resolve', {
      ...s.input(),
      batch: true,
      digests: pins.slice(at, at + 3200).map(pin => pin.sha256),
    });
    assert(rows.length > 0 && rows.length <= 3200);
    assert.deepEqual(
      rows.map(row => row.descriptor.object.sha256),
      pins.slice(at, at + rows.length).map(pin => pin.sha256),
    );
    at += rows.length;
    batchCalls++;
  }
  const batchMeters = s.counts.slice(batchBaseline);
  const beforeBytes = meters.reduce((n, m) => n + m.readBytes, 0);
  const afterBytes = batchMeters.reduce((n, m) => n + m.readBytes, 0);
  // Ratchet the complete job's lookup budget: one manifest window plus two
  // metadata batches, and no retained report hydration, source bytes or writes.
  assert.equal(batchCalls, 3);
  assert(afterBytes < beforeBytes, `${afterBytes} bytes must improve on ${beforeBytes}`);
  assert(afterBytes <= 2_115_000);
  assert(batchMeters.every(m => m.ranges <= 4096 && m.writes === 0));
  assert.equal(s.scheduled.length, scheduled, 'no idle or background work');
  t.diagnostic(
    JSON.stringify({
      sourceLookup: {
        files: pins.length,
        beforeCalls: calls,
        afterCalls: batchCalls,
        beforeBytes,
        afterBytes,
      },
    }),
  );
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
  assert.equal((await s.conclude()).status, 'passed');
  const runMeters = s.counts.filter(
    m => !batchMeters.includes(m) && (m.name === 'checkEnqueue' || m.name.startsWith('direct-')),
  );
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

test('HTTP submodule access mints one read-only token per owner-allowed repository of the run installation, only for a live run', async t => {
  const s = await fixture(t, 1);
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const github = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === `${actionsIssuer}/.well-known/jwks`) return jwks();
    const path = new URL(url).pathname;
    github.push({ path, body: init.body && JSON.parse(init.body) });
    if (path === '/repos/other/stranger/installation') return Response.json({ id: 77 });
    if (path.endsWith('/installation')) return Response.json({ id: 9 });
    if (path === '/app/installations/9/access_tokens') return Response.json({ token: 'synthetic-token' });
    throw new Error(`unexpected ${path}`);
  });
  const modules = { projectHostedActionsSession: sessions };
  const ctx = {
    runMutation: (ref, input) => {
      const [name, method] = getFunctionName(ref).split(':');
      return s.raw(modules[name], method, input);
    },
  };
  // GitHub signs the run repository's visibility into the OIDC token.
  // An undefined value leaves the claim out of the signed token.
  const signed = visibility => `Bearer ${oidc(claims({ repository_visibility: visibility }))}`;
  const send = (repositories, authorization = signed('private')) =>
    handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify({ ...s.id, command: { kind: 'submoduleAccess', repositories } }),
      }),
    );
  // Not yet dispatched and acknowledged: no token and no GitHub call.
  assert.equal((await send(['synthetic/priv'])).status, 403);
  assert.deepEqual(github, []);
  await s.bind();
  assert.equal((await send(['synthetic/priv'], 'Bearer forged')).status, 403);
  assert.deepEqual(github, []);
  // Refused by default: nothing is allowed, so nothing reaches GitHub.
  const closed = await send(['synthetic/priv', 'other/stranger']);
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), {
    'synthetic/priv': { refused: 'not-allowed' },
    'other/stranger': { refused: 'not-allowed' },
  });
  assert.deepEqual(github, []);
  // The owner allows two repositories while the run is live; the current setting applies.
  const allow = async (submodules, expected) =>
    s.configure(
      { kind: 'runner', configuration: { ...s.runner, ...(submodules ? { submodules } : {}) } },
      expected,
    );
  const allowed = await allow(
    [{ repository: 'other/stranger' }, { repository: 'Synthetic/Priv' }],
    s.configuration.digest,
  );
  const response = await send(['synthetic/priv', 'other/stranger', 'synthetic/unlisted']);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    'synthetic/priv': { token: 'synthetic-token' },
    'other/stranger': { refused: 'outside-installation' },
    'synthetic/unlisted': { refused: 'not-allowed' },
  });
  assert.deepEqual(
    github.filter(call => call.path.endsWith('/access_tokens')).map(call => call.body),
    [{ repositories: ['priv'], permissions: { contents: 'read' } }],
  );
  assert.equal(github[0].path, '/repos/synthetic/project/installation', 'anchored on the run repository');
  assert(!github.some(call => call.path.startsWith('/repos/synthetic/unlisted')));
  // Issue f7793473: a fork pull request's run gets no private submodule, whatever the allowlist
  // says, and nothing reaches GitHub.
  const runRow = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === s.run.id);
  const plain = runRow.value;
  const forked = JSON.parse(plain);
  forked.request.origin = 'fork-pull';
  s.patch('projectHostedCheckRuns', runRow._id, { value: JSON.stringify(forked) });
  github.length = 0;
  assert.deepEqual(await (await send(['synthetic/priv'])).json(), {
    'synthetic/priv': { refused: 'not-allowed' },
  });
  assert.deepEqual(github, []);
  s.patch('projectHostedCheckRuns', runRow._id, { value: plain });
  // A run repository not proven private has public logs: no token without a public-logs grant,
  // and nothing reaches GitHub. (A public project; a private one is refused outright, below.)
  s.patch('hostedProjects', s.projectId, { visibility: 'public' });
  for (const visibility of ['public', 'internal', undefined]) {
    github.length = 0;
    assert.deepEqual(await (await send(['synthetic/priv'], signed(visibility))).json(), {
      'synthetic/priv': { refused: 'public-logs' },
    });
    assert.deepEqual(github, []);
  }
  s.patch('hostedProjects', s.projectId, { visibility: undefined });
  // The owner's current publicLogs acceptance also counts, even for a private run repository.
  const flagged = await s.configure(
    {
      kind: 'runner',
      configuration: { ...s.runner, publicLogs: true, submodules: [{ repository: 'synthetic/priv' }] },
    },
    allowed.digest,
  );
  github.length = 0;
  assert.deepEqual(await (await send(['synthetic/priv'])).json(), {
    'synthetic/priv': { refused: 'public-logs' },
  });
  assert.deepEqual(github, []);
  // Withdrawn by the owner: the next request of the same run is refused.
  await allow(undefined, flagged.digest);
  github.length = 0;
  assert.deepEqual(await (await send(['synthetic/priv'])).json(), {
    'synthetic/priv': { refused: 'not-allowed' },
  });
  assert.deepEqual(github, []);
  assert.equal((await send(['../x/y'])).status, 403);
  // Issue 6ba1539d: a private project in a runner repository not proven private is refused
  // before the allowlist is read, with no GitHub call.
  github.length = 0;
  assert.equal((await send(['synthetic/priv'], signed('public'))).status, 403);
  assert.deepEqual(github, []);
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
      return s.raw(modules[name], method, input);
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
      return s.raw(modules[name], method, input);
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
  const visibilities = await import(moduleUrl('../convex/githubRepositoryVisibility.ts'));
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runMutation: (ref, input) =>
      getFunctionName(ref) === 'githubRepositoryVisibility:record'
        ? s.call(visibilities, 'record', input)
        : s.transaction('direct-configure', definitions.configure, input),
  };
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  });
  let lookups = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    lookups++;
    if (url.endsWith('/access_tokens')) {
      // Connect proves the binding with a metadata-only token; no Actions write token.
      assert.deepEqual(JSON.parse(init.body).permissions, { metadata: 'read' });
      return Response.json({ token: 'synthetic-token' });
    }
    const read = repositoryRead(url);
    if (read) return read;
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
        runMutation: (ref, args) =>
          getFunctionName(ref) === 'githubRepositoryVisibility:record'
            ? s.transaction('direct-visibility-denied', visibilities.record, args, 'other')
            : s.transaction('direct-configure-denied', definitions.configure, args, 'other'),
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
  const reserved = await s.reserve();
  // A lost dispatch reply: the dispatch carries no run id, so the webhook may bind.
  await s.call(direct, 'observe', { ...s.id, fence: reserved.fence, outcome: 'unknown', failure: 'timeout' });
  variables(t, { GITHUB_WEBHOOK_SECRET: 'synthetic-webhook-key' });
  const { createHmac } = await import('node:crypto');
  const { default: http } = await import(moduleUrl('../convex/http.ts'));
  const route = http.getRoutes().find(([path]) => path === '/github/webhook')[2];
  const payload = JSON.stringify(webhook(s));
  const signature = `sha256=${createHmac('sha256', 'synthetic-webhook-key').update(payload).digest('hex')}`;
  const send = signature =>
    route._handler(
      { runMutation: (_ref, input) => s.raw(webhooks, 'receive', input) },
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
  assert.equal((await s.status(s.run.id)).status, 'unknown');
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
      return s.raw(
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
          command: { kind: 'plan', plan: { recipe, lockfile: 'e'.repeat(64) }, packRefresh: true },
        }),
      }),
    );
  r2.hooks.mismatch = true;
  assert.equal((await send()).status, 503);
  assert.equal((await s.status(s.run.id)).plan, null, 'unverified bytes never publish a plan');
  assert.deepEqual(mutations, ['projectHostedActionsSession']);
  r2.hooks.mismatch = false;
  mutations.length = 0;
  const before = process.memoryUsage().rss,
    started = performance.now();
  assert.equal((await send()).status, 200);
  assert.deepEqual(mutations, ['projectHostedActionsSession', 'projectHostedActionsPlan']);
  // The plan's pack job rides the same plan write (friction 0064c3b2): no added call.
  assert.equal((await s.status(s.run.id)).actions.packRefresh, true);
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

test('HTTP plan stores the selection and recipe objects concurrently with the same R2 requests', async t => {
  const s = await fixture(t);
  await s.bind();
  fakeSourceR2(t);
  const r2Fetch = globalThis.fetch;
  let inFlight = 0,
    peak = 0;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname === 'token.actions.githubusercontent.com') return jwks();
    requests.push(init?.method ?? 'GET');
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      // A fixed per-request delay: serial storage would never have two requests open.
      await new Promise(resolve => setTimeout(resolve, 5));
      return await r2Fetch(url, init);
    } finally {
      inFlight--;
    }
  };
  const pins = {
    head: s.run.request.expectedHead,
    definition: s.run.check.definition,
    selection: { scope: 'full', reason: 'synthetic overlap', tests: ['tests/a.test.mjs'] },
    standard: true,
    interaction: false,
    command: ['node', 'scripts/forge-check.mjs'],
  };
  const recipePins = { ...pins, groups: [pins.selection.tests] },
    recipe = { ...recipePins, pin: checkPin(recipePins) };
  const ctx = {
    runMutation: (ref, input) => {
      const [name, method] = getFunctionName(ref).split(':');
      return s.raw(
        { projectHostedActionsSession: sessions, projectHostedActionsPlan: plans }[name],
        method,
        input,
      );
    },
  };
  const response = await handle._handler(
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
  assert.equal(response.status, 200);
  assert.equal(peak, 2, 'the two independent objects overlap their R2 round trips');
  // Request count is unchanged: per object one reuse HEAD, one PUT and one verify HEAD.
  assert.deepEqual(requests.toSorted(), ['HEAD', 'HEAD', 'HEAD', 'HEAD', 'PUT', 'PUT']);
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
      return s.raw(modules[name], method, input);
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
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).reason, 'storage');
});

test('source pack reservations bound project storage to two objects and delete older objects before replacement', async t => {
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
  test(`cancelled check schedules one stop and reconciles replay on the same bound execution (${responseStatus})`, async t => {
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
    const ctx = { runMutation: (ref, args) => s.raw(webhooks, getFunctionName(ref).split(':')[1], args) };
    // Lose the preparation reply after it committed: the provider has not been contacted yet.
    await s.raw(webhooks, 'cancellation', s.id);
    assert.equal(cancels, 0);
    await Promise.all([webhooks.cancel._handler(ctx, s.id), webhooks.cancel._handler(ctx, s.id)]);
    await webhooks.cancel._handler(ctx, s.id);
    assert.equal(cancels, 3, 'each replay reconciles only the same run; no stop is lost after preparation');
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
    runMutation: (ref, args) => s.raw(webhooks, getFunctionName(ref).split(':')[1], args),
    runQuery: async ref => {
      assert.equal(getFunctionName(ref), 'githubBindingStore:page');
      return JSON.stringify({ page: [], isDone: true, continueCursor: '' });
    },
  };
  await assert.rejects(webhooks.cancel._handler(ctx, s.id), code('GITHUB_REPOSITORY_UNBOUND'));
  assert.equal(installations, 1);
});

test('Issue 77fa4412: a runner grant dispatches and cancels by numeric id with no added Convex call', async t => {
  const s = await fixture(t);
  // No operator pair and no stored binding: only the owner's runner grant for this repository.
  variables(t, {
    FORGE_GITHUB_REPO_BINDINGS: '',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  s.insert('githubRunnerGrants', {
    owner: 'owner',
    repoId: 77,
    fullName: repository,
    installationId: 9,
    githubAccount: '1001',
    grantedAt: 1,
  });
  const minted = [],
    names = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/installation')) return Response.json({ id: 9 });
    if (url.endsWith('/access_tokens')) {
      minted.push(JSON.parse(init.body));
      return Response.json({ token: 'synthetic-token' });
    }
    if (url.endsWith('/forge-check.yml/dispatches')) return Response.json({ workflow_run_id: 123 });
    // The private project's runner visibility read (6ba1539d) uses the same grant-scoped token.
    if (url.endsWith(`/repos/${repository}`)) return Response.json({ private: true, visibility: 'private' });
    assert(url.endsWith('/actions/runs/123/cancel'));
    return new Response(null, { status: 202 });
  });
  const ctx = {
    runMutation: (ref, input) => {
      names.push(getFunctionName(ref));
      const [module, method] = getFunctionName(ref).split(':');
      return s.raw(
        { projectHostedActionsDirect: direct, projectHostedActionsWebhook: webhooks }[module],
        method,
        input,
      );
    },
    runQuery: async ref => assert.fail(`no binding query per mint (${getFunctionName(ref)})`),
  };
  await direct.dispatch._handler(ctx, s.id);
  assert.equal((await s.status(s.run.id)).executionId, '123');
  assert.deepEqual(names, ['projectHostedActionsDirect:reserve', 'projectHostedActionsDirect:observe']);
  assert.deepEqual(minted, [{ repository_ids: [77], permissions: { actions: 'write', contents: 'read' } }]);
  await s.cancel(s.run.id);
  await webhooks.cancel._handler(ctx, s.id);
  assert.equal(minted.length, 2);
  assert.deepEqual(minted[1].repository_ids, [77]);
});
test('cancelled HTTP calls return a distinct safe 403 that old runners already refuse', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  await s.cancel(s.run.id);
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const ctx = { runMutation: (_ref, args) => s.raw(sessions, 'session', args) };
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
        return s.raw(sessions, 'session', input);
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

test('transient OIDC key lookup and service failures return safe infrastructure responses', async t => {
  const s = await fixture(t);
  await s.bind();
  const send = ctx =>
    handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({ ...s.id, command: { kind: 'session' } }),
      }),
    );
  for (const status of [429, 503]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('private-provider-body', { status }));
    const response = await send({ runMutation: () => assert.fail('unavailable keys cannot authorize') });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private-provider-body/);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const response = await send({
    runMutation: () => {
      throw new Error('private-service-error');
    },
  });
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-service-error/);
});

test('Issue 0c457ae4: a Convex value-limit refusal is a deterministic 403 limit, not a retryable 503', async t => {
  const s = await fixture(t);
  await s.bind();
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const send = message =>
    handle._handler(
      {
        runMutation: () => {
          throw new Error(message);
        },
      },
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({ ...s.id, command: { kind: 'session' } }),
      }),
    );
  for (const message of [
    'Uncaught Error: return value invalid: Object has too many fields (1025 > maximum number 1024)',
    'Array length is too long (8193 > maximum length 8192)',
    'Value is too large (1.2 MiB > maximum size 1 MiB)',
  ]) {
    const response = await send(message);
    assert.equal(response.status, 403, message);
    const body = await response.json();
    assert.equal(body.reason, 'limit');
    assert.doesNotMatch(JSON.stringify(body), /1025|8193|MiB/);
  }
  // Anything else without a code stays an outage the runner may retry.
  assert.equal((await send('Connection lost while action was in flight')).status, 503);
});

test('Issue 72d50375: a paused deployment answers 503 with Retry-After so the runner keeps its result', async t => {
  const s = await fixture(t);
  await s.bind();
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const now = Date.now();
  const prior = process.env.FORGE_LEGACY_STORAGE_PAUSE;
  process.env.FORGE_LEGACY_STORAGE_PAUSE = JSON.stringify({
    deployment: 'dev:forge',
    operationId: randomUUID(),
    startedAt: now,
    expiresAt: now + 600_000,
  });
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_LEGACY_STORAGE_PAUSE;
    else process.env.FORGE_LEGACY_STORAGE_PAUSE = prior;
  });
  const response = await handle._handler(
    {
      runMutation: () => {
        throw Object.assign(new Error('Dev writes are paused'), {
          data: { code: 'LEGACY_STORAGE_WRITES_PAUSED' },
        });
      },
    },
    new Request(`${audience}/checks/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oidc()}` },
      body: JSON.stringify({ ...s.id, command: { kind: 'session' } }),
    }),
  );
  assert.equal(response.status, 503);
  const seconds = Number(response.headers.get('Retry-After'));
  assert(seconds > 590 && seconds <= 600, String(seconds));
});

test('failed shard evidence still fails the check when a later infrastructure job fails', async t => {
  const s = await fixture(t);
  await s.bind();
  await s.prepare();
  await s.call(results, 'result', { ...s.input(), result: JSON.stringify({ index: 0, exitCode: 7 }) });
  await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'completed', 'failure')) });
  assert.equal((await s.status(s.run.id)).status, 'failed');
});

const reconcileModule = await import(moduleUrl('../convex/projectHostedCheckReconcile.ts'));
/** One GitHub App fake: dispatch answers `dispatch`, the run listing answers `runs`. */
function github(t, s, { dispatch, runs = [], visibility = 'private' }) {
  variables(t, {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const calls = { dispatch: 0, list: 0, repository: 0 };
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/installation')) return Response.json({ id: 9 });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-token' });
    const read = repositoryRead(url, visibility);
    if (read) {
      calls.repository++;
      return read;
    }
    if (url.endsWith('/forge-check.yml/dispatches')) {
      calls.dispatch++;
      return dispatch();
    }
    assert.match(
      url,
      /\/actions\/workflows\/forge-check\.yml\/runs\?event=workflow_dispatch&per_page=100&created=/,
    );
    calls.list++;
    return Response.json({ workflow_runs: runs });
  });
  const ctx = { runMutation: (ref, input) => s.raw(direct, getFunctionName(ref).split(':')[1], input) };
  return { calls, ctx };
}
const reconcileTasks = s => s.scheduled.filter(item => item.name === 'projectHostedActionsDirect:reconcile');

test('incident a7de3a93 replay: a dispatch that throws is reconciled by run-name at 5 min instead of waiting 12 h', async t => {
  // 2026-11-05 16:04/16:07Z: the dispatch call threw after `unknown`; GitHub created no
  // run, so the run stayed unknown, no executionId, and the queue head never moved.
  const s = await fixture(t);
  const { calls, ctx } = github(t, s, {
    dispatch: () => {
      throw new TypeError('Synthetic network failure');
    },
    runs: [{ id: 77, display_title: `forge-check/${randomUUID()}` }],
  });
  await direct.dispatch._handler(ctx, s.id);
  let run = await s.status(s.run.id);
  assert.equal(run.status, 'unknown');
  assert.equal(run.executionId, null);
  assert.equal(run.actions.failure, 'network', 'the error class is recorded, never its message');
  const [task] = reconcileTasks(s);
  assert(task, 'an unacknowledged dispatch schedules one reconciliation');
  assert.equal(task.delay, direct.directActionsAckMs);
  assert.equal(direct.directActionsAckMs, 5 * 60_000);
  assert.equal(reconcileTasks(s).length, 1);
  await direct.reconcile._handler(ctx, task.input);
  assert.deepEqual(
    calls,
    { dispatch: 1, list: 1, repository: 1 },
    'one lookup and one visibility read; the dispatch itself is never resent',
  );
  run = await s.status(s.run.id);
  assert.equal(run.status, 'interrupted', 'terminal, so the landing platform retry re-dispatches');
  assert.match(run.failureReason, /never acknowledged \(network; lookup absent\)/);
  // Late reports for the settled run are refused by run id: nothing binds it.
  await s.call(webhooks, 'receive', { payload: JSON.stringify(webhook(s, 'requested', null)) });
  assert.equal((await s.status(s.run.id)).executionId, null);
  await assert.rejects(s.call(sessions, 'session', s.input()), code('EVIDENCE_CHANGED'));
  // A replayed reconciliation is a one-read no-op.
  await direct.reconcile._handler(ctx, task.input);
  assert.equal(calls.list, 1);
});

test('incident a7de3a93: a slow (not lost) dispatch found by run-name is adopted, never dispatched twice', async t => {
  const s = await fixture(t);
  const { calls, ctx } = github(t, s, {
    dispatch: () => new Response('synthetic', { status: 502 }),
    runs: [{ id: 555, display_title: `forge-check/${s.run.id}` }],
  });
  await direct.dispatch._handler(ctx, s.id);
  assert.equal((await s.status(s.run.id)).actions.failure, 'http 502');
  await direct.reconcile._handler(ctx, reconcileTasks(s)[0].input);
  const run = await s.status(s.run.id);
  assert.equal(run.executionId, '555');
  assert.equal(run.status, 'preparing');
  assert.equal(calls.dispatch, 1);
  // The workflow then binds the same execution through the existing webhook.
  await s.call(webhooks, 'receive', {
    payload: JSON.stringify(webhook(s, 'requested', null, { id: 555 })),
  });
  assert.equal((await s.status(s.run.id)).executionId, '555');
});

test('dispatch refusals: 4xx settles at once with its status, 429 waits for Retry-After, 401/403 name the next step', async t => {
  const refused = await fixture(t);
  let gh = github(t, refused, { dispatch: () => new Response('no', { status: 422 }) });
  await direct.dispatch._handler(gh.ctx, refused.id);
  let run = await refused.status(refused.run.id);
  assert.equal(run.status, 'runner-unavailable');
  assert.equal(run.failureReason, 'GitHub App dispatch was refused (http 422).');
  assert.equal(reconcileTasks(refused).length, 0, 'a refusal proves no run exists: no lookup');

  t.mock.restoreAll();
  const limited = await fixture(t);
  gh = github(t, limited, {
    dispatch: () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
  });
  await direct.dispatch._handler(gh.ctx, limited.id);
  run = await limited.status(limited.run.id);
  assert.equal(run.status, 'unknown', 'waits for Retry-After before the platform retry');
  const [wait] = reconcileTasks(limited);
  assert.equal(wait.delay, 120_000);
  await direct.reconcile._handler(gh.ctx, wait.input);
  assert.equal(gh.calls.list, 0, 'a rate-limited dispatch created no run: no lookup');
  run = await limited.status(limited.run.id);
  assert.equal(run.status, 'runner-unavailable');
  assert.match(run.failureReason, /rate-limited the dispatch \(http 429\)/);
  assert.equal(
    direct.classifyDispatchFailure(
      new Response(null, { status: 429, headers: { 'retry-after': '99999' } }),
      null,
      'dispatch',
    ).retryAfterMs,
    15 * 60_000,
    'Retry-After is bounded',
  );

  t.mock.restoreAll();
  const denied = await fixture(t);
  gh = github(t, denied, { dispatch: () => new Response('no', { status: 403 }) });
  await direct.dispatch._handler(gh.ctx, denied.id);
  run = await denied.status(denied.run.id);
  assert.equal(run.status, 'runner-unavailable');
  assert.match(
    run.failureReason,
    /refused \(http 403\)\. Check that the Forge GitHub App is installed on synthetic\/project with Actions write permission/,
  );
});

test('runner contract: the checking stall alarm reconciles only an unacknowledged dispatch past its bound', async t => {
  const s = await fixture(t);
  await s.reserve();
  const run = await s.status(s.run.id);
  const call = now =>
    s.transaction(
      'reconcile',
      { _handler: (ctx, input) => reconcileModule.reconcileUnacknowledgedCheck(ctx, input, now) },
      s.id,
    );
  assert.equal(await call(run.actions.reservedAt + 60_000), 'none', 'inside the bound the adapter owns it');
  assert.equal(await call(run.actions.reservedAt + direct.directActionsAckMs), 'lookup');
  assert.equal(reconcileTasks(s).at(-1).delay, 0);
  await s.call(direct, 'observe', { ...s.id, fence: 1, outcome: 'accepted', executionId: '123' });
  const size = s.scheduled.length;
  assert.equal(await call(run.actions.reservedAt + 60 * 60_000), 'none', 'acknowledged: one read, no work');
  assert.equal(s.scheduled.length, size);
});

test('shard pool: the existing plan call signs one create-only claim per unit with no extra Convex call', async t => {
  const s = await fixture(t);
  await s.bind();
  const r2 = fakeSourceR2(t),
    r2Fetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new URL(url).hostname === 'token.actions.githubusercontent.com'
      ? Promise.resolve(jwks())
      : r2Fetch(url, init);
  const groups = [
    ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs'],
    ['tests/d.test.mjs', 'tests/e.test.mjs'],
  ];
  const recipePins = {
      head: s.run.request.expectedHead,
      definition: s.run.check.definition,
      selection: { scope: 'full', reason: 'synthetic', tests: groups.flat() },
      groups,
      pool: [[1, 2], [1]],
      standard: true,
      interaction: false,
      command: ['node', 'scripts/forge-check.mjs'],
    },
    recipe = { ...recipePins, pin: checkPin(recipePins) },
    mutations = [];
  const ctx = {
    runMutation: (ref, input) => {
      const [name, method] = getFunctionName(ref).split(':');
      mutations.push(name);
      return s.raw(
        { projectHostedActionsSession: sessions, projectHostedActionsPlan: plans }[name],
        method,
        input,
      );
    },
  };
  const response = await handle._handler(
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
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(mutations, ['projectHostedActionsSession', 'projectHostedActionsPlan']);
  assert.equal(body.run.id, s.run.id);
  assert.equal(body.claims.length, 3);
  const execution = savePin(body.run.executionId).sha256.slice(0, 16);
  for (const [unit, claim] of body.claims.entries()) {
    const put = new URL(claim.put.url),
      head = new URL(claim.head);
    assert.equal(put.pathname, `/synthetic/v1/pool/${s.projectId}/${s.run.id}/${execution}/${unit}`);
    assert.equal(head.pathname, put.pathname);
    assert.equal(put.searchParams.get('X-Amz-Expires'), '7200');
    assert.equal(claim.put.headers['if-none-match'], '*');
    assert.equal(claim.put.headers['content-length'], String(`forge-claim-v1 ${unit}\n`.length));
  }
  // Signing is CPU only: no claim object is created or read by the server.
  assert(![...r2.objects.keys()].some(key => key.includes('/v1/pool/')));
  assert.equal(r2.objects.size, 2);
});

test('shard pool: yielded files must be reported by some shard; duplicates count once and failures win', async t => {
  const s = await fixture(t, 3);
  await s.bind();
  await s.prepare();
  const send = result => s.call(results, 'result', { ...s.input(), result: JSON.stringify(result) });
  const pass = { durationMs: 5, failed: false },
    fail = { durationMs: 5, failed: true, firstError: 'boom' };
  let run = await send({
    index: 0,
    exitCode: 0,
    contractReports: { 'tests/synthetic-0.test.mjs': pass },
    pool: { yielded: ['tests/yielded-a.test.mjs', 'tests/yielded-b.test.mjs'] },
  });
  assert.deepEqual(run.poolPending, ['tests/yielded-a.test.mjs', 'tests/yielded-b.test.mjs']);
  assert.equal(run.poolClaimed, true, 'the final result deletes this run claims');
  // The thief reports one yielded file, and a doubt run repeats a file that already passed, failing.
  run = await send({
    index: 1,
    exitCode: 1,
    contractReports: {
      'tests/synthetic-1.test.mjs': pass,
      'tests/yielded-a.test.mjs': pass,
      'tests/synthetic-0.test.mjs': fail,
    },
  });
  assert.deepEqual(run.poolPending, ['tests/yielded-b.test.mjs']);
  // Progress carries the summary; the full reports join the run row once it settles (Issue d0f8472a).
  assert.equal(run.contractReports, undefined);
  assert.deepEqual(
    run.testFiles.failed.map(item => item.file),
    ['tests/synthetic-0.test.mjs'],
  );
  run = await send({ index: 2, exitCode: 0 });
  assert.equal(run.status, 'failed');
  assert.equal(run.poolPending, undefined);
  assert.match(run.contractReports['tests/yielded-b.test.mjs'].firstError, /^POOL_UNIT_UNREPORTED/);
  assert.equal(run.testFiles.counts.total, 4, 'each file counted once');
});

test('shard pool: a pooled check whose yielded files were all reported passes', async t => {
  const s = await fixture(t, 3);
  await s.bind();
  await s.prepare();
  const send = result => s.call(results, 'result', { ...s.input(), result: JSON.stringify(result) });
  const pass = { durationMs: 5, failed: false };
  await send({
    index: 1,
    exitCode: 0,
    contractReports: { 'tests/synthetic-1.test.mjs': pass, 'tests/yielded.test.mjs': pass },
  });
  await send({
    index: 0,
    exitCode: 0,
    contractReports: { 'tests/synthetic-0.test.mjs': pass },
    pool: { yielded: ['tests/yielded.test.mjs'] },
  });
  await send({ index: 2, exitCode: 0 });
  const run = await s.conclude();
  assert.equal(run.status, 'passed');
  assert.equal(run.poolPending, undefined);
});

const claimList = (keys, modified) =>
  new Response(
    `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys
      .map(
        (key, index) =>
          `<Contents><Key>${encodeURIComponent(key)}</Key><LastModified>${modified[index]}</LastModified><Size>18</Size></Contents>`,
      )
      .join('')}</ListBucketResult>`,
  );
test('shard pool: the final result deletes its run claims and sweeps stale ones, with no Convex call', async t => {
  const s = await fixture(t, 1);
  await s.bind();
  await s.prepare();
  const root = `v1/pool/${s.projectId}/`,
    own = `${root}${s.run.id}/`,
    fresh = new Date().toISOString(),
    old = new Date(Date.now() - 3 * 3600_000).toISOString();
  const ownKeys = [`${own}abcd/0`, `${own}abcd/1`],
    staleKey = `${root}ffffffff-0000-4000-8000-000000000000/abcd/0`,
    liveKey = `${root}ffffffff-0000-4000-8000-000000000001/abcd/0`;
  const deleted = [],
    lists = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (url === `${actionsIssuer}/.well-known/jwks`) return jwks();
    const target = new URL(url),
      method = init.method ?? 'GET';
    if (method === 'PUT') return new Response(null, { status: 200 });
    if (method === 'DELETE') {
      deleted.push(target.pathname.replace(/^\/[^/]+\//, ''));
      return new Response(null, { status: 204 });
    }
    if (target.searchParams.get('list-type') === '2') {
      const prefix = target.searchParams.get('prefix');
      lists.push({ prefix, startAfter: target.searchParams.get('start-after') });
      return prefix === own
        ? claimList(ownKeys, [fresh, fresh])
        : claimList([staleKey, liveKey], [old, fresh]);
    }
    assert.equal(method, 'HEAD');
    const finalRoot = [...s.tables.projectHostedOutputHeads.values()][0];
    const { rootForOutput } = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
    const { canonicalPayload } = await import('../dist/hosted-source-operation.js');
    const { digest } = await import('../dist/hash.js');
    const rootBytes = Buffer.from(canonicalPayload(rootForOutput(s.id, '123', finalRoot)));
    return new Response(null, {
      status: 200,
      headers: {
        'content-length': String(rootBytes.length),
        'x-amz-checksum-sha256': Buffer.from(digest(rootBytes), 'hex').toString('base64'),
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
      const [name, method] = getFunctionName(ref).split(':');
      mutations.push(`${name}:${method}`);
      return s.raw(modules[name], method, input);
    },
  };
  const result = {
    index: 0,
    exitCode: 0,
    contractReports: { 'tests/synthetic-0.test.mjs': { durationMs: 5, failed: false } },
    pool: { yielded: [] },
  };
  const response = await handle._handler(
    ctx,
    new Request(`${audience}/checks/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oidc()}` },
      body: JSON.stringify({ ...s.id, fence: 1, command: { kind: 'result', result } }),
    }),
  );
  assert.equal(response.status, 200);
  // Every shard reported: claims are cleaned now; the pass itself waits for the provider.
  assert.equal((await response.json()).actions.verdictPending, true);
  // The own-claims page and the stale sweep run concurrently and each signs before it fetches, so their
  // arrival order is not defined; both exact list calls are still required.
  assert.deepEqual(
    lists.sort((a, b) => a.prefix.length - b.prefix.length),
    [
      { prefix: root, startAfter: `${own}~` },
      { prefix: own, startAfter: null },
    ],
  );
  assert.deepEqual(deleted.sort(), [...ownKeys, staleKey].sort(), 'a live run keeps its claims');
  assert(!mutations.some(name => /pool/i.test(name)), 'cleanup adds no Convex call');
});
test('shard pool: claim cleanup is best effort and never throws', async t => {
  fakeSourceR2(t);
  const { cleanPoolClaims } = await import(moduleUrl('../convex/projectHostedActionsHttp.ts'));
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('storage down');
  });
  await cleanPoolClaims('project', '00000000-0000-4000-8000-000000000000');
  t.mock.method(globalThis, 'fetch', async () => new Response('<Error/>', { status: 500 }));
  await cleanPoolClaims('project', '00000000-0000-4000-8000-000000000000');
});

const { requirePrivateRunner, repositoryVisibility, runnerVisibilityTtlMs } =
  await import('../dist/runner-visibility.js');
const visibilityRows = s => [...s.tables.githubRepositoryVisibility.values()];
test('Issue 6ba1539d: only a private runner repository may run a private project; public projects are unchanged', () => {
  assert.equal(repositoryVisibility({ private: false }), 'public');
  assert.equal(repositoryVisibility({ private: true, visibility: 'internal' }), 'internal');
  assert.equal(repositoryVisibility({}), 'unknown');
  for (const visibility of ['public', 'internal', 'unknown', undefined])
    assert.throws(
      () => requirePrivateRunner('private', 'synthetic/project', visibility),
      code('RUNNER_REPOSITORY_PUBLIC'),
    );
  // A project without an explicit visibility is private, as for every read.
  assert.throws(
    () => requirePrivateRunner(undefined, 'synthetic/project', 'public'),
    code('RUNNER_REPOSITORY_PUBLIC'),
  );
  requirePrivateRunner('private', 'synthetic/project', 'private');
  for (const visibility of ['public', 'private', undefined])
    requirePrivateRunner('public', 'NanthAI/nanthai-forge', visibility);
});
test('Issue 6ba1539d: a private project never dispatches to a public runner repository; one cached read per expiry', async t => {
  const refused = await fixture(t);
  let gh = github(t, refused, {
    dispatch: () => Response.json({ workflow_run_id: 123 }),
    visibility: 'public',
  });
  await direct.dispatch._handler(gh.ctx, refused.id);
  let run = await refused.status(refused.run.id);
  assert.deepEqual(gh.calls, { dispatch: 0, list: 0, repository: 1 }, 'no workflow starts, so no log exists');
  assert.equal(run.status, 'runner-unavailable');
  assert.match(
    run.failureReason,
    /^Runner repository synthetic\/project is public, but this project is private: .*No source was sent\. .*configure-runner/,
  );
  assert.equal(reconcileTasks(refused).length, 0, 'a refusal before dispatch needs no lookup');
  assert.deepEqual(
    visibilityRows(refused).map(row => [row.repository, row.visibility]),
    [['synthetic/project', 'public']],
  );

  // A private repository dispatches after one read, recorded by the existing observe call.
  t.mock.restoreAll();
  const allowed = await fixture(t);
  gh = github(t, allowed, { dispatch: () => Response.json({ workflow_run_id: 123 }) });
  await direct.dispatch._handler(gh.ctx, allowed.id);
  assert.equal((await allowed.status(allowed.run.id)).executionId, '123');
  assert.deepEqual(gh.calls, { dispatch: 1, list: 0, repository: 1 });
  assert.deepEqual(
    visibilityRows(allowed).map(row => row.visibility),
    ['private'],
  );

  // A fresh read is reused with no GitHub call (a cached public one refuses at once);
  // an expired one is read again.
  for (const [cached, age, reads, dispatches] of [
    ['private', 0, 0, 1],
    ['public', 0, 0, 0],
    ['private', runnerVisibilityTtlMs + 1, 1, 1],
  ]) {
    t.mock.restoreAll();
    const s = await fixture(t);
    s.insert('githubRepositoryVisibility', {
      repository: 'synthetic/project',
      visibility: cached,
      checkedAt: Date.now() - age,
    });
    gh = github(t, s, { dispatch: () => Response.json({ workflow_run_id: 123 }) });
    await direct.dispatch._handler(gh.ctx, s.id);
    assert.deepEqual([gh.calls.repository, gh.calls.dispatch], [reads, dispatches], `${cached} ${age}`);
    if (!dispatches) assert.equal((await s.status(s.run.id)).status, 'runner-unavailable');
  }

  // A public project reads nothing: the zoo and bench projects keep their public runner.
  t.mock.restoreAll();
  const open = await fixture(t);
  open.patch('hostedProjects', open.projectId, { visibility: 'public' });
  gh = github(t, open, { dispatch: () => Response.json({ workflow_run_id: 123 }), visibility: 'public' });
  await direct.dispatch._handler(gh.ctx, open.id);
  assert.deepEqual(gh.calls, { dispatch: 1, list: 0, repository: 0 });
  assert.equal(visibilityRows(open).length, 0);
});
test('Issue 6ba1539d: a runner repository made public after connecting is refused at the next check before any source', async t => {
  const s = await fixture(t);
  // Connected while private; the cached read is still fresh, so dispatch reads nothing.
  s.insert('githubRepositoryVisibility', {
    repository: 'synthetic/project',
    visibility: 'private',
    checkedAt: Date.now(),
  });
  const gh = github(t, s, { dispatch: () => Response.json({ workflow_run_id: 123 }) });
  await direct.dispatch._handler(gh.ctx, s.id);
  assert.equal(gh.calls.repository, 0);
  // GitHub signs the visibility the workflow actually ran in.
  const flipped = s.input({ claims: JSON.stringify(claims({ repository_visibility: 'public' })) });
  for (const [module, name, extra] of [
    [sessions, 'session', {}],
    [source, 'resolve', { digests: ['b'.repeat(64)] }],
  ])
    await assert.rejects(s.call(module, name, { ...flipped, ...extra }), code('RUNNER_REPOSITORY_PUBLIC'));
  const missing = claims();
  delete missing.repository_visibility;
  await assert.rejects(
    s.call(sessions, 'session', s.input({ claims: JSON.stringify(missing) })),
    code('RUNNER_REPOSITORY_PUBLIC'),
    'fails closed without the claim',
  );
  // Over HTTP the runner gets the usual safe 403; the run settles with the reason and
  // the next dispatch refuses from the cache without starting a workflow.
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const names = [];
  const ctx = {
    runMutation: (ref, args) => {
      const name = getFunctionName(ref).split(':')[1];
      names.push(name);
      return s.call(sessions, name, args);
    },
  };
  const response = await handle._handler(
    ctx,
    new Request(`${audience}/checks/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${oidc(claims({ repository_visibility: 'public' }))}` },
      body: JSON.stringify({ ...s.id, command: { kind: 'session' } }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, 'authorization');
  assert.deepEqual(names, ['session', 'refusePublicRunner']);
  const run = await s.status(s.run.id);
  assert.equal(run.status, 'runner-unavailable');
  assert.match(run.failureReason, /synthetic\/project is public, but this project is private/);
  // Remembered, so the next dispatch refuses from the cache (covered above).
  assert.equal(visibilityRows(s)[0].visibility, 'public');
});
test('Issue 6ba1539d: the owner opt-in publicLogs lets a private project run in a public runner repository', async t => {
  const s = await fixture(t, 2, 'ubuntu-latest', null, { publicLogs: true });
  const gh = github(t, s, { dispatch: () => Response.json({ workflow_run_id: 123 }), visibility: 'public' });
  await direct.dispatch._handler(gh.ctx, s.id);
  // Accepted: no visibility read, no cache row, the workflow starts.
  assert.deepEqual(gh.calls, { dispatch: 1, list: 0, repository: 0 });
  assert.equal((await s.status(s.run.id)).executionId, '123');
  assert.equal(visibilityRows(s).length, 0);
  // The signed public visibility claim is accepted for this pinned runner too.
  const session = await s.call(
    sessions,
    'session',
    s.input({ claims: JSON.stringify(claims({ repository_visibility: 'public' })) }),
  );
  assert(session);
  const run = await s.status(s.run.id);
  assert.notEqual(run.status, 'runner-unavailable');
  assert.equal(run.configuration.publicLogs, true);
});

test('optional landing proof neither delays nor fails the required-job verdict', async () => {
  const { OPTIONAL_PROOF_JOB } = await import('../dist/hosted-check-verdict.js');
  const required = { name: 'Required tests', status: 'completed', conclusion: 'success' };
  for (const optional of [
    { name: OPTIONAL_PROOF_JOB, status: 'in_progress', conclusion: null },
    { name: OPTIONAL_PROOF_JOB, status: 'completed', conclusion: 'failure' },
  ])
    assert.equal(requiredJobsConclusion({ total_count: 2, jobs: [required, optional] }), 'success');
  assert.equal(
    requiredJobsConclusion({
      total_count: 2,
      jobs: [
        { ...required, status: 'in_progress' },
        { name: OPTIONAL_PROOF_JOB, status: 'completed', conclusion: 'success' },
      ],
    }),
    null,
  );
});

test('proof write ticket is scoped to the exact run and cannot reuse the read-only preflight ticket', async t => {
  const s = await fixture(t);
  const proof = await import(moduleUrl('../convex/projectLandingProof.ts'));
  const { landingProofSignature } = await import('../dist/hosted-actions-preflight.js');
  const row = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === s.run.id);
  s.patch('projectHostedCheckRuns', row._id, {
    value: JSON.stringify({ ...JSON.parse(row.value), proofOnLanding: true }),
  });
  await s.bind();
  await s.prepare();
  const run = await s.status(s.run.id);
  const input = {
    ...s.id,
    head: run.request.expectedHead,
    executionId: run.executionId,
    report: JSON.stringify({ kind: 'proof', reports: [{ file: 'tests/a.test.mjs', base: 'error' }] }),
  };
  await assert.rejects(
    s.transaction('proofBadTicket', proof.report, { ...input, ticket: 'a'.repeat(64) }),
    code('EVIDENCE_CHANGED'),
  );
  await assert.rejects(
    s.transaction('proofReadOnlyTicket', proof.report, {
      ...input,
      ticket: actionsPreflightSignature(run, 'synthetic-check-key'),
    }),
    code('EVIDENCE_CHANGED'),
  );
  const signature = landingProofSignature(run, 'synthetic-check-key');
  await s.transaction('proofExactTicket', proof.report, { ...input, ticket: signature });
  assert.equal(JSON.parse(s.tables.projectHostedCheckRuns.get(row._id).proof).reports[0].base, 'error');
  s.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify({ ...run, fence: run.fence + 1 }) });
  await assert.rejects(
    s.transaction('proofStaleTicket', proof.report, { ...input, ticket: signature }),
    code('EVIDENCE_CHANGED'),
  );
});
