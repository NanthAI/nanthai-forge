// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { job, state, providers } from './hosted-fixture.mjs';
import { fixture, git } from './helpers.mjs';
import { analyze } from '../dist/analyze.js';
import { capture } from '../dist/snapshot.js';
import { encodeHostedArtifact } from '../dist/hosted-artifact.js';
const teams = await import(moduleUrl('../convex/teams.ts')),
  actions = await import(moduleUrl('../convex/teamActions.ts'));
const hosted = await import(moduleUrl('../convex/hosted.ts')),
  sharing = await import(moduleUrl('../convex/sharing.ts'));
const saved = await import(moduleUrl('../convex/savedViews.ts')),
  lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const download = await import(moduleUrl('../convex/lifecycleActions.ts'));
const paginationOpts = { cursor: null, numItems: 20 },
  denied = e => (e.data?.code ?? e.code) === 'GITHUB_UNAVAILABLE';
const make = s =>
  teams.create._handler(s.ctx, { name: 'Team <img src=x onerror=untrusted>', operationId: randomUUID() });
const link = (s, id, importId = 'own', shared = true) => teams.link._handler(s.ctx, { id, importId, shared });
const add = (s, id, member = 'reader') => actions.addMember._handler(s.ctx, { id, member });
const list = (s, id, page = paginationOpts) =>
  actions.codescapes._handler(s.ctx, { id, paginationOpts: page });

test('reader teams reconcile creation/membership/import links and keep creator authority and membership metadata private', async () => {
  const s = state([job(), { ...job('other'), owner: 'other' }, { ...job('public'), visibility: 'public' }]),
    cleanup = providers();
  try {
    s.caller(undefined);
    await assert.rejects(make(s), denied);
    assert.deepEqual((await teams.list._handler(s.ctx, { paginationOpts })).page, []);
    s.caller('owner');
    const operationId = randomUUID(),
      input = { name: 'Engineering', operationId };
    const id = await teams.create._handler(s.ctx, input);
    assert.equal(await teams.create._handler(s.ctx, input), id);
    assert.equal(s.tables.teams.size, 1);
    await assert.rejects(
      teams.create._handler(s.ctx, { ...input, operationId: 'invalid' }),
      e => e.data.code === 'BAD_ARGUMENT',
    );
    await assert.rejects(
      teams.create._handler(s.ctx, { name: ' ', operationId: randomUUID() }),
      e => e.data.code === 'BAD_ARGUMENT',
    );
    await assert.rejects(add(s, id, 'missing'), e => e.data.code === 'BAD_ARGUMENT');
    await add(s, id, ' reader ');
    await add(s, id);
    await add(s, id, 'owner');
    assert.equal(s.tables.teamMembers.size, 2);
    await link(s, id);
    await link(s, id);
    assert.equal(s.tables.teamImports.size, 1);
    await assert.rejects(link(s, id, 'other'), denied);
    await assert.rejects(link(s, id, 'public'), denied);
    s.caller('reader');
    assert.equal((await teams.list._handler(s.ctx, { paginationOpts })).page[0].name, 'Engineering');
    await assert.rejects(teams.members._handler(s.ctx, { id, paginationOpts }), denied);
    await assert.rejects(add(s, id, 'new'), denied);
    await assert.rejects(link(s, id), denied);
    await assert.rejects(teams.removeMember._handler(s.ctx, { id, member: 'owner' }), denied);
    s.caller('stranger');
    assert.deepEqual((await teams.list._handler(s.ctx, { paginationOpts })).page, []);
    await assert.rejects(list(s, id), denied);
    s.caller('owner');
    await teams.removeMember._handler(s.ctx, { id, member: 'reader' });
    await teams.removeMember._handler(s.ctx, { id, member: 'reader' });
    s.caller('reader');
    await assert.rejects(list(s, id), denied);
    assert.deepEqual((await teams.list._handler(s.ctx, { paginationOpts })).page, []);
    s.caller('owner');
    await link(s, id, 'own', false);
    await link(s, id, 'own', false);
    assert.equal(s.tables.teamImports.size, 0);
  } finally {
    cleanup();
  }
});

