// SPDX-License-Identifier: Apache-2.0
import { setWorkRecord } from './hosted-fixture.mjs';
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
const grants = await import(moduleUrl('../convex/githubRunnerGrants.ts'));
const access = await import(moduleUrl('../convex/githubBindingAccess.ts'));
const visibility = await import(moduleUrl('../convex/githubRepositoryVisibility.ts'));
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
    CLERK_SECRET_KEY: 'synthetic-identity-secret',
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
    const functions = {
      githubBindingStore: store,
      githubBindingWebhook: webhook,
      githubRunnerGrants: grants,
      githubRepositoryVisibility: visibility,
      projectHostedCheckDefinitions: definitions,
    }[module];
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
    githubAccounts = [linkedAccount],
    mirror,
  } = {}) {
    await call('start', {
      ...(mirror === undefined ? {} : { mirror }),
      operationId,
      state,
      repository,
      githubAccounts,
      verifier: 'synthetic-verifier',
      authorizeUrl: `https://github.com/login/oauth/authorize?state=${state}`,
    });
    return { state, operationId };
  }
  async function bind(repoId = 42, options = {}) {
    const op = await start(options);
    await proving(op.state, options.installationId);
    await s.call('complete', store.complete, {
      state: op.state,
      repoId,
      fullName: options.repository ?? 'synthetic/repo',
    });
    return op;
  }
  /** Callback order: consume the state, then pin the installation after access proof. */
  async function proving(state, installationId = 9) {
    await s.call('consume', store.consume, { state });
    await s.call('pin', store.pin, { state, installationId });
  }
  return { s, ctx, projectId, call, start, bind, proving };
}
const linkedAccount = '1001';
const identity = (id = 'owner', accounts = [linkedAccount]) =>
  Response.json({
    id,
    external_accounts: accounts.map(provider_user_id => ({
      provider: 'oauth_github',
      provider_user_id,
      verification: { status: 'verified' },
    })),
  });
