// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { getFunctionAddress } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';
import { checkArgs } from './convex-args.mjs';

const identity = await import(moduleUrl('../convex/forgeIdentity.ts'));
const authIdentity = await import(moduleUrl('../convex/authIdentity.ts'));
const users = await import(moduleUrl('../convex/authUsers.ts'));
const auth = await import(moduleUrl('../convex/auth.ts'));
const handles = await import(moduleUrl('../convex/urlAccounts.ts'));
const firstPasskey = await import(moduleUrl('../convex/authFirstPasskey.ts'));
const device = await import(moduleUrl('../convex/deviceActions.ts'));
// Every sign-in is the stable device flow (ac85b100); `stable` is the proven device the HTTP action passes in.
const begin = (ctx, input) =>
  device.beginDeviceLogin(ctx, {
    ...input,
    stable: { id: input.operationId, key: 'synthetic-device-key' },
    forceApproval: true,
  });
const deviceStore = await import(moduleUrl('../convex/deviceStore.ts'));
const tokenStore = await import(moduleUrl('../convex/githubUserTokens.ts'));
const tokenActions = await import(moduleUrl('../convex/githubUserTokenActions.ts'));
const deleteRequests = await import(moduleUrl('../convex/projectDeleteRequests.ts'));
const { accountAction } = await import(moduleUrl('../convex/cliServer.ts'));
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
const refused = code => error => (error.data?.code ?? error.code) === code;