test('team source/graph/export/saved views require membership, an active link and both current GitHub entitlements, rechecked after provider calls', async t => {
  const root = fixture(t, { 'a.ts': 'export const teamSecret = 7;\n', 'README.md': '# Team snapshot\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Synthetic private team source']);
  const captured = capture(root),
    pack = analyze(captured),
    s = state([{ ...job(), head: captured.source.gitHead }]);
  const blob = await encodeHostedArtifact({
    pack,
    content: Object.fromEntries(captured.content),
    documents: { 'README.md': '# Team snapshot\n' },
    repository: {},
  });
  s.file('saved', blob);
  let revoked,
    removeDuringRead = false,
    unlinkDuringRead = false;
  const cleanup = providers(
    user => {
      if (user === 'owner') {
        if (removeDuringRead)
          for (const [id, row] of s.tables.teamMembers)
            if (row.member === 'reader') s.tables.teamMembers.delete(id);
        if (unlinkDuringRead) s.tables.teamImports.clear();
      }
      return user === revoked;
    },
    true,
    captured.source.gitHead,
  );
  const read = endpoint => hosted.read._handler(s.ctx, { id: 'own', endpoint });
  const part = () => download.downloadPart._handler(s.ctx, { id: 'own', offset: 0 });
  try {
    const id = await make(s);
    await add(s, id);
    await link(s, id);
    s.caller('reader');
    for (const endpoint of [
      'status',
      'files',
      'source?file=a.ts',
      'context?search=teamSecret',
      'readme',
      'imports?file=a.ts',
    ])
      assert.equal(typeof (await read(endpoint)), 'string');
    assert.deepEqual(Buffer.from((await part()).data), Buffer.from(await blob.arrayBuffer()));
    assert.equal((await list(s, id)).page.length, 1);
    const route = { view: 'source', state: captured.source.id, file: 'a.ts', line: 1 };
    const savedId = await saved.put._handler(s.ctx, {
      importId: 'own',
      operationId: randomUUID(),
      name: 'Team context',
      route,
    });
    assert(s.tables.savedViews.has(savedId));
    await assert.rejects(hosted.refresh._handler(s.ctx, { id: 'own' }), denied);
    await assert.rejects(lifecycle.trash._handler(s.ctx, { id: 'own' }), denied);
    for (revoked of ['owner', 'reader']) {
      const before = s.reads();
      await assert.rejects(read('files'), denied);
      await assert.rejects(part(), denied);
      assert.equal(s.reads(), before);
      assert.deepEqual((await list(s, id)).page, []);
    }
    revoked = undefined;
    removeDuringRead = true;
    let before = s.reads();
    await assert.rejects(read('source?file=a.ts'), denied);
    assert.equal(s.reads(), before);
    removeDuringRead = false;
    s.caller('owner');
    await add(s, id);
    s.caller('reader');
    unlinkDuringRead = true;
    before = s.reads();
    await assert.rejects(part(), denied);
    assert.equal(s.reads(), before);
    unlinkDuringRead = false;
    s.caller('owner');
    await link(s, id);
    await sharing.add._handler(s.ctx, { id: 'own', owner: 'owner', reader: 'reader' });
    s.caller('reader');
    unlinkDuringRead = true;
    assert.deepEqual(
      (await list(s, id)).page,
      [],
      'A separate named grant does not keep a removed team link visible.',
    );
    assert.equal(
      typeof (await read('files')),
      'string',
      'Independent direct reader access remains available.',
    );
    unlinkDuringRead = false;
    s.caller('owner');
    await sharing.remove._handler(s.ctx, { id: 'own', reader: 'reader' });
    s.caller('reader');
    await assert.rejects(
      saved.put._handler(s.ctx, { importId: 'own', operationId: randomUUID(), name: 'Denied', route }),
      denied,
    );
    assert.equal(
      (await saved.list._handler(s.ctx, { paginationOpts })).page.length,
      1,
      'Existing source-free bookmarks retain their owner cleanup capability.',
    );
  } finally {
    cleanup();
  }
});