function github(
  t,
  { repoId = 42, name = 'synthetic/repo', role = null, roleUser = Number(linkedAccount) } = {},
) {
  const calls = [],
    scopes = new Map();
  let serial = 0;
  const request = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.startsWith('https://api.clerk.com/v1/users/')) return identity();
    if (url.endsWith('/installation'))
      return Response.json({ id: 9, permissions: { actions: 'write', contents: 'write' } });
    if (url.endsWith('/access_tokens')) {
      const scope = JSON.parse(init.body),
        token = `synthetic-installation-${++serial}`;
      scopes.set(token, scope);
      return Response.json({ token });
    }
    // Runner-grant proof: the linked account's login by numeric id, then its role.
    if (url === `https://api.github.com/user/${linkedAccount}`) {
      assert.deepEqual(
        scopes.get((init.headers.Authorization ?? init.headers.authorization).slice(7)).permissions,
        { metadata: 'read' },
      );
      return Response.json({ id: Number(linkedAccount), login: 'synthetic-owner' });
    }
    if (url.includes('/collaborators/')) {
      assert.deepEqual(
        scopes.get((init.headers.Authorization ?? init.headers.authorization).slice(7)).permissions,
        { metadata: 'read' },
      );
      assert(url.endsWith(`/repos/${name}/collaborators/synthetic-owner/permission`));
      return Response.json({
        permission: role === 'admin' ? 'admin' : 'write',
        role_name: role,
        user: { id: roleUser },
      });
    }
    if (url.startsWith('https://api.github.com/repos/')) {
      const token = (init.headers.Authorization ?? init.headers.authorization).slice(7),
        scope = scopes.get(token);
      // Public repo metadata is visible even outside a token's repository scope;
      // the implementation must still check the returned numeric id.
      assert.deepEqual(scope.permissions, { metadata: 'read' });
      return Response.json({ id: repoId, full_name: name, private: true, visibility: 'private' });
    }
    throw new Error('Unexpected synthetic GitHub request');
  };
  t.mock.method(globalThis, 'fetch', request);
  return { calls, request };
}
/** Incident d4eb053e: connect used to leave the mirror off and a second owner approval turned it on. */
async function connectWithMirror(f, mirror, repoId = 42) {
  const op = await f.start({ mirror, repository: 'synthetic/repo' });
  await f.proving(op.state);
  const result = await f.s.call('complete', store.complete, {
    state: op.state,
    repoId,
    fullName: 'Synthetic/Repo',
  });
  return { op, result, project: f.s.tables.hostedProjects.get(f.projectId) };
}
test('the owner approval of a connect also turns the mirror on, both ways, and the status says so', async t => {
  const f = fixture(t);
  const { op, result, project } = await connectWithMirror(f, true);
  assert.equal(result, 'enabled');
  assert.deepEqual(project.autonomyPolicy.githubMirror, {
    repo: 'Synthetic/Repo',
    autoPush: true,
    laneRefs: false,
    inbound: true,
  });
  assert.equal(f.s.tables.projectGithubMirrors.size, 1, 'the queue row exists before any landing');
  assert.deepEqual(
    [...f.s.tables.projectPolicyChanges.values()].map(row => row.rule),
    ['owner-approved'],
  );
  assert.equal(JSON.parse(await f.call('status', { operationId: op.operationId })).mirror, 'enabled');
});
test('connecting without the mirror request, or with a mirror already on, leaves the policy alone', async t => {
  const plain = fixture(t);
  assert.equal((await connectWithMirror(plain, undefined)).result, null);
  assert.equal(plain.s.tables.hostedProjects.get(plain.projectId).autonomyPolicy.githubMirror, undefined);
  const other = fixture(t);
  const existing = { repo: 'elsewhere/repo', autoPush: true, laneRefs: false };
  other.s.patch('hostedProjects', other.projectId, {
    autonomyPolicy: { ...policyPreset('supervised'), githubMirror: existing },
  });
  const { result, project } = await connectWithMirror(other, true);
  assert.equal(result, 'kept');
  assert.deepEqual(project.autonomyPolicy.githubMirror, existing);
  assert.equal(other.s.tables.projectPolicyChanges.size, 0);
});
test('a stranger cannot start a connect that turns the mirror on', async t => {
  const f = fixture(t);
  await assert.rejects(
    f.s.call(
      'start',
      store.start,
      {
        projectId: f.projectId,
        mirror: true,
        operationId: randomUUID(),
        state: randomUUID(),
        repository: 'synthetic/repo',
        githubAccounts: [linkedAccount],
        verifier: 'synthetic-verifier',
        authorizeUrl: 'https://github.com/login/oauth/authorize',
      },
      'stranger',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal(f.s.tables.githubBindingOperations.size, 0);
  assert.equal(f.s.tables.hostedProjects.get(f.projectId).autonomyPolicy.githubMirror, undefined);
});
test('only the Forge owner starts a connection; original operation replays exactly', async t => {
  const f = fixture(t);
  const op = await f.start();
  const previous = [...f.s.tables.githubBindingOperations.values()][0];
  // Replay with start's own arguments: the stored operation also carries server-written fields.
  const args = {
    operationId: previous.operationId,
    repository: previous.repository,
    githubAccounts: previous.githubAccounts,
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
  const user = { id: Number(linkedAccount) };
  const pinned = () => async () => 9;
  for (const permissions of [{}, { push: true }, { admin: false, maintain: false }]) {
    let calls = 0;
    await assert.rejects(
      oauth.proveRepository(
        'synthetic-user-token',
        'synthetic/repo',
        [linkedAccount],
        pinned(),
        async url => {
          calls++;
          return Response.json(
            url.endsWith('/user') ? user : { id: 42, full_name: 'synthetic/repo', permissions },
          );
        },
      ),
      code('GITHUB_REPOSITORY_PERMISSION'),
    );
    assert.equal(calls, 2);
  }
  for (const permissions of [{ admin: true }, { maintain: true }]) {
    let calls = 0;
    const result = await oauth.proveRepository(
      'synthetic-user-token',
      'synthetic/repo',
      [linkedAccount],
      pinned(),
      async url => {
        calls++;
        return Response.json(
          url.endsWith('/user')
            ? user
            : url.includes('/user/installations/')
              ? { repositories: [{ id: 42 }] }
              : { id: 42, full_name: 'synthetic/repo', permissions },
        );
      },
    );
    assert.equal(result.repoId, 42);
    // Only Admin can import the two-way ruleset; status names who must do it.
    assert.equal(result.role, permissions.admin ? 'admin' : 'maintain');
    assert.equal(calls, 3);
  }
  await assert.rejects(
    oauth.proveRepository('synthetic-user-token', 'synthetic/repo', [linkedAccount], pinned(), async url =>
      Response.json(
        url.endsWith('/user')
          ? user
          : url.includes('/user/installations/')
            ? { repositories: [] }
            : { id: 42, full_name: 'synthetic/repo', permissions: { admin: true } },
      ),
    ),
    code('GITHUB_REPOSITORY_PERMISSION'),
  );
});
test('proof refuses a GitHub account not linked to the starting Forge account before any repository read', async () => {
  const calls = [];
  let pinned = false;
  await assert.rejects(
    oauth.proveRepository(
      'synthetic-user-token',
      'synthetic/repo',
      [linkedAccount],
      async () => {
        pinned = true;
        return 9;
      },
      async url => {
        calls.push(url);
        return Response.json(
          url.endsWith('/user')
            ? { id: 2002 }
            : { id: 42, full_name: 'synthetic/repo', permissions: { admin: true } },
        );
      },
    ),
    code('GITHUB_ACCOUNT_MISMATCH'),
  );
  assert.deepEqual(calls, ['https://api.github.com/user']);
  assert.equal(pinned, false);
});
test('forged and replayed state cannot create bindings', async t => {
  const f = fixture(t),
    op = await f.start();
  await assert.rejects(f.s.call('consume', store.consume, { state: 'forged' }), code('GITHUB_OAUTH_STATE'));
  await f.s.call('consume', store.consume, { state: op.state });
  await assert.rejects(f.s.call('consume', store.consume, { state: op.state }), code('GITHUB_OAUTH_STATE'));
  await assert.rejects(
    f.s.call('complete', store.complete, { state: op.state, repoId: 42, fullName: 'synthetic/repo' }),
    code('GITHUB_OAUTH_STATE'),
    'An unpinned operation cannot complete.',
  );
  await f.s.call('pin', store.pin, { state: op.state, installationId: 9 });
  await assert.rejects(
    f.s.call('pin', store.pin, { state: op.state, installationId: 10 }),
    code('GITHUB_OAUTH_STATE'),
  );
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
    // The App lookup runs only after the user's repository access is proven.
    if (url.endsWith('/repos/synthetic/repo/installation')) {
      assert.equal(calls.at(-2), 'https://api.github.com/repos/synthetic/repo');
      return Response.json({ id: 9 });
    }
    assert.equal(init.headers.Authorization, 'Bearer synthetic-user-token-never-store');
    return Response.json(
      url.endsWith('/user')
        ? { id: Number(linkedAccount) }
        : url.includes('/user/installations/')
          ? { repositories: [{ id: 42 }] }
          : { id: 42, full_name: 'synthetic/repo', permissions: { admin: true } },
    );
  });
  const request = new Request(
    `https://forge.example/github/oauth/callback?state=${op.state}&code=synthetic-code`,
  );
  const result = await oauth.callback._handler(f.ctx, request);
  assert.equal(result.status, 200);
  assert.equal(calls.length, 5);
  assert.equal([...f.s.tables.projectGithubBindings.values()][0].installationId, 9);
  assert(
    !JSON.stringify([...Object.values(f.s.tables).flatMap(table => [...table.values()])]).includes(
      'synthetic-user-token-never-store',
    ),
  );
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await oauth.callback._handler(f.ctx, request)).status, 400);
  assert.equal(calls.length, 5);
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
  const provider = github(t);
  const input = { projectId: f.projectId, operationId: randomUUID(), repository: 'synthetic/repo' };
  const started = JSON.parse(await oauth.connect._handler(f.ctx, input));
  assert.deepEqual(
    provider.calls.map(call => call.url),
    ['https://api.clerk.com/v1/users/owner'],
    'Connect reads only the caller identity; no repository or App lookup.',
  );
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
  assert.equal(provider.calls.length, 1, 'A replayed connect makes no external call.');
});
test('binding by a different GitHub account than the starter is refused and writes no binding', async t => {
  const f = fixture(t);
  const op = await f.start();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url === 'https://github.com/login/oauth/access_token')
      return Response.json({ access_token: 'synthetic-other-user-token', token_type: 'bearer' });
    if (url.endsWith('/user')) return Response.json({ id: 2002 });
    return Response.json({ id: 42, full_name: 'synthetic/repo', permissions: { admin: true } });
  });
  const response = await oauth.callback._handler(
    f.ctx,
    new Request(`https://forge.example/github/oauth/callback?state=${op.state}&code=synthetic-code`),
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /GITHUB_ACCOUNT_MISMATCH/);
  assert.deepEqual(calls, ['https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
  assert.equal(f.s.tables.projectGithubBindings.size, 0);
  const status = JSON.parse(await f.call('status', { operationId: op.operationId }));
  assert.deepEqual([status.status, status.code], ['failed', 'GITHUB_ACCOUNT_MISMATCH']);
  assert.equal([...f.s.tables.githubBindingOperations.values()][0].installationId, undefined);
});
test('connect gives the same answer for unknown, uninstalled and installed repositories', async t => {
  const f = fixture(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url.startsWith('https://api.clerk.com/v1/users/')) return identity();
    return new Response('not found', { status: 404 });
  });
  const shapes = [];
  for (const repository of ['synthetic/repo', 'synthetic/unknown', 'other-owner/private-repo']) {
    const started = JSON.parse(
      await oauth.connect._handler(f.ctx, { projectId: f.projectId, operationId: randomUUID(), repository }),
    );
    shapes.push([
      Object.keys(started).sort().join(','),
      started.status,
      new URL(started.authorizeUrl).origin,
    ]);
  }
  assert.equal(new Set(shapes.map(shape => JSON.stringify(shape))).size, 1);
  assert(
    calls.every(url => url.startsWith('https://api.clerk.com/')),
    'No GitHub call before user proof.',
  );
  assert(
    [...f.s.tables.githubBindingOperations.values()].every(op => op.installationId === undefined),
    'No installation state is stored before the callback proof.',
  );
});
test('connect requires a verified GitHub account linked to the Forge account', async t => {
  const f = fixture(t);
  for (const person of [
    { id: 'owner', external_accounts: [] },
    {
      id: 'owner',
      external_accounts: [
        { provider: 'oauth_github', provider_user_id: '1001', verification: { status: 'unverified' } },
      ],
    },
    { id: 'someone-else', external_accounts: [] },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(person));
    await assert.rejects(
      oauth.connect._handler(f.ctx, {
        projectId: f.projectId,
        operationId: randomUUID(),
        repository: 'synthetic/repo',
      }),
      error => code('GITHUB_ACCOUNT_REQUIRED')(error) || code('GITHUB_RESPONSE')(error),
    );
  }
  assert.equal(f.s.tables.githubBindingOperations?.size ?? 0, 0);
});
test('a connection operation started before account binding fails closed at the callback', async t => {
  const f = fixture(t);
  const state = randomUUID();
  f.s.insert('githubBindingOperations', {
    projectId: f.projectId,
    operationId: randomUUID(),
    actor: 'owner',
    repository: 'synthetic/repo',
    installationId: 9,
    state,
    verifier: 'synthetic-verifier',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    status: 'waiting',
  });
  await assert.rejects(f.s.call('consume', store.consume, { state }), code('GITHUB_OAUTH_STATE'));
  assert.equal(f.s.tables.projectGithubBindings.size, 0);
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
    tokens.installationToken(f.ctx, other, 'synthetic/repo', tokens.mirrorPermissions),
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
    githubAccounts: [linkedAccount],
    state,
    verifier: 'v',
    authorizeUrl: 'https://github.com',
  });
  for (const value of [a.state, state]) await f.proving(value);
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
  await f.proving(op.state);
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
    tokens.installationToken(f.ctx, f.projectId, 'synthetic/repo', tokens.mirrorPermissions),
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
    tokens.installationToken(f.ctx, f.projectId, 'synthetic/repo', tokens.mirrorPermissions),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  assert.equal(provider.calls.filter(c => c.method === 'POST').length, 0);
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${f.projectId}=synthetic/repo`;
  await tokens.installationToken(f.ctx, f.projectId, 'synthetic/repo', tokens.mirrorPermissions);
  assert.deepEqual(provider.calls.at(-1).body, {
    repositories: ['repo'],
    permissions: { contents: 'write' },
  });
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
    setWorkRecord(f.s.tables, `projectWorkRecords-noise-${i}`, {
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
  await tokens.installationToken(ctx, f.projectId, 'synthetic/renamed', tokens.mirrorPermissions);
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
      if (name.endsWith(':reserve') || name.endsWith(':cancellation')) return JSON.stringify(run);
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
    // No operator or stored binding: configure tries the runner-grant proof, which needs admin.
    code('GITHUB_REPOSITORY_PERMISSION'),
  );
  // The only write-method call is the proof's metadata-read token; nothing is dispatched or pushed.
  assert.deepEqual(
    provider.calls.filter(c => c.method !== 'GET').map(c => c.body.permissions),
    [{ metadata: 'read' }],
  );
  assert.equal(f.s.tables.githubRunnerGrants.size, 0);
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
  await f.proving(op.state);
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
  await f.proving(changed.state);
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

// Issue 77fa4412: configure-runner proves the owner's admin/maintain through the App and
// records one runner grant for the owner's projects, with no browser step or operator setting.
async function configureRunner(f, projectId = f.projectId, ctx = f.ctx) {
  const configure = await import(moduleUrl('../convex/projectHostedActionsConfigure.ts'));
  return configure.configure._handler(ctx, {
    projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      expected: null,
      repository: 'synthetic/repo',
    }),
  });
}
const scopeOf = (f, projectId) =>
  f.s.call(
    'scope',
    { isQuery: true, _handler: ctx => access.runnerTokenScope(ctx, projectId, 'synthetic/repo') },
    {},
  );
function copyProject(f, extra = {}) {
  const { _id, _creationTime, ...row } = f.s.tables.hostedProjects.get(f.projectId);
  return f.s.insert('hostedProjects', { ...row, key: randomUUID(), ...extra });
}
test('configure-runner records an owner runner grant that covers the owner’s next project only', async t => {
  const f = fixture(t),
    provider = github(t, { role: 'maintain' });
  await configureRunner(f);
  const [grant] = [...f.s.tables.githubRunnerGrants.values()];
  assert.equal(grant.owner, 'owner');
  assert.equal(grant.repoId, 42);
  assert.equal(grant.installationId, 9);
  assert.equal(grant.githubAccount, linkedAccount);
  // Only metadata-read tokens were minted; the runner setting is stored.
  assert(provider.calls.filter(c => c.method === 'POST').every(c => c.body.permissions.metadata === 'read'));
  assert.equal(f.s.tables.projectGithubBindings.size, 0);
  // The owner's second project uses the grant in the direct settings mutation.
  const second = copyProject(f);
  const configuration = {
    provider: 'github-actions',
    repository: 'Synthetic/Repo',
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
  await f.s.call('configure', definitions.configure, { projectId: second, request });
  assert.deepEqual(await scopeOf(f, second), {
    repoId: 42,
    installationId: 9,
  });
  const settings = JSON.parse(
    await f.s.call('current', definitions.current, {
      projectId: second,
      checkId: '',
      includeGithubBindings: true,
    }),
  );
  assert.equal(settings.runnerGrant.repoId, 42);
  // Another owner's project, and the mirror policy, gain nothing from the grant.
  const stranger = copyProject(f, { owner: 'stranger' });
  await assert.rejects(
    f.s.call('configure', definitions.configure, { projectId: stranger, request }, 'stranger'),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  assert.equal(await scopeOf(f, stranger), null);
  await assert.rejects(
    f.s.call('policy', policies.set, {
      projectId: second,
      command: JSON.stringify({
        action: 'set-policy',
        operationId: randomUUID(),
        githubMirror: { repo: 'synthetic/repo', autoPush: true, laneRefs: false },
      }),
    }),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  await assert.rejects(
    tokens.installationToken(f.ctx, second, 'synthetic/repo', tokens.mirrorPermissions),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
});
test('runner grant proof refuses write role, another user’s answer and a renamed repository', async t => {
  for (const [options, wanted] of [
    [{ role: 'write' }, 'GITHUB_REPOSITORY_PERMISSION'],
    [{ role: 'admin', roleUser: 7 }, 'GITHUB_REPOSITORY_PERMISSION'],
    [{ role: 'admin', name: 'synthetic/other' }, 'GITHUB_REPOSITORY_UNBOUND'],
  ]) {
    const f = fixture(t);
    github(t, options);
    await assert.rejects(configureRunner(f), code(wanted));
    assert.equal(f.s.tables.githubRunnerGrants.size, 0);
  }
});
test('grant-scoped Actions tokens: no Convex call per mint; uninstall, removal and disconnect revoke', async t => {
  const f = fixture(t),
    provider = github(t, { role: 'admin' });
  await configureRunner(f);
  const scope = await scopeOf(f, f.projectId);
  let convexCalls = 0;
  const counted = {
    ...f.ctx,
    runQuery: async (...args) => (convexCalls++, f.ctx.runQuery(...args)),
    runMutation: async (...args) => (convexCalls++, f.ctx.runMutation(...args)),
  };
  await tokens.actionsToken(counted, f.projectId, 'synthetic/repo', scope);
  assert.equal(convexCalls, 0);
  assert.deepEqual(provider.calls.at(-1).body, {
    repository_ids: [42],
    permissions: { actions: 'write', contents: 'read' },
  });
  // A different live installation is refused before any mint.
  const posts = provider.calls.filter(c => c.method === 'POST').length;
  await assert.rejects(
    tokens.actionsToken(counted, f.projectId, 'synthetic/repo', { ...scope, installationId: 10 }),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  assert.equal(provider.calls.filter(c => c.method === 'POST').length, posts);
  // Without a scope (no grant read), the stored/operator path still refuses.
  await assert.rejects(
    tokens.actionsToken(counted, f.projectId, 'synthetic/repo', null),
    code('GITHUB_REPOSITORY_UNBOUND'),
  );
  // Repository removal from the installation deletes the grant.
  await f.s.call('invalidate', webhook.invalidate, {
    delivery: 'synthetic-delivery:runner',
    installationId: 9,
    removed: false,
    repoIds: [42],
  });
  assert.equal(f.s.tables.githubRunnerGrants.size, 0);
  // Uninstall tombstones the installation: a fresh grant (from the owner's next project) stops resolving.
  await configureRunner(f, copyProject(f));
  assert.deepEqual(await scopeOf(f, f.projectId), scope);
  await f.s.call('invalidate', webhook.invalidate, {
    delivery: 'synthetic-delivery:uninstall',
    installationId: 9,
    removed: true,
    repoIds: [],
  });
  assert.equal(await scopeOf(f, f.projectId), null);
  // Disconnect withdraws the owner's grant even while another project holds the stored binding.
  const f2 = fixture(t);
  github(t, { role: 'admin' });
  await configureRunner(f2);
  const other = f2.s.insert('projectGithubBindings', {
    projectId: copyProject(f2),
    repoId: 42,
    fullName: 'synthetic/repo',
    installationId: 9,
    boundBy: 'owner',
    boundAt: 1,
  });
  await f2.call('remove', { operationId: randomUUID(), repoId: 42 });
  assert.equal(f2.s.tables.githubRunnerGrants.size, 0);
  assert(f2.s.tables.projectGithubBindings.has(other));
  // The operator override keeps its own path (no scope read).
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${f2.projectId}=synthetic/repo`;
  assert.equal(await scopeOf(f2, f2.projectId), null);
});