function fixture(t) {
  const env = {
    CONVEX_CLOUD_URL: 'https://auth-fixture.convex.cloud',
    FORGE_WEB_URL: 'https://forge.example',
    FORGE_CLI_ISSUER: 'https://auth-fixture.convex.site',
    FORGE_CLI_PRIVATE_KEY: key,
    FORGE_GITHUB_TOKEN_KEYRING: JSON.stringify({
      active: 'fixture',
      keys: { fixture: randomBytes(32).toString('base64') },
    }),
  };
  const old = new Map(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [name, value] of old)
      value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  const s = state();
  for (const table of ['users', 'deviceCodes', 'deviceAttempts', 'cliCredentials', 'githubBindingOperations'])
    s.tables[table] = new Map();
  const user = {
    _id: 'authuser',
    _creationTime: 1,
    accountKey: 'user_syntheticAccount',
    githubId: '123456',
    githubLogin: 'synthetic',
    emailVerified: false,
  };
  s.tables.users.set(user._id, user);
  s.tables.forgeAccounts.set('account', {
    _id: 'account',
    _creationTime: 1,
    owner: user.accountKey,
    handle: 'synthetic',
  });
  let rawIdentity = {
    issuer: `${env.CONVEX_CLOUD_URL}/components/auth`,
    subject: 'session',
    tokenIdentifier: 'auth|session',
  };
  const sessions = new Map([['session', { userId: user._id, creationTime: Date.now() }]]);
  const passkeys = [];
  const usernames = new Map();
  const starts = [];
  let componentReads = 0,
    userReads = 0,
    ceremonyOwner;
  const baseGet = s.ctx.db.get;
  const ctx = {
    ...s.ctx,
    db: new Proxy(s.ctx.db, {
      get(target, name) {
        if (name === 'get')
          return async id => {
            if (s.tables.users.has(id)) userReads++;
            return baseGet(id);
          };
        const value = target[name];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    auth: { getUserIdentity: async () => rawIdentity },
  };
  const modules = { authIdentity, deviceStore, authUsers: users, githubUserTokens: tokenStore };
  const dispatch = async (ref, args) => {
    const address = getFunctionAddress(ref);
    if (address.reference) {
      const name = address.reference;
      if (name.endsWith('/getSession')) {
        componentReads++;
        const value = sessions.get(args.sessionId);
        return value ? { userId: value.userId } : null;
      }
      if (name.endsWith('/listSessions'))
        return [...sessions]
          .filter(([, value]) => value.userId === args.userId)
          .map(([sessionId, value]) => ({
            sessionId,
            creationTime: value.creationTime,
            lastRefreshedAt: value.creationTime,
          }));
      if (name.endsWith('/listPasskeys')) return passkeys.filter(value => value.userId === args.userId);
      if (name.endsWith('/getUsername')) return usernames.get(args.userId) ?? null;
      if (name.endsWith('/getUserIdByUsername'))
        return [...usernames].find(([, name]) => name === args.username)?.[0] ?? null;
      if (name.endsWith('/setUsername')) {
        if ([...usernames].some(([id, name]) => name === args.username && id !== args.userId))
          return { success: false, userError: { error: 'USERNAME_TAKEN' } };
        usernames.set(args.userId, args.username);
        return { success: true, previousUsername: null };
      }
      if (name.endsWith('/startAuthentication')) {
        starts.push(args);
        return { challenge: new Uint8Array([1, 2]).buffer, allowCredentials: [] };
      }
      if (name.endsWith('/startRegistrationForNewUser')) {
        starts.push(args);
        return { challenge: new Uint8Array([1, 2]).buffer, userHandle: new Uint8Array([3, 4]).buffer };
      }
      if (name.endsWith('/checkRegistrationForNewUser')) return { success: true };
      if (name.endsWith('/_internal_dangerous_signUp')) {
        const userId = await users.createPasskey._handler(ctx, {
          method: { name: 'usernamePasskey', profile: {} },
        });
        return {
          userId,
          accessToken:
            'header.' +
            Buffer.from(JSON.stringify({ sub: 'registered-session' })).toString('base64url') +
            '.signature',
          refreshToken: 'synthetic-refresh',
          refreshTokenExpiresAt: 1000,
        };
      }
      if (name.endsWith('/_internal_dangerous_finishRegistrationForNewUser')) {
        passkeys.push({ userId: args.newUserId, passkeyId: 'registered' });
        return { success: true, passkeyId: 'registered' };
      }
      if (name.endsWith('/startRegistrationForExistingUser')) {
        ceremonyOwner = args.verifiedUserId;
        return {
          challenge: new Uint8Array([1, 2]).buffer,
          userHandle: new Uint8Array([3, 4]).buffer,
          excludeCredentials: [],
        };
      }
      if (name.endsWith('/_internal_dangerous_finishRegistrationForExistingUser')) {
        if (ceremonyOwner !== args.verifiedUserId || args.response.id !== 'credential')
          return { success: false, userError: { error: 'PROTOCOL_ERROR' } };
        passkeys.push({ userId: args.verifiedUserId, passkeyId: 'first' });
        return { success: true, passkeyId: 'first' };
      }
      throw new Error(`Unhandled component function ${name}`);
    }
    const [module, name] = address.name.split(':');
    const fn = modules[module]?.[name];
    if (fn) {
      checkArgs(fn, args);
      return fn._handler(ctx, args);
    }
    return s.ctx.runQuery(ref, args);
  };
  ctx.runQuery = dispatch;
  ctx.runMutation = dispatch;
  return {
    ...s,
    ctx,
    user,
    sessions,
    passkeys,
    usernames,
    starts,
    identity: value => {
      rawIdentity = value;
    },
    browser: () => rawIdentity,
    reads: () => ({ componentReads, userReads }),
  };
}

test('browser identity resolves session to Forge account once per invocation, at constant record cost', async t => {
  const s = fixture(t);
  const ctx = identity.identityContext(s.ctx);
  assert.equal((await ctx.auth.getUserIdentity()).subject, s.user.accountKey);
  assert.equal((await ctx.auth.getUserIdentity()).forgeAuthSession, 'session');
  assert.deepEqual(s.reads(), { componentReads: 1, userReads: 1 });
  for (let n = 0; n < 14; n++)
    s.tables.users.set(`other${n}`, { ...s.user, _id: `other${n}`, accountKey: `user_other${n}` });
  await identity.identityContext(s.ctx).auth.getUserIdentity();
  assert.deepEqual(s.reads(), { componentReads: 2, userReads: 2 });
});

test('Clerk and a linked Convex Auth session approve bulk requests for the same Forge owner', async t => {
  const s = fixture(t);
  const convex = s.browser();
  const clerk = {
    issuer: 'https://clerk.example',
    subject: s.user.accountKey,
    tokenIdentifier: 'clerk|owner',
  };
  for (const [i, requester, approver] of [
    [0, clerk, convex],
    [1, convex, clerk],
  ]) {
    const projectId = `scratch-${i}`;
    s.tables.hostedProjects.set(projectId, projectRow({ _id: projectId, owner: s.user.accountKey }));
    s.identity(requester);
    const request = JSON.parse(
      await deleteRequests.prepare._handler(s.ctx, {
        operationId: randomUUID(),
        select: { ids: [projectId] },
      }),
    );
    s.identity(approver);
    const done = JSON.parse(
      await deleteRequests.decide._handler(s.ctx, {
        requestId: request.id,
        operationId: randomUUID(),
        decision: 'approve',
        count: 1,
      }),
    );
    assert.equal(done.projects[0].outcome, 'started');
    assert.equal(s.tables.hostedProjects.get(projectId).removal, 'deleting');
  }
});

test('a copied browser token loses reads and device approval after session revocation', async t => {
  const s = fixture(t),
    copied = s.browser();
  const flow = await begin(s.ctx, {
    operationId: randomUUID(),
    clientNonce: randomBytes(32).toString('hex'),
    name: 'Synthetic device',
    scope: 'cli',
  });
  s.sessions.delete('session');
  s.identity(copied);
  assert.equal(await identity.identityContext(s.ctx).auth.getUserIdentity(), null);
  await assert.rejects(
    device.decide._handler(s.ctx, { code: flow.user_code, approve: true, operationId: randomUUID() }),
    refused('AUTH_REQUIRED'),
  );
  assert.equal(s.tables.cliCredentials.size, 0);
});

test('CLI and retained Clerk identities add no session or users reads; missing user never becomes an owner', async t => {
  const s = fixture(t);
  for (const raw of [
    null,
    { subject: 'user_legacy', issuer: 'https://legacy.example' },
    { subject: 'user_cli', issuer: process.env.FORGE_CLI_ISSUER, forgeCredential: 'credential' },
  ]) {
    s.identity(raw);
    assert.deepEqual(await identity.identityContext(s.ctx).auth.getUserIdentity(), raw);
  }
  assert.deepEqual(s.reads(), { componentReads: 0, userReads: 0 });
  s.identity({ issuer: `${process.env.CONVEX_CLOUD_URL}/components/auth`, subject: 'session' });
  s.tables.users.delete(s.user._id);
  assert.equal(await identity.identityContext(s.ctx).auth.getUserIdentity(), null);
});

test('revoking the browser between inspection and decision leaves the device pending', async t => {
  const s = fixture(t);
  const flow = await begin(s.ctx, {
    operationId: randomUUID(),
    clientNonce: randomBytes(32).toString('hex'),
    name: 'Synthetic race',
    scope: 'cli',
  });
  const mutate = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    // Revoke after the action's account check, before the granting transaction begins.
    if (getFunctionAddress(ref).name === 'deviceStore:decide') s.sessions.delete('session');
    return mutate(ref, args);
  };
  await assert.rejects(
    device.decide._handler(s.ctx, { code: flow.user_code, approve: true, operationId: randomUUID() }),
    refused('AUTH_REQUIRED'),
  );
  assert.equal([...s.tables.deviceCodes.values()][0].state, 'pending');
  assert.equal(s.tables.cliCredentials.size, 0);
});

test('an action refuses its result when the browser session is revoked during external work', async t => {
  const s = fixture(t);
  const read = accountAction('same')({
    args: {},
    handler: async ctx => {
      assert.equal((await ctx.auth.getUserIdentity()).subject, s.user.accountKey);
      s.sessions.delete('session');
      return 'private source';
    },
  });
  await assert.rejects(read._handler(s.ctx, {}), refused('AUTH_REVOKED'));
});

test('a Convex Auth browser approval issues the normal Forge CLI credential; a CLI token cannot approve', async t => {
  const s = fixture(t);
  const flow = await begin(s.ctx, {
    operationId: randomUUID(),
    clientNonce: randomBytes(32).toString('hex'),
    name: 'Synthetic CLI',
    scope: 'cli',
  });
  await device.decide._handler(s.ctx, { code: flow.user_code, approve: true, operationId: randomUUID() });
  const issued = await device.poll._handler(s.ctx, {
    deviceCode: flow.device_code,
    operationId: randomUUID(),
  });
  const token = JSON.parse(Buffer.from(issued.token.split('.')[1], 'base64url'));
  assert.equal(token.sub, s.user.accountKey);
  assert.equal(token.aud, 'forge-cli');
  assert.equal(token.exp - token.iat, 30 * 24 * 3600);
  s.identity({ subject: token.sub, issuer: token.iss, forgeCredential: issued.credentialId });
  await assert.rejects(firstPasskey.start._handler(s.ctx, {}), refused('AUTH_REQUIRED'));
  await assert.rejects(
    device.decide._handler(s.ctx, { code: flow.user_code, approve: true, operationId: randomUUID() }),
    refused('AUTH_REQUIRED'),
  );
});

test('GitHub callbacks keep numeric identity and account key, store verified email only, and never link by email', async t => {
  const s = fixture(t);
  const method = {
    name: 'github',
    profile: { id: '654321', login: 'another', email: 'unverified@example.com', emailVerified: false },
  };
  const id = await users.createGithub._handler(s.ctx, { method });
  const account = s.tables.users.get(id);
  assert.equal(account.githubId, '654321');
  assert.ok(account.accountKey.startsWith('user_'));
  assert.equal(account.email, undefined);
  await users.signedInGithub._handler(s.ctx, { userId: id, method });
  assert.equal(account.email, undefined);
  const verified = { ...method, profile: { ...method.profile, emailVerified: true } };
  await users.signedInGithub._handler(s.ctx, { userId: id, method: verified });
  assert.equal(account.email, 'unverified@example.com');
  const same = await users.createGithub._handler(s.ctx, { method: verified });
  assert.equal(same, id);
  await users.signedInGithub._handler(s.ctx, { userId: id, method });
  assert.equal(account.emailVerified, false);
  assert.equal(account.email, undefined);
  const other = await users.createGithub._handler(s.ctx, {
    method: { ...verified, profile: { ...verified.profile, id: '777777' } },
  });
  assert.notEqual(other, id);
  await assert.rejects(
    users.signedInGithub._handler(s.ctx, {
      userId: id,
      method: { ...verified, profile: { ...verified.profile, id: '777777' } },
    }),
    refused('GITHUB_ACCOUNT_MISMATCH'),
  );
});

test('a GitHub-only account can add its first passkey; stale, revoked, wrong and repeat ceremonies fail', async t => {
  const s = fixture(t);
  const options = await firstPasskey.start._handler(s.ctx, {});
  assert.equal(options.user.name, 'synthetic');
  assert.deepEqual(options.extensions, {});
  const response = {
    id: 'credential',
    rawId: 'credential',
    type: 'public-key',
    response: { clientDataJSON: '', attestationObject: '' },
    clientExtensionResults: {},
  };
  assert.equal(
    (await firstPasskey.finish._handler(s.ctx, { response: { ...response, id: 'wrong' } })).success,
    false,
  );
  assert.deepEqual(await firstPasskey.finish._handler(s.ctx, { response }), {
    success: true,
    passkeyId: 'first',
  });
  await assert.rejects(firstPasskey.start._handler(s.ctx, {}), refused('BAD_ARGUMENT'));
  s.passkeys.length = 0;
  s.sessions.get('session').creationTime = Date.now() - 11 * 60 * 1000;
  await assert.rejects(firstPasskey.finish._handler(s.ctx, { response }), refused('AUTH_EXPIRED'));
  s.sessions.delete('session');
  await assert.rejects(firstPasskey.finish._handler(s.ctx, { response }), refused('AUTH_REQUIRED'));
});

test('GitHub App credentials are encrypted, owner-bound, and unavailable to a changed callback', async t => {
  const s = fixture(t);
  s.tables.githubBindingOperations.set('connection', {
    _id: 'connection',
    _creationTime: 1,
    state: 'state',
    actor: s.user.accountKey,
    status: 'processing',
    githubAccounts: [s.user.githubId],
  });
  await tokenActions.storeConnection._handler(s.ctx, {
    state: 'state',
    owner: s.user.accountKey,
    token: 'ghu_syntheticToken',
  });
  assert.equal(JSON.stringify([...s.tables.users.values()]).includes('ghu_syntheticToken'), false);
  assert.equal(await tokenActions.githubUserToken(s.ctx, s.user.accountKey), 'ghu_syntheticToken');
  const sealed = s.user.githubToken;
  s.tables.users.set('other', {
    ...s.user,
    _id: 'other',
    accountKey: 'user_otherAccount',
    githubToken: sealed,
  });
  await assert.rejects(tokenActions.githubUserToken(s.ctx, 'user_otherAccount'), refused('SECRET_INVALID'));
  s.tables.githubBindingOperations.get('connection').status = 'completed';
  await assert.rejects(
    tokenActions.storeConnection._handler(s.ctx, {
      state: 'state',
      owner: s.user.accountKey,
      token: 'ghu_second',
    }),
    refused('GITHUB_OAUTH_STATE'),
  );
});

test('GitHub sign-in names missing OAuth settings with a typed error before component I/O', async t => {
  fixture(t);
  const names = ['AUTH_GITHUB_CLIENT_ID', 'AUTH_GITHUB_CLIENT_SECRET'];
  const old = names.map(name => process.env[name]);
  t.after(() =>
    names.forEach((name, i) =>
      old[i] === undefined ? delete process.env[name] : (process.env[name] = old[i]),
    ),
  );
  const auth = await import(moduleUrl('../convex/auth.ts') + '?github-settings-test');
  const ctx = {
    auth: { getUserIdentity: async () => null },
    runMutation: async () => {
      throw new Error('Unexpected component I/O');
    },
  };
  for (const missing of names) {
    for (const name of names) process.env[name] = 'synthetic-oauth-value';
    delete process.env[missing];
    await assert.rejects(
      auth.startSignInWithGithub._handler(ctx, { redirectTo: 'https://forge.example' }),
      error => {
        assert.deepEqual(error.data, {
          code: 'AUTH_CONFIGURATION',
          setting: missing,
          message: `GitHub sign-in requires ${missing}. Configure it and redeploy.`,
        });
        return true;
      },
    );
  }
  for (const name of names) process.env[name] = 'synthetic-oauth-value';
  const result = await auth.startSignInWithGithub._handler(
    {
      auth: { getUserIdentity: async () => null },
      runMutation: async () => ({
        clientId: 'synthetic-oauth-value',
        callbackUrl: 'https://auth-fixture.convex.site/oauth/github/callback',
      }),
    },
    { redirectTo: 'https://forge.example' },
  );
  assert.equal(new URL(result.redirect).searchParams.get('client_id'), 'synthetic-oauth-value');
  assert.equal(typeof result.state, 'string');
  await assert.rejects(
    auth.startSignInWithGithub._handler(ctx, { redirectTo: 'https://untrusted.example' }),
    /not in allowedRedirectOrigins/,
  );
});

const registration = {
  id: 'credential',
  rawId: 'credential',
  type: 'public-key',
  response: { clientDataJSON: '', attestationObject: '' },
  clientExtensionResults: {},
};

test('passkey entry uses only the current Forge handle and never registers an existing account again', async t => {
  const s = fixture(t);
  s.tables.accountHandles.set('handle', {
    _id: 'handle',
    _creationTime: 1,
    owner: s.user.accountKey,
    handle: 'synthetic',
  });
  s.identity(null);
  const result = await auth.startSignInWithUsernamePasskey._handler(s.ctx, { username: 'synthetic' });
  assert.equal(result.step, 'authenticate');
  assert.equal(s.starts[0].userId, s.user._id);
  assert.deepEqual(
    await auth.finishSignUpWithUsernamePasskey._handler(s.ctx, {
      username: 'synthetic',
      response: registration,
    }),
    { status: 'error', userError: { error: 'USERNAME_TAKEN' } },
  );
  assert.equal(s.tables.users.size, 1);
  s.identity({ issuer: `${process.env.CONVEX_CLOUD_URL}/components/auth`, subject: 'session' });
  assert.equal((await firstPasskey.start._handler(s.ctx, {})).user.name, 'synthetic');
  assert.equal(s.usernames.get(s.user._id), 'synthetic');
  await handles.set._handler(s.ctx, { handle: 'new-handle', operationId: 'rename' });
  assert.equal(s.usernames.get(s.user._id), 'new-handle');
  s.identity(null);
  assert.equal(
    (await auth.startSignInWithUsernamePasskey._handler(s.ctx, { username: 'new-handle' })).step,
    'authenticate',
  );
  assert.deepEqual(await auth.startSignInWithUsernamePasskey._handler(s.ctx, { username: 'synthetic' }), {
    success: false,
    userError: { error: 'USERNAME_TAKEN' },
  });
});

test('direct passkey calls enforce Forge handle syntax and reserved destinations before creating a ceremony', async t => {
  const s = fixture(t);
  s.identity(null);
  for (const username of ['a', 'settings', 'Mixed-Case', 'éclair', '-prefix', 'suffix-', 'x'.repeat(40)]) {
    assert.equal((await auth.startSignInWithUsernamePasskey._handler(s.ctx, { username })).success, false);
    assert.equal(
      (await auth.finishSignUpWithUsernamePasskey._handler(s.ctx, { username, response: registration }))
        .status,
      'error',
    );
  }
  assert.equal(s.starts.length, 0);
  assert.equal(s.tables.users.size, 1);
});

test('a legacy Forge handle directs the person to their existing sign-in without creating an account', async t => {
  const s = fixture(t);
  s.tables.accountHandles.set('legacy', {
    _id: 'legacy',
    _creationTime: 1,
    owner: 'user_legacy',
    handle: 'legacy-handle',
  });
  s.identity(null);
  assert.deepEqual(await auth.startSignInWithUsernamePasskey._handler(s.ctx, { username: 'legacy-handle' }), {
    success: false,
    userError: { error: 'USERNAME_TAKEN' },
  });
  assert.equal(s.starts.length, 0);
});

test('passkey registration commits the chosen Forge handle and no placeholder alias', async t => {
  const s = fixture(t);
  s.identity(null);
  const old = globalThis.Convex;
  globalThis.Convex = {
    asyncSyscall: async (op, value) => {
      assert.equal(op, '1.0/createFunctionHandle');
      return JSON.stringify('function://' + JSON.parse(value).name);
    },
  };
  t.after(() => {
    globalThis.Convex = old;
  });
  assert.equal(
    (await auth.startSignInWithUsernamePasskey._handler(s.ctx, { username: 'new-person' })).step,
    'register',
  );
  const result = await auth.finishSignUpWithUsernamePasskey._handler(s.ctx, {
    username: 'new-person',
    response: registration,
  });
  assert.equal(result.status, 'complete');
  const user = s.tables.users.get(result.tokens.userId);
  const account = [...s.tables.forgeAccounts.values()].find(row => row.owner === user.accountKey);
  assert.equal(account.handle, 'new-person');
  assert.equal(user.deviceApprovalProof.sessionId, 'registered-session');
  assert.equal(account.handlePrompt, false);
  assert.equal(s.usernames.get(user._id), 'new-person');
  assert.deepEqual(
    [...s.tables.accountHandles.values()].filter(row => row.owner === user.accountKey).map(row => row.handle),
    ['new-person'],
  );
});

test('SI-01 review: direct passkey sign-in completion preserves the library result and records proof for its new browser session', async t => {
  const s = fixture(t);
  s.identity(null);
  s.usernames.set(s.user._id, 'synthetic');
  const tokens = {
    userId: s.user._id,
    accessToken:
      'header.' +
      Buffer.from(JSON.stringify({ sub: 'passkey-session' })).toString('base64url') +
      '.signature',
    refreshToken: 'synthetic-refresh',
    refreshTokenExpiresAt: 1000,
  };
  const dispatch = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    const name = getFunctionAddress(ref).reference ?? '';
    if (name.endsWith('/finishAuthentication'))
      return args.response.id === 'existing'
        ? { success: true, userId: s.user._id }
        : { success: false, userError: { error: 'PROTOCOL_ERROR' } };
    if (name.endsWith('/_internal_dangerous_signIn')) {
      s.sessions.set('passkey-session', { userId: args.userId, creationTime: Date.now() });
      return tokens;
    }
    return dispatch(ref, args);
  };
  const response = {
    id: 'existing',
    rawId: 'existing',
    type: 'public-key',
    response: { clientDataJSON: '', authenticatorData: '', signature: '' },
    clientExtensionResults: {},
  };
  checkArgs(auth.finishSignInWithUsernamePasskey, { response });
  const result = await auth.finishSignInWithUsernamePasskey._handler(s.ctx, { response });
  assert.deepEqual(result, { status: 'complete', tokens, username: 'synthetic' });
  const proof = structuredClone(s.tables.users.get(s.user._id).deviceApprovalProof);
  assert.equal(proof.sessionId, 'passkey-session');
  assert.deepEqual(
    await auth.finishSignInWithUsernamePasskey._handler(s.ctx, { response: { ...response, id: 'wrong' } }),
    { status: 'error', userError: { error: 'PROTOCOL_ERROR' } },
  );
  assert.deepEqual(s.tables.users.get(s.user._id).deviceApprovalProof, proof);
});