test('team/member/import pagination preserves all choices, Trash hides readers and purge removes only the deleted import links', async () => {
  const s = state(Array.from({ length: 41 }, (_, i) => job(`import-${i}`))),
    cleanup = providers();
  try {
    const id = await make(s);
    await add(s, id);
    for (const row of s.tables.imports.values()) await link(s, id, row._id);
    for (let i = 0; i < 22; i++) await add(s, id, `reader-${i}`);
    const firstMembers = await teams.members._handler(s.ctx, { id, paginationOpts });
    const secondMembers = await teams.members._handler(s.ctx, {
      id,
      paginationOpts: { ...paginationOpts, cursor: firstMembers.continueCursor },
    });
    assert.equal(firstMembers.page.length, 20);
    assert.equal(secondMembers.page.length, 4);
    s.caller('reader');
    const a = await list(s, id),
      b = await list(s, id, { ...paginationOpts, cursor: a.continueCursor }),
      c = await list(s, id, { ...paginationOpts, cursor: b.continueCursor });
    assert.equal(a.page.length, 20);
    assert.equal(b.page.length, 20);
    assert.equal(c.page.length, 1);
    assert.equal(c.isDone, true);
    s.caller('owner');
    await lifecycle.trash._handler(s.ctx, { id: 'import-0' });
    s.caller('reader');
    await assert.rejects(hosted.status._handler(s.ctx, { id: 'import-0' }), denied);
    s.caller('owner');
    for (let i = 0; i < 53; i++) {
      const team = await make(s);
      await link(s, team, 'import-1');
    }
    await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'import-1' });
    for (let i = 0; i < s.scheduled.length; i++) await lifecycle.purge._handler(s.ctx, s.scheduled[i].args);
    assert.equal(s.tables.imports.has('import-1'), false);
    assert(![...s.tables.teamImports.values()].some(row => row.importId === 'import-1'));
    assert([...s.tables.teamImports.values()].some(row => row.importId === 'import-2'));
    const first = await teams.list._handler(s.ctx, { paginationOpts });
    const second = await teams.list._handler(s.ctx, {
      paginationOpts: { ...paginationOpts, cursor: first.continueCursor },
    });
    assert.equal(first.page.length, 20);
    assert.equal(second.page.length, 20);
    assert('pageStatus' in first);
    s.caller(undefined);
    assert.deepEqual((await teams.list._handler(s.ctx, { paginationOpts })).page, []);
    assert.equal(s.reads(), 0);
  } finally {
    cleanup();
  }
});

test('team email entry and account labels preserve owner authorization and recheck membership after lookup', async () => {
  const s = state([]),
    cleanup = providers();
  const id = await make(s),
    originalFetch = globalThis.fetch;
  let remove = false,
    calls = 0;
  globalThis.fetch = async url => {
    calls++;
    if (remove) s.tables.teams.delete(id);
    const address = new URL(String(url));
    if (address.searchParams.has('email_address'))
      return Response.json([
        { id: 'reader', email_addresses: [{ email_address: 'reader@example.com' }], first_name: 'Reader' },
      ]);
    return Response.json({
      id: decodeURIComponent(address.pathname.split('/').at(-1)),
      first_name: 'Team member',
    });
  };
  try {
    s.caller('stranger');
    await assert.rejects(actions.addByEmail._handler(s.ctx, { id, email: 'reader@example.com' }), denied);
    assert.equal(calls, 0);
    s.caller('owner');
    await actions.addByEmail._handler(s.ctx, { id, email: 'reader@example.com' });
    assert.equal(s.tables.teamMembers.size, 2);
    const labels = await actions.labels._handler(s.ctx, { id, paginationOpts });
    assert.equal(labels.page.length, 2);
    assert.equal(labels.page[0].label, 'Team member');
    s.caller('reader');
    await assert.rejects(actions.labels._handler(s.ctx, { id, paginationOpts }), denied);
    s.caller('owner');
    remove = true;
    await assert.rejects(actions.labels._handler(s.ctx, { id, paginationOpts }), denied);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});
