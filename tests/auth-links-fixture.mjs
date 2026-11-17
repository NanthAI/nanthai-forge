// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { getFunctionAddress } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { after } from 'node:test';
const originalOrigin = process.env.FORGE_WEB_URL;
process.env.FORGE_WEB_URL = 'https://forge.example';
after(() =>
  originalOrigin === undefined
    ? delete process.env.FORGE_WEB_URL
    : (process.env.FORGE_WEB_URL = originalOrigin),
);
const { state } = await import('./hosted-fixture.mjs');

export const legacy = await import(moduleUrl('../convex/authLegacy.ts'));
export const legacyStore = await import(moduleUrl('../convex/authLegacyStore.ts'));
export const links = await import(moduleUrl('../convex/authLinks.ts'));
export const users = await import(moduleUrl('../convex/authUsers.ts'));
export const auth = await import(moduleUrl('../convex/auth.ts'));
export const binding = await import(moduleUrl('../convex/githubBindingOAuth.ts'));
const { digest } = await import(moduleUrl('../convex/authLinkAccount.ts'));
const { encryptTicketPayload } = await import(
  moduleUrl('../node_modules/@convex-dev/auth/src/lib/oauth/crypto.ts')
);
export const refused = code => error => (error.data?.code ?? error.code) === code;
export const registration = {
  id: 'credential',
  rawId: 'credential',
  type: 'public-key',
  response: { clientDataJSON: '', attestationObject: '' },
  clientExtensionResults: {},
};
export const assertion = {
  id: 'existing',
  rawId: 'existing',
  type: 'public-key',
  response: { clientDataJSON: '', authenticatorData: '', signature: '' },
  clientExtensionResults: {},
};

