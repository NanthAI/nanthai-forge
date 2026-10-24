// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { handleBase, handleError, uniqueUrlName, reservedHandles } from '../dist/readable-urls.js';
import * as routes from '../dist/project-routes.js';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const accounts = await import(moduleUrl('../convex/urlAccounts.ts'));
const projects = await import(moduleUrl('../convex/urlProjects.ts'));
const identity = await import(moduleUrl('../convex/urlIdentity.ts'));
const backfill = await import(moduleUrl('../convex/urlsBackfill.ts'));
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const base = 'https://forge.example/';
function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('p1', {
    _id: 'p1',
    _creationTime: 1,
    owner: 'owner',
    name: 'Forge',
    key: 'key1',
    currentBackup: null,
    revision: 0,
  });
  return s;
}
test('handles derive from username then names, never email, validate length and reserve route roots', async () => {
  assert.equal(handleBase({ username: 'Dino', firstName: 'Other' }, 'abcdef'), 'dino');
  assert.equal(handleBase({ firstName: 'José', lastName: 'Smith' }, 'abcdef'), 'jose-smith');
  assert.equal(handleBase({ username: 'dino@example.org', firstName: '' }, 'abcdef'), 'user-abcdef');
  for (const value of ['a', '-abc', 'abc-', 'Aaa', 'a_b', 'a'.repeat(40), ...reservedHandles])
    assert.ok(handleError(value), value);
  assert.equal(handleError('a1'), null);
  assert.equal(handleError('a'.repeat(39)), null);
  assert.equal(await uniqueUrlName('dino', async value => ['dino', 'dino-2'].includes(value), 39), 'dino-3');
});
test('account handle changes reserve aliases, reject clashes and replay original operations', async () => {
  const s = fixture();
  const account = await identity.ensureAccount(s.ctx, 'owner', { username: 'Dino' });
  assert.equal(account.handle, 'dino');
  assert.equal((await identity.ensureAccount(s.ctx, 'other', { username: 'DINO' })).handle, 'dino-2');
  const input = { operationId: 'rename', handle: 'dino-new' };
  await accounts.set._handler(s.ctx, input);
  await accounts.set._handler(s.ctx, input);
  assert.equal(s.tables.handleOperations.size, 1);
  assert.equal((await identity.accountFor(s.ctx, 'owner')).handle, 'dino-new');
  assert.ok([...s.tables.accountHandles.values()].some(a => a.handle === 'dino'));
  await assert.rejects(
    accounts.set._handler(s.ctx, { ...input, handle: 'other' }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
  s.caller('other');
  assert.equal(await accounts.available._handler(s.ctx, { handle: 'dino' }), 'This handle is already taken.');
  await assert.rejects(accounts.set._handler(s.ctx, { operationId: 'clash', handle: 'dino' }));
  for (const handle of ['settings', '-bad', 'a'])
    await assert.rejects(accounts.set._handler(s.ctx, { operationId: handle, handle }));
});
test('cursor backfill is idempotent and assigns owner-scoped slug clashes', async () => {
  const s = fixture();
  s.tables.hostedProjects.set('p2', { ...s.tables.hostedProjects.get('p1'), _id: 'p2', key: 'key2' });
  const input = { cursor: null, profiles: [{ owner: 'owner', username: 'Dino' }] };
  const page = await backfill.page._handler(s.ctx, input);
  assert.equal(page.isDone, true);
  assert.equal(s.tables.hostedProjects.get('p1').slug, 'forge');
  assert.equal(s.tables.hostedProjects.get('p2').slug, 'forge-2');
  await backfill.page._handler(s.ctx, input);
  assert.equal(s.tables.projectSlugs.size, 2);
  assert.equal(s.tables.forgeAccounts.size, 1);
});
test('old root, Lane, View and file+line links redirect to canonical current handles/slugs', async () => {
  const s = fixture();
  await identity.ensureAccount(s.ctx, 'owner', { username: 'Dino' });
  await identity.ensureProjectSlug(s.ctx, s.tables.hostedProjects.get('p1'));
  await lifecycle.rename._handler(s.ctx, {
    projectId: 'p1',
    operationId: 'rename-project',
    expectedRevision: 0,
    name: 'New Forge',
    slug: 'new-forge',
  });
  await accounts.set._handler(s.ctx, { operationId: 'rename-owner', handle: 'dino-new' });
  for (const old of [
    { handle: 'user_old', slug: 'forge~p1' },
    { handle: 'dino', slug: 'forge' },
    { handle: 'DINO', slug: 'FORGE' },
  ]) {
    const resolved = await projects.resolve._handler(s.ctx, old);
    assert.deepEqual(resolved, { id: 'p1', handle: 'dino-new', slug: 'new-forge', name: 'New Forge' });
    routes.projectIdentity(resolved.id, resolved.handle, resolved.name, resolved.slug, old);
    routes.routeMode('hosted');
    for (const tail of ['', '/lanes/lane-id', '/views/view-id', '/code/src/file.ts?head=save&line=18#L18']) {
      const href = `/${old.handle}/${old.slug}${tail}`;
      const result = routes.cleanUrl(href, base);
      const redirected = new URL(result, base),
        original = new URL(href, base);
      assert.equal(
        redirected.pathname,
        '/dino-new/new-forge' +
          original.pathname
            .split('/')
            .slice(3)
            .map(v => '/' + v)
            .join(''),
      );
      for (const [key, value] of original.searchParams) assert.equal(redirected.searchParams.get(key), value);
      assert.equal(redirected.hash, original.hash);
    }
  }
  assert.equal(await identity.slugTaken(s.ctx, 'owner', 'forge', 'p2'), true);
  assert.equal(await identity.slugTaken(s.ctx, 'other', 'forge'), false);
  await assert.rejects(
    lifecycle.rename._handler(s.ctx, {
      projectId: 'p1',
      operationId: 'changed',
      expectedRevision: 1,
      name: 'Oops',
      slug: 'bad/slug',
    }),
  );
});
test('private missing and forbidden routes return the same null, including aliases and old IDs', async () => {
  const s = fixture();
  await backfill.page._handler(s.ctx, { cursor: null, profiles: [{ owner: 'owner', username: 'dino' }] });
  for (const caller of ['stranger', undefined]) {
    s.caller(caller);
    for (const input of [
      { handle: 'dino', slug: 'forge' },
      { handle: 'user_old', slug: 'old~p1' },
      { projectId: 'p1' },
      { handle: 'missing', slug: 'none' },
    ])
      assert.equal(await projects.resolve._handler(s.ctx, input), null);
  }
  s.caller('reader');
  s.tables.projectReaders.set('r1', { _id: 'r1', projectId: 'p1', reader: 'reader' });
  assert.equal((await projects.resolve._handler(s.ctx, { handle: 'dino', slug: 'forge' })).id, 'p1');
  s.tables.projectReaders.clear();
  assert.equal(await projects.resolve._handler(s.ctx, { handle: 'dino', slug: 'forge' }), null);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'revoked' });
  await assert.rejects(
    projects.resolve._handler(s.ctx, { projectId: 'p1' }),
    e => e.data.code === 'AUTH_REVOKED',
  );
  await assert.rejects(
    accounts.set._handler(s.ctx, { operationId: 'revoked', handle: 'new-handle' }),
    e => e.data.code === 'AUTH_REVOKED',
  );
});
test('web delegates URL construction to the shared codec without id-suffixed builders', () => {
  function files(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    );
  }
  for (const path of files(new URL('../web/src', import.meta.url).pathname).filter(path =>
    /\.[jt]sx?$/.test(path),
  )) {
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      text,
      /(?:slug\([^)]*\)|project\.name)\s*\+\s*['"]~|~\$\{(?:project|id)|\/user_\$\{/,
      path,
    );
  }
});

