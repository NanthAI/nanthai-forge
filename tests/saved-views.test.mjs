// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { setup as r2Setup } from './r2-harness.mjs';
import { job, providers } from './hosted-fixture.mjs';
import { fixture, git } from './helpers.mjs';
import { capture } from '../dist/snapshot.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../dist/analyze.js';
import { encodeHostedArtifact } from '../dist/hosted-artifact.js';
const views = await import(moduleUrl('../convex/savedViews.ts'));
const actions = await import(moduleUrl('../convex/savedViewActions.ts'));
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const denied = error => error.data.code === 'GITHUB_UNAVAILABLE';
const paginationOpts = { numItems: 20, cursor: null };
async function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n', 'README.md': '# Synthetic saved views\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Saved source candidate']);
  const captured = capture(root),
    pack = analyze(captured);
  const { s } = await r2Setup(t);
  for (const row of [
    { ...job(), head: captured.source.gitHead },
    { ...job('public'), visibility: 'public', owner: '', head: captured.source.gitHead },
  ])
    s.tables.imports.set(row._id, row);
  s.file(
    'saved',
    await encodeHostedArtifact({
      pack,
      content: Object.fromEntries(captured.content),
      documents: { 'README.md': '# Synthetic saved views\n', '.nforge/home.md': '# Private home details\n' },
      repository: {},
    }),
  );
  const route = { view: 'source', file: 'a.ts', line: 1, state: captured.source.id };
  const input = (operationId = 'save-one', patch = {}) => ({
    operationId,
    importId: 'own',
    name: ' My source view ',
    route,
    ...patch,
  });
  const save = args => actions.save._handler(s.ctx, args);
  return {
    root,
    s,
    input,
    save,
    route,
    symbol: pack.nodes.find(node => node.name === 'a').id,
    head: captured.source.gitHead,
  };
}

test('optional saved reference routes retain exact symbol/lens pins and reconcile only the original full route', async t => {
  const { s, input, save, route, symbol, head } = await setup(t),
    cleanup = providers(() => false, true, head);
  try {
    const selected = { ...route, view: 'map', symbol, lens: 'references' },
      request = input('reference-map', { route: selected });
    const id = await save(request);
    assert.equal(await save(request), id);
    assert.deepEqual((await views.list._handler(s.ctx, { paginationOpts })).page[0].route, selected);
    for (const changed of [
      route,
      { ...selected, symbol: 'another' },
      { ...selected, lens: 'imports' },
      { ...selected, symbol: undefined },
      { ...selected, lens: undefined },
    ]) {
      await assert.rejects(save({ ...request, route: changed }), error => error.data.code === 'BAD_ARGUMENT');
      await assert.rejects(
        views.put._handler(s.ctx, { ...request, route: changed }),
        error => error.code === 'BAD_ARGUMENT',
      );
    }
    assert.equal(s.tables.savedViews.size, 1);
    assert.deepEqual(s.tables.savedViews.get(id).route, selected);
    s.caller(undefined);
    await assert.rejects(
      hosted.read._handler(s.ctx, { id: 'own', endpoint: `refs?symbol=${symbol}` }),
      denied,
    );
  } finally {
    cleanup();
  }
});