export function fixture(t, { mapped = true, github = false } = {}) {
  const values = {
    CONVEX_CLOUD_URL: 'https://auth-fixture.convex.cloud',
    CLERK_JWT_ISSUER_DOMAIN: 'https://legacy.example',
    CLERK_SECRET_KEY: 'synthetic-secret',
    AUTH_GITHUB_CLIENT_ID: 'synthetic-client',
    AUTH_GITHUB_CLIENT_SECRET: 'synthetic-secret',
  };
  const prior = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  const oldConvex = globalThis.Convex;
  globalThis.Convex = {
    asyncSyscall: async (op, args) => {
      assert.equal(op, '1.0/createFunctionHandle');
      return JSON.stringify('function://' + JSON.parse(args).name);
    },
  };
  t.after(() => {
    globalThis.Convex = oldConvex;
    for (const [name, value] of prior)
      value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  const s = state();
  const owner = 'user_legacy';
  s.tables.forgeAccounts.set('account', {
    _id: 'account',
    _creationTime: 1,
    owner,
    handle: 'existing-person',
  });
  s.tables.accountHandles.set('handle', {
    _id: 'handle',
    _creationTime: 1,
    owner,
    handle: 'existing-person',
  });
  if (mapped)
    s.tables.users.set('user', {
      _id: 'user',
      _creationTime: 1,
      accountKey: owner,
      emailVerified: false,
      ...(github ? { githubId: '123' } : {}),
    });
  let identity = { subject: 'session', issuer: `${values.CONVEX_CLOUD_URL}/components/auth` };
  const sessions = new Map([['session', { userId: 'user' }]]);
  const keys = [],
    names = new Map(),
    bindings = new Map(),
    tickets = new Map();
  const registrations = new Set(),
    confirmations = new Map();
  let assertionOwner = 'user',
    failBinding = false;
  const ctx = { ...s.ctx, auth: { getUserIdentity: async () => identity } };
  const modules = { authLegacyStore: legacyStore, authUsers: users };
  async function dispatch(ref, args) {
    const address = getFunctionAddress(ref),
      name = address.reference;
    if (!name) {
      const [module, fn] = address.name.split(':');
      if (modules[module]?.[fn]) return modules[module][fn]._handler(ctx, args);
      throw new Error(`Unexpected app function ${address.name}`);
    }
    if (name.endsWith('/getSession')) return sessions.get(args.sessionId) ?? null;
    if (name.endsWith('/listPasskeys')) return keys.filter(key => key.userId === args.userId);
    if (name.endsWith('/setUsername')) {
      names.set(args.userId, args.username);
      return { success: true, previousUsername: null };
    }
    if (name.endsWith('/getUserIdByUsername'))
      return [...names].find(([, value]) => value === args.username)?.[0] ?? null;
    if (name.endsWith('/startRegistrationForExistingUser')) {
      registrations.add(args.verifiedUserId);
      return {
        challenge: new Uint8Array([1]).buffer,
        userHandle: new Uint8Array([2]).buffer,
        excludeCredentials: [],
      };
    }
    if (name.endsWith('/_internal_dangerous_finishRegistrationForExistingUser')) {
      if (!registrations.has(args.verifiedUserId) || args.response.id !== 'credential')
        return { success: false, userError: { error: 'PROTOCOL_ERROR' } };
      registrations.delete(args.verifiedUserId);
      const passkeyId = `passkey-${keys.length}`;
      keys.push({ userId: args.verifiedUserId, passkeyId });
      return { success: true, passkeyId };
    }
    if (name.endsWith('/startAuthentication')) {
      confirmations.set(args.purpose, args.userId);
      return { challenge: new Uint8Array([1]).buffer, allowCredentials: [] };
    }
    if (name.endsWith('/finishAuthentication')) {
      const userId = confirmations.get(args.purpose);
      confirmations.delete(args.purpose);
      return userId === assertionOwner
        ? { success: true, userId }
        : { success: false, userError: { error: 'PROTOCOL_ERROR' } };
    }
    if (name.endsWith('/_internal_dangerous_createAuthorizationRequest'))
      return {
        clientId: 'synthetic-client',
        callbackUrl: 'https://auth-fixture.convex.site/oauth/github/callback',
      };
    if (name.endsWith('/claimTicket')) {
      const value = tickets.get(args.ticketCodeHash);
      if (!value || value.stateHash !== args.stateHash) return null;
      tickets.delete(args.ticketCodeHash);
      return { encryptedPayload: value.encryptedPayload };
    }
    if (name.endsWith('/getUserIdByAccount')) return bindings.get(args.providerAccountId) ?? null;
    if (name.endsWith('/_internal_dangerous_createAccount')) {
      if (failBinding) throw new Error('Synthetic binding failure');
      assert.equal(bindings.has(args.providerAccountId), false);
      bindings.set(args.providerAccountId, args.userId);
      return null;
    }
    if (name.endsWith('/_internal_dangerous_signIn')) {
      await users.signedInGithub._handler(ctx, {
        userId: args.userId,
        method: { name: 'github', profile: args.claims.profile },
      });
      sessions.set('new-session', { userId: args.userId });
      return {
        userId: args.userId,
        accessToken: 'synthetic-access',
        refreshToken: 'synthetic-refresh',
        refreshTokenExpiresAt: 1000,
      };
    }
    throw new Error(`Unexpected component function ${name}`);
  }
  ctx.runQuery = dispatch;
  ctx.runMutation = dispatch;
  async function call(fn, args) {
    const snapshots = [keys, names, bindings, tickets, sessions, registrations, confirmations].map(value =>
      structuredClone(value),
    );
    try {
      return await s.transaction(() => fn._handler(ctx, args));
    } catch (error) {
      for (const [index, value] of [
        keys,
        names,
        bindings,
        tickets,
        sessions,
        registrations,
        confirmations,
      ].entries()) {
        const saved = snapshots[index];
        if (Array.isArray(value)) value.splice(0, value.length, ...saved);
        else {
          value.clear();
          for (const item of saved) value instanceof Set ? value.add(item) : value.set(...item);
        }
      }
      throw error;
    }
  }
  async function ticket(state, id = 123, code = 'synthetic-ticket') {
    const encryptedPayload = await encryptTicketPayload(
      code,
      JSON.stringify({
        userInfoResponses: {
          user: { id, login: 'synthetic', name: null, avatar_url: 'https://example.com/avatar' },
          emails: [],
        },
      }),
    );
    tickets.set(await digest(code), { stateHash: await digest(state), encryptedPayload });
    return { code, state };
  }
  return {
    ...s,
    ctx,
    call,
    owner,
    sessions,
    keys,
    names,
    bindings,
    tickets,
    ticket,
    identity: value => (identity = value),
    legacy: () => (identity = { subject: owner, issuer: values.CLERK_JWT_ISSUER_DOMAIN, sid: 'old-session' }),
    wrongPasskey: () => (assertionOwner = 'other'),
    failBinding: () => (failBinding = true),
  };
}
