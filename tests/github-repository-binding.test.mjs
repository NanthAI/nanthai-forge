// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
const store = await import(moduleUrl('../convex/githubBindingStore.ts'));
const webhook = await import(moduleUrl('../convex/githubBindingWebhook.ts'));
const oauth = await import(moduleUrl('../convex/githubBindingOAuth.ts'));
const tokens = await import(moduleUrl('../convex/githubAppToken.ts'));
const definitions = await import(moduleUrl('../convex/projectHostedCheckDefinitions.ts'));
const policies = await import(moduleUrl('../convex/projectAutonomy.ts'));
const code = wanted => error => (error.data?.code ?? error.code) === wanted;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function variables(t, values) {
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
function fixture(t) {
  variables(t, {
    FORGE_GITHUB_REPO_BINDINGS: undefined,
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GITHUB_APP_CLIENT_ID: 'synthetic-client',
    GITHUB_APP_CLIENT_SECRET: 'synthetic-secret',
    CONVEX_SITE_URL: 'https://forge.example',
  });
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'Bound project',
    currentBackup: null,
    revision: 0,
    visibility: 'private',
    autonomyPolicy: policyPreset('supervised'),
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const call = (name, input, actor = 'owner') => s.call(name, store[name], { projectId, ...input }, actor);
  const invoke = async (ref, input) => {
    const [module, name] = getFunctionName(ref).split(':');
    const functions = { githubBindingStore: store, githubBindingWebhook: webhook }[module];
    assert(functions?.[name], `Unexpected function ${module}:${name}`);
    return s.call(name, functions[name], input);
  };
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runMutation: invoke,
    runQuery: invoke,
  };
  async function start({
    operationId = randomUUID(),
    state = randomUUID(),
    repository = 'synthetic/repo',
    installationId = 9,
  } = {}) {
    await call('start', {
      operationId,
      state,
      repository,
      installationId,
      verifier: 'synthetic-verifier',
      authorizeUrl: `https://github.com/login/oauth/authorize?state=${state}`,
    });
    return { state, operationId };
  }
  async function bind(repoId = 42, options = {}) {
    const op = await start(options);
    await s.call('consume', store.consume, { state: op.state });
    await s.call('complete', store.complete, {
      state: op.state,
      repoId,
      fullName: options.repository ?? 'synthetic/repo',
    });
    return op;
  }
  return { s, ctx, projectId, call, start, bind };
}
function github(t, { repoId = 42, name = 'synthetic/repo' } = {}) {
  const calls = [],
    scopes = new Map();
  let serial = 0;
  const request = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/installation'))
      return Response.json({ id: 9, permissions: { actions: 'write', contents: 'write' } });
    if (url.endsWith('/access_tokens')) {
      const scope = JSON.parse(init.body),
        token = `synthetic-installation-${++serial}`;
      scopes.set(token, scope);
      return Response.json({ token });
    }
    if (url.startsWith('https://api.github.com/repos/')) {
      const token = init.headers.Authorization.slice(7),
        scope = scopes.get(token);
      // Public repo metadata is visible even outside a token's repository scope;
      // the implementation must still check the returned numeric id.
      assert.deepEqual(scope.permissions, { metadata: 'read' });
      return Response.json({ id: repoId, full_name: name });
    }
    throw new Error('Unexpected synthetic GitHub request');
  };
  t.mock.method(globalThis, 'fetch', request);
  return { calls, request };
}
test('only the Forge owner starts a connection; original operation replays exactly', async t => {
  const f = fixture(t);
  const op = await f.start();
  const previous = [...f.s.tables.githubBindingOperations.values()][0];
  // Replay with start's own arguments: the stored operation also carries server-written fields.
  const args = {
    operationId: previous.operationId,
    repository: previous.repository,
    installationId: previous.installationId,
    state: previous.state,
    verifier: previous.verifier,
    authorizeUrl: previous.authorizeUrl,
  };
  const replay = JSON.parse(
    await f.call('start', {
      ...args,
      state: 'new-state',
      verifier: 'new-verifier',
      authorizeUrl: 'https://other.example',
    }),
  );
  assert.equal(replay.authorizeUrl, previous.authorizeUrl);
  await assert.rejects(
    f.call('start', { ...args, operationId: randomUUID() }, 'stranger'),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    f.call('start', { ...args, repository: 'other/repo' }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert(op.operationId);
});
test('admin or maintain and user installation membership are both required', async () => {
  for (const permissions of [{}, { push: true }, { admin: false, maintain: false }]) {
    let calls = 0;
    await assert.rejects(
      oauth.proveRepository('synthetic-user-token', 9, 'synthetic/repo', async () => {
        calls++;
        return Response.json({ id: 42, full_name: 'synthetic/repo', permissions });
      }),
      code('GITHUB_REPOSITORY_PERMISSION'),
    );
    assert.equal(calls, 1);
  }
  for (const permissions of [{ admin: true }, { maintain: true }]) {
    let calls = 0;
    const result = await oauth.proveRepository('synthetic-user-token', 9, 'synthetic/repo', async url => {
      calls++;
      return Response.json(
        url.includes('/user/installations/')
          ? { repositories: [{ id: 42 }] }
          : { id: 42, full_name: 'synthetic/repo', permissions },
      );
    });
    assert.equal(result.repoId, 42);
    assert.equal(calls, 2);
  }
  await assert.rejects(
    oauth.proveRepository('synthetic-user-token', 9, 'synthetic/repo', async url =>
      Response.json(
        url.includes('/user/installations/')
          ? { repositories: [] }
          : { id: 42, full_name: 'synthetic/repo', permissions: { admin: true } },
      ),
    ),
    code('GITHUB_REPOSITORY_PERMISSION'),
  );
});
test('forged and replayed state cannot create bindings', async t => {
  const f = fixture(t),
    op = await f.start();
  await assert.rejects(f.s.call('consume', store.consume, { state: 'forged' }), code('GITHUB_OAUTH_STATE'));
  await f.s.call('consume', store.consume, { state: op.state });
  await assert.rejects(f.s.call('consume', store.consume, { state: op.state }), code('GITHUB_OAUTH_STATE'));
  await f.s.call('complete', store.complete, { state: op.state, repoId: 42, fullName: 'synthetic/repo' });
  await assert.rejects(
    f.s.call('complete', store.complete, { state: op.state, repoId: 42, fullName: 'synthetic/repo' }),
    code('GITHUB_OAUTH_STATE'),
  );
});
test('callback verifies PKCE and proof, persists no user token, rejects replay and sanitizes failures', async t => {
  const f = fixture(t);
  const op = await f.start();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init.body);
      assert.equal(body.code_verifier, 'synthetic-verifier');
      assert.equal(body.redirect_uri, 'https://forge.example/github/oauth/callback');
      return Response.json({ access_token: 'synthetic-user-token-never-store', token_type: 'bearer' });
    }
    assert.equal(init.headers.Authorization, 'Bearer synthetic-user-token-never-store');
    return Response.json(
      url.includes('/user/installations/')
        ? { repositories: [{ id: 42 }] }
        : { id: 42, full_name: 'synthetic/repo', permissions: { admin: true } },
    );
  });
  const request = new Request(
    `https://forge.example/github/oauth/callback?state=${op.state}&code=synthetic-code`,
  );
  const result = await oauth.callback._handler(f.ctx, request);
  assert.equal(result.status, 200);
  assert.equal(calls.length, 3);
  assert(
    !JSON.stringify([...Object.values(f.s.tables).flatMap(table => [...table.values()])]).includes(
      'synthetic-user-token-never-store',
    ),
  );
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await oauth.callback._handler(f.ctx, request)).status, 400);
  assert.equal(calls.length, 3);
  const failed = await f.start();
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('synthetic-user-token-never-store', { status: 401 }),
  );
  const denial = await oauth.callback._handler(
    f.ctx,
    new Request(`https://forge.example/github/oauth/callback?state=${failed.state}&code=synthetic-code`),
  );
  assert.equal(denial.status, 400);
  assert(!(await denial.text()).includes('synthetic-user-token-never-store'));
  assert.equal(JSON.parse(await f.call('status', { operationId: failed.operationId })).status, 'failed');
});
test('authorize URL uses server callback, random state and SHA256 PKCE', async t => {
  const f = fixture(t);
  github(t);
  const input = { projectId: f.projectId, operationId: randomUUID(), repository: 'synthetic/repo' };
  const started = JSON.parse(await oauth.connect._handler(f.ctx, input));
  const url = new URL(started.authorizeUrl),
    op = [...f.s.tables.githubBindingOperations.values()][0];
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://forge.example/github/oauth/callback');
  assert.equal(url.searchParams.get('state'), op.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    (await import('node:crypto')).createHash('sha256').update(op.verifier).digest('base64url'),
  );
  assert(!started.authorizeUrl.includes('synthetic-secret'));
  assert.deepEqual(JSON.parse(await oauth.connect._handler(f.ctx, input)), started);
});
test('binding survives rename by id; recreated/public repository and other projects are refused', async t => {
  const f = fixture(t);
  await f.bind();
  const provider = github(t, { name: 'synthetic/renamed' });
  await tokens.installationToken(f.ctx, f.projectId, 'synthetic/renamed', tokens.actionsPermissions);
  assert.deepEqual(provider.calls.filter(c => c.method === 'POST').at(-1).body, {
    repository_ids: [42],
    permissions: tokens.actionsPermissions,
  });
  assert.equal([...f.s.tables.projectGithubBindings.values()][0].fullName, 'synthetic/renamed');
  const recreated = github(t, { repoId: 43 });
  await assert.rejects(
    tokens.installationToken(f.ctx, f.projectId, 'synthetic/repo', tokens.actionsPermissions),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  assert(recreated.calls.filter(c => c.method === 'POST').every(c => c.body.permissions.metadata === 'read'));
  const other = f.s.insert('hostedProjects', {
    owner: 'other',
    key: randomUUID(),
    name: 'Other project',
    currentBackup: null,
    revision: 0,
  });
  await assert.rejects(
    tokens.installationToken(f.ctx, other, 'synthetic/repo'),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
});
test('one repo id has one project even with concurrent claims', async t => {
  const f = fixture(t),
    a = await f.start();
  const other = f.s.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'Other project',
    currentBackup: null,
    revision: 0,
  });
  const state = randomUUID();
  await f.s.call('start', store.start, {
    projectId: other,
    operationId: randomUUID(),
    repository: 'synthetic/repo',
    installationId: 9,
    state,
    verifier: 'v',
    authorizeUrl: 'https://github.com',
  });
  for (const value of [a.state, state]) await f.s.call('consume', store.consume, { state: value });
  const results = await Promise.allSettled(
    [a.state, state].map(value =>
      f.s.call('complete', store.complete, { state: value, repoId: 42, fullName: 'synthetic/repo' }),
    ),
  );
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert(code('GITHUB_REPOSITORY_CLAIMED')(results.find(r => r.status === 'rejected').reason));
});
test('removal and uninstall invalidate bindings and in-flight proof; duplicate webhook is inert', async t => {
  const f = fixture(t);
  await f.bind();
  const op = await f.start();
  await f.s.call('consume', store.consume, { state: op.state });
  const input = { delivery: 'synthetic-delivery:0', installationId: 9, removed: false, repoIds: [42] };
  await f.s.call('invalidate', webhook.invalidate, input);
  assert.equal(f.s.tables.projectGithubBindings.size, 0);
  const revision = [...f.s.tables.githubBindingInstallations.values()][0].revision;
  await f.s.call('invalidate', webhook.invalidate, input);
  assert.equal([...f.s.tables.githubBindingInstallations.values()][0].revision, revision);
  await assert.rejects(
    f.s.call('complete', store.complete, { state: op.state, repoId: 42, fullName: 'synthetic/repo' }),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  await f.bind();
  await f.s.call('invalidate', webhook.invalidate, {
    ...input,
    delivery: 'uninstall:0',
    removed: true,
    repoIds: [],
  });
  github(t);
  await assert.rejects(
    tokens.installationToken(f.ctx, f.projectId, 'synthetic/repo'),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  assert.equal(JSON.parse(await f.call('list', { cursor: null })).page[0].active, false);
});
test('owner removal replays without deleting a newer binding and rejects another actor', async t => {
  const f = fixture(t);
  await f.bind();
  const operationId = randomUUID();
  await assert.rejects(
    f.call('remove', { operationId, repoId: 42 }, 'stranger'),
    code('PROJECT_UNAVAILABLE'),
  );
  await f.call('remove', { operationId, repoId: 42 });
  await f.bind();
  await f.call('remove', { operationId, repoId: 42 });
  assert.equal(f.s.tables.projectGithubBindings.size, 1);
});
test('operator override works without OAuth; unbound mint never creates a token', async t => {
  const f = fixture(t),
    provider = github(t);
  await assert.rejects(
    tokens.installationToken(f.ctx, f.projectId, 'synthetic/repo'),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  assert.equal(provider.calls.filter(c => c.method === 'POST').length, 0);
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${f.projectId}=synthetic/repo`;
  await tokens.installationToken(f.ctx, f.projectId, 'synthetic/repo');
  assert.deepEqual(provider.calls.at(-1).body, { repositories: ['repo'] });
});
test('policy and direct runner-setting mutation refuse unbound names', async t => {
  const f = fixture(t);
  const command = {
    action: 'set-policy',
    operationId: randomUUID(),
    githubMirror: { repo: 'synthetic/repo', autoPush: true, laneRefs: false },
  };
  await assert.rejects(
    f.s.call('policy', policies.set, { projectId: f.projectId, command: JSON.stringify(command) }),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  const configuration = {
    provider: 'github-actions',
    repository: 'synthetic/repo',
    runsOn: 'ubuntu-latest',
    runtime: 'b'.repeat(64),
    environmentFingerprint: 'a'.repeat(64),
  };
  const request = JSON.stringify({
    operationId: randomUUID(),
    authorityEpoch: 1,
    expected: null,
    change: { kind: 'runner', configuration },
  });
  await assert.rejects(
    f.s.call('configure', definitions.configure, { projectId: f.projectId, request }),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  await f.bind();
  await f.s.call('policy', policies.set, { projectId: f.projectId, command: JSON.stringify(command) });
  await f.s.call('configure', definitions.configure, { projectId: f.projectId, request });
  const current = JSON.parse(
    await f.s.call('current', definitions.current, {
      projectId: f.projectId,
      checkId: '',
      includeGithubBindings: true,
    }),
  );
  assert.equal(current.githubBindings.page[0].repoId, 42);
});
test('dogfood fixture: 600 bindings use six 100-row pages, zero idle work and bounded metadata scopes', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 600; i++)
    f.s.insert('projectGithubBindings', {
      projectId: f.projectId,
      repoId: i,
      fullName: `synthetic/repo-${i}`,
      installationId: 9,
      boundBy: 'owner',
      boundAt: 1,
    });
  // Unrelated rows only prove the binding path never scans them, so they bypass document validation.
  for (let i = 0; i < 32000; i++)
    f.s.tables.projectWorkRecords.set(`projectWorkRecords-noise-${i}`, {
      _id: `projectWorkRecords-noise-${i}`,
      _creationTime: i,
      projectId: f.projectId,
      key: `unrelated-${i}`,
      value: 'synthetic',
    });
  const provider = github(t, { repoId: 600, name: 'synthetic/renamed' });
  const started = performance.now(),
    memory = process.memoryUsage().heapUsed;
  let maxBindingPageBytes = 0;
  const ctx = {
    ...f.ctx,
    runQuery: async (ref, input) => {
      const value = await f.ctx.runQuery(ref, input);
      if (getFunctionName(ref).endsWith(':page'))
        maxBindingPageBytes = Math.max(maxBindingPageBytes, Buffer.byteLength(value));
      return value;
    },
  };
  await tokens.installationToken(ctx, f.projectId, 'synthetic/renamed');
  assert(maxBindingPageBytes < 64 * 1024);
  const reads = f.s.counts.reduce((n, row) => n + row.documents, 0),
    writes = f.s.counts.reduce((n, row) => n + row.writes, 0);
  assert.equal(f.s.counts.filter(row => row.name === 'page').length, 6);
  assert.equal(f.s.counts.length, 8);
  assert(reads <= 620);
  assert.equal(writes, 1);
  assert(f.s.counts.every(row => !row.touched.includes('projectWorkRecords')));
  const probes = provider.calls.filter(c => c.method === 'POST' && c.body.permissions?.metadata === 'read');
  assert.equal(probes.length, 6);
  assert(probes.every(c => c.body.repository_ids.length <= 100));
  const calls = provider.calls.length;
  await Promise.resolve();
  assert.equal(provider.calls.length, calls); // No scheduler/poller is started.
  t.diagnostic(
    JSON.stringify({
      functionCalls: f.s.counts.length,
      documentsRead: reads,
      documentsWritten: writes,
      githubCalls: calls,
      maxScopeIds: 100,
      elapsedMs: Math.round(performance.now() - started),
      maxBindingPageBytes,
      harnessHeapDeltaBytes: process.memoryUsage().heapUsed - memory,
    }),
  );
});
test('mirror, dispatch, cancellation and configure all refuse without a binding before GitHub writes', async t => {
  const f = fixture(t),
    provider = github(t);
  const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
  const actionsWebhook = await import(moduleUrl('../convex/projectHostedActionsWebhook.ts'));
  const mirror = await import(moduleUrl('../convex/projectGithubMirror.ts'));
  const configure = await import(moduleUrl('../convex/projectHostedActionsConfigure.ts'));
  const identity = { projectId: f.projectId, runId: randomUUID() };
  const run = {
    configuration: { provider: 'github-actions', repository: 'synthetic/repo' },
    fence: 1,
    executionId: '123',
  };
  const observed = [];
  const ctx = {
    ...f.ctx,
    runMutation: async (ref, input) => {
      const name = getFunctionName(ref);
      if (name.endsWith(':reserve') || name.endsWith(':cancellation')) return run;
      if (name.endsWith(':observe') || name.endsWith(':failed')) {
        observed.push(input);
        return null;
      }
      if (name.endsWith(':begin'))
        return JSON.stringify({ projectId: f.projectId, repository: 'synthetic/repo' });
      throw new Error('Unexpected mutation before binding proof');
    },
  };
  await direct.dispatch._handler(ctx, identity);
  assert.equal(observed.at(-1).outcome, 'rejected');
  await assert.rejects(actionsWebhook.cancel._handler(ctx, identity), code('GITHUB_REPOSITORY_UNBOUND'));
  await mirror.step._handler(ctx, { jobId: 'synthetic-job', step: 0 });
  assert.equal(observed.at(-1).code, 'GITHUB_REPOSITORY_UNBOUND');
  await assert.rejects(
    configure.configure._handler(ctx, {
      projectId: f.projectId,
      request: JSON.stringify({
        operationId: randomUUID(),
        authorityEpoch: 1,
        expected: null,
        repository: 'synthetic/repo',
      }),
    }),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  assert.equal(provider.calls.filter(c => c.method !== 'GET').length, 0);
});
test('signed HTTP removal webhook pages ids and rejects forged signatures before touching bindings', async t => {
  const f = fixture(t);
  await f.bind();
  variables(t, { GITHUB_WEBHOOK_SECRET: 'synthetic-webhook-secret' });
  const http = (await import(moduleUrl('../convex/http.ts'))).default;
  assert(http.getRoutes().some(([path, method]) => path === '/github/oauth/callback' && method === 'GET'));
  const route = http.getRoutes().find(([path]) => path === '/github/webhook')[2];
  const payload = JSON.stringify({
    action: 'removed',
    installation: { id: 9 },
    repositories_removed: Array.from({ length: 201 }, (_, i) => ({ id: i + 1 })),
  });
  const signature = `sha256=${(await import('node:crypto')).createHmac('sha256', 'synthetic-webhook-secret').update(payload).digest('hex')}`;
  const mutations = [];
  const ctx = {
    runMutation: async (ref, input) => {
      const name = getFunctionName(ref);
      mutations.push(name);
      if (name === 'githubBindingWebhook:invalidate')
        return f.s.call('invalidate', webhook.invalidate, input);
      assert.equal(name, 'sync:receive');
      return null;
    },
  };
  const send = signature =>
    route._handler(
      ctx,
      new Request('https://forge.example/github/webhook', {
        method: 'POST',
        body: payload,
        headers: {
          'x-github-event': 'installation_repositories',
          'x-github-delivery': 'synthetic-signed',
          'x-hub-signature-256': signature,
        },
      }),
    );
  assert.equal((await send('sha256=forged')).status, 401);
  assert.equal(mutations.length, 0);
  assert.equal((await send(signature)).status, 204);
  assert.equal(mutations.filter(name => name === 'githubBindingWebhook:invalidate').length, 3);
  assert.equal(f.s.tables.projectGithubBindings.size, 0);
});
test('revocation while minting prevents token return; owner change also fences OAuth proof', async t => {
  const f = fixture(t);
  await f.bind();
  const op = await f.start();
  await f.s.call('consume', store.consume, { state: op.state });
  await f.call('remove', { repoId: 42, operationId: randomUUID() });
  await assert.rejects(
    f.s.call('complete', store.complete, { state: op.state, repoId: 42, fullName: 'synthetic/repo' }),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  await f.bind();
  const provider = github(t);
  const request = async (url, init) => {
    const result = await provider.request(url, init);
    if (url.endsWith('/access_tokens') && JSON.parse(init.body).permissions?.actions === 'write')
      await f.call('remove', { repoId: 42, operationId: randomUUID() });
    return result;
  };
  await assert.rejects(
    tokens.installationToken(f.ctx, f.projectId, 'synthetic/repo', tokens.actionsPermissions, request),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  const changed = await f.start();
  await f.s.call('consume', store.consume, { state: changed.state });
  f.s.patch('hostedProjects', f.projectId, { owner: 'other' });
  await assert.rejects(
    f.s.call('complete', store.complete, { state: changed.state, repoId: 42, fullName: 'synthetic/repo' }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('disabling a revoked mirror and unrelated policy edits remain available', async t => {
  const f = fixture(t);
  f.s.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policyPreset('supervised'),
      githubMirror: { repo: 'synthetic/repo', autoPush: true, laneRefs: false },
    },
  });
  for (const change of [
    { acceptance: { mode: 'auto-on-pass' } },
    { githubMirror: { repo: 'synthetic/repo', autoPush: false, laneRefs: false } },
  ]) {
    await f.s.call('policy', policies.set, {
      projectId: f.projectId,
      command: JSON.stringify({ action: 'set-policy', operationId: randomUUID(), ...change }),
    });
  }
});

test('ordinary check selection does not read repository binding pages', async t => {
  const f = fixture(t);
  await f.bind();
  const current = JSON.parse(
    await f.s.call('current', definitions.current, { projectId: f.projectId, checkId: '' }),
  );
  assert.equal(current.githubBindings, null);
  assert(!f.s.counts.at(-1).touched.includes('projectGithubBindings'));
});