test('saving uses actual source identity, reconciles lost replies and keeps private named links independent from source/graph ownership', async t => {
  const { root, s, input, save, route, head } = await setup(t),
    cleanup = providers(() => false, true, head);
  try {
    const beforeJob = structuredClone(s.tables.imports.get('own')),
      files = [...s.files.keys()];
    const id = await save(input());
    assert.equal(await save(input()), id);
    assert.equal(s.tables.savedViews.size, 1);
    const row = s.tables.savedViews.get(id);
    assert.equal(row.name, 'My source view');
    assert.deepEqual(row.route, route);
    assert.deepEqual(Object.keys(row).sort(), [
      '_creationTime',
      '_id',
      'importId',
      'name',
      'operationId',
      'owner',
      'route',
    ]);
    assert.deepEqual([...s.files.keys()], files);
    assert.equal(s.tables.importArtifacts.size, 0);
    assert.deepEqual(s.tables.imports.get('own'), {
      ...beforeJob,
      syncRevision: 1,
      sync: { checkedAt: s.tables.imports.get('own').sync.checkedAt, result: 'checked', head },
    });
    await views.rename._handler(s.ctx, { id, name: '<img src=x onerror=untrusted>.ts' });
    const reads = s.reads();
    assert.equal(await save(input()), id);
    assert.equal(s.reads(), reads);
    assert.match(s.tables.savedViews.get(id).name, /<img/);
    await assert.rejects(
      save(input('save-one', { route: { ...route, line: 2 } })),
      error => error.data.code === 'BAD_ARGUMENT',
    );
    await assert.rejects(
      save(input('wrong-source', { route: { ...route, state: '0'.repeat(64) } })),
      error => error.data.code === 'STATE_MISMATCH',
    );
    assert.equal(s.tables.savedViews.size, 1);
    writeFileSync(join(root, 'a.ts'), 'export const a = 2;\n');
    const updated = capture(root);
    s.file(
      'saved',
      await encodeHostedArtifact({
        pack: analyze(updated),
        content: Object.fromEntries(updated.content),
        documents: {},
        repository: {},
      }),
    );
    assert.notEqual(updated.source.id, route.state);
    await assert.rejects(
      hosted.read._handler(s.ctx, { id: 'own', endpoint: `source?file=a.ts&state=${route.state}` }),
      error => error.data.code === 'STATE_MISMATCH',
    );
    assert.deepEqual(
      (await views.list._handler(s.ctx, { paginationOpts })).page[0].route,
      route,
      'Publishing another source artifact does not repin saved links.',
    );
  } finally {
    cleanup();
  }
});

test('anonymous/other-owner saves and management are isolated; named readers need both current GitHub entitlements and their grant', async t => {
  const { s, input, save, head } = await setup(t);
  let revoked;
  const cleanup = providers(user => user === revoked, true, head);
  try {
    for (const caller of [undefined, 'other']) {
      s.caller(caller);
      await assert.rejects(save(input()), denied);
      assert.deepEqual((await views.list._handler(s.ctx, { paginationOpts })).page, []);
    }
    for (const caller of [undefined, 'other']) {
      s.caller(caller);
      await assert.rejects(hosted.read._handler(s.ctx, { id: 'own', endpoint: 'home' }), denied);
    }
    assert.equal(s.reads(), 0);
    s.caller('owner');
    assert.match(
      JSON.parse(await hosted.read._handler(s.ctx, { id: 'own', endpoint: 'home' })).text,
      /Private home details/,
    );
    const ownId = await save(input());
    s.caller('other');
    await assert.rejects(views.rename._handler(s.ctx, { id: ownId, name: 'Steal' }), denied);
    await views.remove._handler(s.ctx, { id: ownId });
    assert(s.tables.savedViews.has(ownId));
    s.tables.importReaders.set('grant', { _id: 'grant', importId: 'own', reader: 'reader' });
    s.caller('reader');
    assert.match(
      JSON.parse(await hosted.read._handler(s.ctx, { id: 'own', endpoint: 'home' })).text,
      /Private home details/,
    );
    const readerId = await save(input('reader-save'));
    assert.notEqual(readerId, ownId);
    const page = await views.list._handler(s.ctx, { paginationOpts });
    assert.deepEqual(
      page.page.map(item => item.id),
      [readerId],
    );
    for (revoked of ['owner', 'reader']) {
      const before = s.reads();
      await assert.rejects(save(input(`new-${revoked}`)), denied);
      assert.equal(s.reads(), before);
    }
    revoked = undefined;
    s.tables.importReaders.clear();
    await assert.rejects(save(input('removed-grant')), denied);
    s.tables.importReaders.set('grant', { _id: 'grant', importId: 'own', reader: 'reader' });
    const previousMutation = s.ctx.runMutation;
    s.ctx.runMutation = (fn, args) => {
      if (args.operationId === 'racing-grant') s.tables.importReaders.clear();
      return previousMutation(fn, args);
    };
    await assert.rejects(save(input('racing-grant')), denied);
    assert.equal(s.tables.savedViews.size, 2);
  } finally {
    cleanup();
  }
});