test('backfill action pages Clerk accounts before projects, omits emails, and fails without partial mutation on provider errors', async t => {
  const s = fixture();
  const { getFunctionName } = await import('convex/server');
  s.ctx.runQuery = (reference, args) =>
    backfill[getFunctionName(reference).split(':')[1]]._handler(s.ctx, args);
  s.ctx.runMutation = s.ctx.runQuery;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CLERK_SECRET_KEY;
  process.env.CLERK_SECRET_KEY = 'synthetic-key';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = originalKey;
  });
  globalThis.fetch = async url => {
    const person = {
      id: 'owner',
      username: 'Dino',
      email_addresses: [{ email_address: 'never-use@example.invalid' }],
    };
    return new Response(
      JSON.stringify(
        String(url).includes('?') ? [person, { id: 'no-projects', first_name: 'Maya' }] : person,
      ),
    );
  };
  const first = await backfill.run._handler(s.ctx, { cursor: null });
  assert.deepEqual(first, { cursor: 'projects:', isDone: false });
  assert.equal(s.tables.forgeAccounts.size, 2);
  assert.equal((await identity.accountFor(s.ctx, 'no-projects')).handle, 'maya');
  assert.ok(!JSON.stringify([...s.tables.forgeAccounts]).includes('example.invalid'));
  assert.equal((await backfill.run._handler(s.ctx, { cursor: first.cursor })).isDone, true);
  await backfill.run._handler(s.ctx, { cursor: null });
  assert.equal(s.tables.forgeAccounts.size, 2);
  const before = JSON.stringify([...s.tables.forgeAccounts]);
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  await assert.rejects(backfill.run._handler(s.ctx, { cursor: null }));
  assert.equal(JSON.stringify([...s.tables.forgeAccounts]), before);
  await assert.rejects(backfill.run._handler(s.ctx, { cursor: 'accounts:NaN' }));
  await assert.rejects(backfill.run._handler(s.ctx, { cursor: 'unknown' }));
});

test('Profile deep links are classified as Settings by both hosted consumers', async () => {
  const shell = await import(moduleUrl('../web/src/shell/route.ts'));
  assert.equal(shell.hostedTab('you'), 'settings');
  const work = readFileSync(new URL('../web/src/HostedWork.tsx', import.meta.url), 'utf8');
  assert.equal((work.match(/'you'/g) ?? []).length, 2);
});
