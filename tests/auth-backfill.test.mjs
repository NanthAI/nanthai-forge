// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionAddress } from 'convex/server';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { backfill } from '../scripts/auth-backfill.mjs';

const store = await import(moduleUrl('../convex/authBackfillStore.ts'));
const read = await import(moduleUrl('../convex/authBackfill.ts'));
const users = await import(moduleUrl('../convex/authUsers.ts'));
const tokenStore = await import(moduleUrl('../convex/githubUserTokens.ts'));
const tokenActions = await import(moduleUrl('../convex/githubUserTokenActions.ts'));
const refused = code => error => (error.data?.code ?? error.code) === code;
const method = id => ({
  name: 'github',
  profile: {
    id,
    login: 'synthetic',
    email: 'same@example.com',
    emailVerified: true,
  },
});

function fixture(count = 2) {
  const s = state();
  const ctx = { ...s.ctx };
  s.tables.users = new Map();
  const bindings = new Map();
  for (let i = 0; i < count; i++) {
    s.tables.forgeAccounts.set(`a${i}`, {
      _id: `a${i}`,
      _creationTime: i,
      owner: `user_synthetic${i}`,
      handle: `synthetic-${i}`,
    });
    s.tables.hostedProjects.set(`p${i}`, {
      _id: `p${i}`,
      _creationTime: i,
      owner: `user_synthetic${i}`,
      key: `synthetic-${i}`,
      name: 'Synthetic project',
      visibility: 'private',
    });
    s.tables.projectContributors.set(`grant${i}`, {
      _id: `grant${i}`,
      _creationTime: i,
      projectId: `p${i}`,
      contributor: 'user_peer',
    });
  }
  ctx.runQuery = async (ref, args) => {
    const address = getFunctionAddress(ref);
    if (address.reference?.endsWith('/getUserIdByAccount'))
      return bindings.get(args.providerAccountId) ?? null;
    if (address.name === 'authBackfill:accountsPage') return read.accountsPage._handler(ctx, args);
    if (address.name === 'githubUserTokens:read') return tokenStore.read._handler(ctx, args);
    throw new Error('Unexpected query');
  };
  ctx.runMutation = async (ref, args) => {
    assert.ok(getFunctionAddress(ref).reference.endsWith('/_internal_dangerous_createAccount'));
    assert.equal(bindings.has(args.providerAccountId), false);
    bindings.set(args.providerAccountId, args.userId);
    return null;
  };
  const entries = Array.from({ length: count }, (_, i) => ({
    accountKey: `user_synthetic${i}`,
    githubId: String(100 + i),
    ambiguous: false,
  }));
  return { ...s, ctx, bindings, entries };
}

test('backfill preserves account keys and project ownership, binds by numeric id and replays with no writes', async () => {
  const s = fixture();
  const projects = structuredClone([...s.tables.hostedProjects]);
  const permissions = structuredClone([...s.tables.projectContributors]);
  const args = { entries: s.entries, apply: false };
  assert.deepEqual(await store.batch._handler(s.ctx, args), {
    matched: 2,
    conflicts: 0,
    userWrites: 2,
    accountWrites: 2,
  });
  assert.equal(s.tables.users.size, 0);
  assert.equal(s.bindings.size, 0);
  assert.equal(await tokenActions.githubUserToken(s.ctx, s.entries[0].accountKey), null);
  await store.batch._handler(s.ctx, { ...args, apply: true });
  assert.equal(await tokenActions.githubUserToken(s.ctx, s.entries[0].accountKey), null);
  for (const entry of s.entries) {
    const id = await users.createGithub._handler(s.ctx, { method: method(entry.githubId) });
    assert.equal(s.bindings.get(entry.githubId), id);
    assert.equal(s.tables.users.get(id).accountKey, entry.accountKey);
    await users.signedInGithub._handler(s.ctx, { userId: id, method: method(entry.githubId) });
  }
  assert.deepEqual(await store.batch._handler(s.ctx, { ...args, apply: true }), {
    matched: 2,
    conflicts: 0,
    userWrites: 0,
    accountWrites: 0,
  });
  assert.deepEqual([...s.tables.hostedProjects], projects);
  assert.deepEqual([...s.tables.projectContributors], permissions);
  assert.equal(await store.seeded._handler(s.ctx, { handle: 'synthetic-0' }), true);
  const fresh = await users.createGithub._handler(s.ctx, { method: method('999') });
  assert.equal(s.tables.users.get(fresh).accountKey, `user_${fresh}`);
});

test('two accounts claiming one GitHub id fail closed in both new and pre-bound sign-in callbacks', async () => {
  const s = fixture();
  const first = s.entries[0];
  await store.batch._handler(s.ctx, { entries: [first], apply: true });
  const bound = s.bindings.get(first.githubId);
  const entries = s.entries.map(row => ({ ...row, githubId: first.githubId, ambiguous: true }));
  const result = await store.batch._handler(s.ctx, { entries, apply: true });
  assert.equal(result.conflicts, 2);
  assert.equal(result.accountWrites, 0);
  assert.equal(s.bindings.get(first.githubId), bound);
  const typedConflict = error =>
    error instanceof ConvexError && error.data.code === 'GITHUB_ACCOUNT_MISMATCH';
  await assert.rejects(users.createGithub._handler(s.ctx, { method: method(first.githubId) }), typedConflict);
  await assert.rejects(
    users.signedInGithub._handler(s.ctx, { userId: bound, method: method(first.githubId) }),
    typedConflict,
  );
  assert.equal(await store.seeded._handler(s.ctx, { handle: 'synthetic-0' }), false);
});

