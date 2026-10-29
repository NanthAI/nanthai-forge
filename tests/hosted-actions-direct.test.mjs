// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify, sign, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { verifyActionsOidc, validateActionsClaims, actionsIssuer } from '../dist/github-actions-oidc.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { checkPin } from '../dist/hosted-check.js';
import { savePin } from '../dist/hosted-save.js';
const { githubAppJwt, mintInstallationToken, actionsPermissions } = await import(
  moduleUrl('../convex/githubAppToken.ts')
);
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const sessions = await import(moduleUrl('../convex/projectHostedActionsSession.ts'));
const source = await import(moduleUrl('../convex/projectHostedActionsSource.ts'));
const plans = await import(moduleUrl('../convex/projectHostedActionsPlan.ts'));
const results = await import(moduleUrl('../convex/projectHostedActionsResults.ts'));
const webhooks = await import(moduleUrl('../convex/projectHostedActionsWebhook.ts'));
const { handle } = await import(moduleUrl('../convex/projectHostedActionsHttp.ts'));
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
  for (let i = 0; i < 2; i++)
    assert.equal(
      await mintInstallationToken(repository, request, Date.now(), actionsPermissions),
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
  };
  const send = result => s.call(results, 'result', { ...s.input(), result: JSON.stringify(result) });
  await send(first);
  assert.equal((await send(first)).counts.completed, 1);
  await assert.rejects(send({ ...first, exitCode: 1 }), code('WORK_OPERATION_CHANGED'));
  const terminal = await send({ index: 1, exitCode: 0 });
  assert.equal(terminal.status, 'passed');
  assert.equal(terminal.contractReports['tests/synthetic-0.test.mjs'].durationMs, 5);
  assert.equal((await send(first)).status, 'passed');
  assert.equal(s.cancelled.length, 1);
  const scheduled = s.scheduled.length;
  await s.call(direct, 'expire', { ...s.id, fence: terminal.fence });
  assert.equal(s.scheduled.length, scheduled);
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
  for (let index = 0; index < 9; index++) {
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
  // HTTP+transaction source: 2*ceil(N/400). Each job: output (2) + result (3).
  const budget = (n, jobs) => 2 * Math.ceil(n / 400) + jobs * 5 + 15;
  assert(budget(3000, 9) <= 80);
  assert(budget(6000, 9) <= 90);
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