test('two-way protection: Forge prints the ruleset, reads what main enforces and names each missing rule', async () => {
  const { forgeRuleset, protectionFindings, protectionAdvice } = await import('../dist/github-pull-check.js');
  const { githubProtection } = await import('../dist/github-connect-cli.js');
  const ruleset = forgeRuleset(5141309);
  assert.deepEqual(ruleset.bypass_actors, [
    { actor_id: 5141309, actor_type: 'Integration', bypass_mode: 'always' },
  ]);
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/main']);
  assert.deepEqual(
    ruleset.rules.map(rule => rule.type),
    ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'],
  );
  assert.deepEqual(ruleset.rules[3].parameters.required_status_checks, [
    { context: 'forge/verify', integration_id: 5141309 },
  ]);
  // GET rules/branches/main of an imported ruleset (recorded shape, ids synthetic).
  const enforced = ruleset.rules.map(rule => ({ ...rule, ruleset_id: 11, ruleset_source: 'o/r' }));
  const full = protectionFindings(enforced, 5141309, [{ bypass_actors: ruleset.bypass_actors }]);
  assert.deepEqual(full, { protected: true, missing: [], bypass: true });
  assert.match(protectionAdvice('o/r', full, 'maintain'), /^o\/r main is protected/);
  // Bypass actors are hidden from non-admin readers: unknown, never assumed.
  assert.equal(protectionFindings(enforced, 5141309, [{}]).bypass, null);
  assert.match(
    protectionAdvice('o/r', protectionFindings(enforced, 5141309, [{}]), null),
    /cannot see bypass actors/,
  );
  const otherApp = enforced.map(rule =>
    rule.type === 'required_status_checks'
      ? { ...rule, parameters: { required_status_checks: [{ context: 'forge/verify', integration_id: 1 }] } }
      : rule,
  );
  const partial = protectionFindings(otherApp.slice(1), 5141309, [{ bypass_actors: [] }]);
  assert.equal(partial.protected, false);
  assert.deepEqual(partial.missing, [
    'required status forge/verify from the Forge App',
    'block deletion',
    'the Forge App as bypass actor (Forge publishes main directly)',
  ]);
  const none = protectionFindings([], 5141309, []);
  assert.equal(none.missing.length, 4);
  const maintain = protectionAdvice('o/r', none, 'maintain');
  assert.match(maintain, /Import a ruleset/);
  assert.match(maintain, /gh api -X POST repos\/o\/r\/rulesets --input forge-ruleset.json/);
  assert.match(maintain, /needs the repository Admin role .*you connected with Maintain.*send the ruleset/);
  assert.doesNotMatch(protectionAdvice('o/r', none, 'admin'), /Admin role/);
  // The CLI never hides a failed read: it reports the code and how to check again.
  const failed = await githubProtection(
    {
      action: async () => {
        const { ForgeError } = await import('../dist/errors.js');
        throw new ForgeError('GITHUB_REPOSITORY_UNBOUND', 'Connect this repository.');
      },
    },
    'o/r',
  );
  assert.equal(failed.protected, null);
  assert.equal(failed.error, 'GITHUB_REPOSITORY_UNBOUND');
  assert.match(failed.advice, /could not read the rules on o\/r main/);
});