test('a conflicting existing user or provider binding is retained rather than reassigned', async () => {
  const s = fixture();
  s.bindings.set('100', 'another-user');
  let result = await store.batch._handler(s.ctx, { entries: s.entries, apply: true });
  assert.equal(result.conflicts, 1);
  assert.equal(s.bindings.get('100'), 'another-user');
  const current = [...s.tables.users.values()].find(row => row.accountKey === s.entries[0].accountKey);
  current.githubId = '777';
  result = await store.batch._handler(s.ctx, { entries: [s.entries[0]], apply: true });
  assert.equal(result.conflicts, 1);
  assert.equal(current.githubId, '777');
});

test('an ambiguous claim remains refused even before the other account is seeded', async () => {
  const s = fixture(1);
  const entry = { ...s.entries[0], ambiguous: true };
  await store.batch._handler(s.ctx, { entries: [entry], apply: true });
  assert.equal(s.bindings.size, 0);
  await assert.rejects(
    users.createGithub._handler(s.ctx, { method: method(entry.githubId) }),
    error => error instanceof ConvexError && error.data.code === 'GITHUB_ACCOUNT_MISMATCH',
  );
  assert.equal((await store.batch._handler(s.ctx, { entries: [entry], apply: true })).userWrites, 0);
});

test('changed discovery pages stop before applying identities from a stale duplicate count', async () => {
  let reads = 0;
  const run = async name => {
    assert.equal(name, 'authBackfill:readPage');
    return {
      entries: [
        { accountKey: 'user_synthetic', handle: 'synthetic', githubIds: [++reads === 1 ? '123' : '456'] },
      ],
      cursor: 'done',
      isDone: true,
    };
  };
  await assert.rejects(
    backfill(run, { apply: true }, () => {}),
    /identities changed/,
  );
});

test('discovery trusts only verified numeric linked identities and uses one filtered provider page', async t => {
  const s = fixture(4);
  const oldKey = process.env.CLERK_SECRET_KEY;
  process.env.CLERK_SECRET_KEY = 'synthetic-secret';
  t.after(() =>
    oldKey === undefined ? delete process.env.CLERK_SECRET_KEY : (process.env.CLERK_SECRET_KEY = oldKey),
  );
  const oldFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = oldFetch));
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.getAll('user_id').length, 4);
    const external = (id, status) => [
      { provider: 'oauth_github', provider_user_id: id, verification: { status } },
    ];
    return new Response(
      JSON.stringify([
        { id: 'user_synthetic0', external_accounts: external('100', 'verified') },
        { id: 'user_synthetic1', external_accounts: external('101', 'unverified') },
        { id: 'user_synthetic2', external_accounts: external('not-a-number', 'verified') },
        { id: 'user_synthetic3', external_accounts: external(103, 'verified') },
      ]),
    );
  };
  const page = await read.readPage._handler(s.ctx, { cursor: null });
  assert.deepEqual(
    page.entries.map(row => row.githubIds),
    [['100'], [], [], []],
  );
  assert.equal(calls, 1);
  assert.equal(s.tables.users.size, 0);
  globalThis.fetch = async () => new Response(JSON.stringify([{ id: 'user_another' }]));
  await assert.rejects(read.readPage._handler(s.ctx, { cursor: null }), refused('GITHUB_RESPONSE'));
  globalThis.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(read.readPage._handler(s.ctx, { cursor: null }), refused('GITHUB_UNAVAILABLE'));
});

test('paged discovery finds cross-page conflicts, lists unmatched handles only, and resumes after a lost reply', async () => {
  const s = fixture(60);
  const report = [];
  let fail = false;
  const run = async (name, args) => {
    if (name === 'authBackfill:readPage') {
      const page = await read.accountsPage._handler(s.ctx, args);
      return {
        ...page,
        entries: page.entries.map(row => ({
          ...row,
          githubIds:
            row.handle === 'synthetic-2'
              ? []
              : [row.handle === 'synthetic-59' ? '100' : String(100 + Number(row.handle.slice(10)))],
        })),
      };
    }
    const result = await store.batch._handler(s.ctx, args);
    if (fail && args.apply) {
      fail = false;
      throw new Error('Lost reply');
    }
    return result;
  };
  const preview = await backfill(run, {}, line => report.push(JSON.parse(line)));
  assert.equal(preview.accounts, 60);
  assert.equal(preview.matched, 57);
  assert.equal(preview.conflicts, 2);
  assert.equal(preview.unmatched, 1);
  assert.deepEqual(
    report.find(row => row.unmatched),
    { unmatched: 'synthetic-2' },
  );
  assert.equal(s.tables.users.size, 0);
  fail = true;
  await assert.rejects(
    backfill(run, { apply: true }, () => {}),
    /Lost reply/,
  );
  const firstPage = await read.accountsPage._handler(s.ctx, { cursor: null });
  const resumed = await backfill(run, { apply: true, cursor: firstPage.cursor }, () => {});
  assert.equal(resumed.accounts, 35);
  const repeated = await backfill(run, { apply: true }, () => {});
  assert.equal(repeated.userWrites, 0);
  assert.equal(repeated.accountWrites, 0);
  assert.equal(s.tables.users.size, 59);
  assert.equal(s.bindings.has('100'), false);
  assert.ok(report.every(row => !JSON.stringify(row).includes('user_synthetic')));
});