test('revocation/removal preserves owner metadata cleanup while saved links grant no subsequent source access', async t => {
  const { s, input, save, head } = await setup(t);
  let revoked = false;
  const cleanup = providers(() => revoked, true, head);
  try {
    const id = await save(input());
    revoked = true;
    const before = s.reads();
    assert.equal(
      await save(input()),
      id,
      'A lost successful save reply reconciles source-free owner metadata.',
    );
    await assert.rejects(hosted.read._handler(s.ctx, { id: 'own', endpoint: 'source?file=a.ts' }), denied);
    await assert.rejects(hosted.read._handler(s.ctx, { id: 'own', endpoint: 'home' }), denied);
    assert.equal(s.reads(), before);
    assert.equal((await views.list._handler(s.ctx, { paginationOpts })).page.length, 1);
    await views.rename._handler(s.ctx, { id, name: 'Still my private link' });
    s.tables.imports.delete('own');
    assert.equal(
      (await views.list._handler(s.ctx, { paginationOpts })).page[0].name,
      'Still my private link',
    );
    await assert.rejects(hosted.status._handler(s.ctx, { id: 'own' }), denied);
    await views.remove._handler(s.ctx, { id });
    await views.remove._handler(s.ctx, { id });
    assert.equal(s.tables.savedViews.size, 0);
    s.caller(undefined);
    await assert.rejects(views.remove._handler(s.ctx, { id }), denied);
  } finally {
    cleanup();
  }
});

test('public saves belong to authenticated individuals and paginate without a total quota; malformed route/name inputs do not persist', async t => {
  const { s, input, save, route, head } = await setup(t),
    cleanup = providers(() => false, false, head);
  try {
    for (const patch of [
      { name: ' ' },
      { operationId: '' },
      { route: { ...route, line: 0 } },
      { route: { ...route, line: 1.5 } },
      { route: { ...route, state: '--help' } },
    ]) {
      await assert.rejects(save(input('invalid', patch)), error => error.data.code === 'BAD_ARGUMENT');
    }
    assert.equal(s.tables.savedViews.size, 0);
    const home = await save(input('home-link', { importId: 'public', route: { ...route, view: 'home' } }));
    assert.equal(s.tables.savedViews.get(home).route.view, 'home');
    await views.remove._handler(s.ctx, { id: home });
    for (let i = 0; i < 25; i++)
      await save(
        input(`public-${i}`, {
          importId: 'public',
          name: `Public ${i}`,
          route: { ...route, view: i % 2 ? 'map' : 'readme' },
        }),
      );
    const first = await views.list._handler(s.ctx, { paginationOpts }),
      second = await views.list._handler(s.ctx, {
        paginationOpts: { ...paginationOpts, cursor: first.continueCursor },
      });
    assert.deepEqual(
      Object.keys(first).sort(),
      ['continueCursor', 'isDone', 'page', 'pageStatus', 'splitCursor'],
      'Retain native Convex pagination metadata with the projected owner records.',
    );
    assert.equal(first.page.length, 20);
    assert.equal(first.isDone, false);
    assert.equal(second.page.length, 5);
    assert.equal(second.isDone, true);
    s.caller('other');
    const id = await save(input('public-0', { importId: 'public' }));
    assert.notEqual(id, first.page[0].id);
    assert.deepEqual(
      (await views.list._handler(s.ctx, { paginationOpts })).page.map(row => row.id),
      [id],
    );
    s.caller(undefined);
    assert.equal(JSON.parse(await hosted.status._handler(s.ctx, { id: 'public' })).visibility, 'public');
    assert.deepEqual((await views.list._handler(s.ctx, { paginationOpts })).page, []);
  } finally {
    cleanup();
  }
});
