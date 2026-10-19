import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { job, state, providers } from './hosted-fixture.mjs';
import { fixture, git } from './helpers.mjs';
import { analyze } from '../dist/analyze.js';
import { capture } from '../dist/snapshot.js';
import { encodeHostedArtifact } from '../dist/hosted-artifact.js';
const sharing = await import(moduleUrl('../convex/sharing.ts'));
const sharingActions = await import(moduleUrl('../convex/sharingActions.ts'));
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const lifecycleActions = await import(moduleUrl('../convex/lifecycleActions.ts'));
const paginationOpts = { numItems: 20, cursor: null };
const denied = error => error.data.code === 'GITHUB_UNAVAILABLE';

test('only the importer can manage named existing users; repeated adds/removals reconcile and cleanup preserves other grants', async () => {
  const s = state([job(), { ...job('other'), owner: 'other' }, { ...job('public'), visibility: 'public' }]);
  const cleanup = providers();
  const add = (reader, id = 'own') => sharingActions.add._handler(s.ctx, { id, reader });
  try {
    for (const caller of [undefined, 'reader']) {
      s.caller(caller);
      await assert.rejects(add('reader'), denied);
      assert.deepEqual((await sharing.readers._handler(s.ctx, { id: 'own', paginationOpts })).page, []);
      await assert.rejects(sharing.remove._handler(s.ctx, { id: 'own', reader: 'reader' }), denied);
    }
    s.caller('owner');
    await assert.rejects(add('reader', 'other'), denied);
    await assert.rejects(add('reader', 'public'), denied);
    await assert.rejects(add('missing'), error => error.data.code === 'BAD_ARGUMENT');
    await assert.rejects(add(' '), error => error.data.code === 'BAD_ARGUMENT');
    await add(' reader ');
    await add('reader');
    await add('owner');
    assert.equal(s.tables.importReaders.size, 1);
    assert.deepEqual((await sharing.readers._handler(s.ctx, { id: 'own', paginationOpts })).page, [
      { reader: 'reader' },
    ]);
    await sharing.remove._handler(s.ctx, { id: 'own', reader: 'reader' });
    await sharing.remove._handler(s.ctx, { id: 'own', reader: 'reader' });
    assert.equal(s.tables.importReaders.size, 0);
    for (let i = 0; i < 53; i++) await add(`reader-${i}`);
    s.caller('other');
    await add('reader', 'other');
    s.caller('owner');
    await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
    await assert.rejects(add('late'), denied);
    for (let i = 0; i < s.scheduled.length; i++) await lifecycle.purge._handler(s.ctx, s.scheduled[i].args);
    assert.equal(s.tables.imports.has('own'), false);
    assert.equal(s.tables.importReaders.size, 1);
    assert.equal([...s.tables.importReaders.values()][0].importId, 'other');
  } finally {
    cleanup();
  }
});

test('a reader gets exact source/graph/README/metadata/export only while grant and both GitHub entitlements are current', async t => {
  const root = fixture(t, {
    'a.ts': 'export const greeting = "synthetic private source";\n',
    'README.md': '# Synthetic private sharing\n',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Synthetic sharing candidate']);
  const captured = capture(root),
    pack = analyze(captured),
    s = state([{ ...job(), head: captured.source.gitHead }]);
  const artifact = {
    pack,
    content: Object.fromEntries(captured.content),
    documents: { 'README.md': '# Synthetic private sharing\n', 'docs/guide.md': '# Retained private guide' },
    repository: {},
  };
  const blob = await encodeHostedArtifact(artifact);
  s.file('saved', blob);
  let revoked;
  const checked = [];
  const cleanup = providers(
    user => {
      checked.push(user);
      return user === revoked;
    },
    true,
    captured.source.gitHead,
  );
  const status = async () => JSON.parse(await hosted.status._handler(s.ctx, { id: 'own' }));
  const read = endpoint => hosted.read._handler(s.ctx, { id: 'own', endpoint });
  const download = () => lifecycleActions.downloadPart._handler(s.ctx, { id: 'own', offset: 0 });
  try {
    await sharingActions.add._handler(s.ctx, { id: 'own', reader: 'reader' });
    for (const caller of [undefined, 'unlisted']) {
      s.caller(caller);
      await assert.rejects(status(), denied);
      await assert.rejects(read('context'), denied);
      await assert.rejects(read('readme?file=docs%2Fguide.md'), denied);
      await assert.rejects(download(), denied);
    }
    assert.equal(s.reads(), 0);
    assert.equal(checked.length, 0);
    s.caller('reader');
    const metadata = await status();
    assert.equal(metadata.canRefresh, false);
    assert.equal(metadata.repository, 'example/project');
    assert(!('owner' in metadata));
    assert(!('artifactKey' in metadata));
    for (const endpoint of [
      'status',
      'files',
      'context?search=greeting',
      'declarations?file=a.ts',
      'imports?file=a.ts',
      'source?file=a.ts',
      'readme',
    ])
      assert.equal(typeof (await read(endpoint)), 'string');
    const source = JSON.parse(await read('source?file=a.ts'));
    assert.match(source.results[0].text, /synthetic private source/);
    assert.match(JSON.parse(await read('readme')).text, /Synthetic private sharing/);
    assert.equal(JSON.parse(await read('readme?file=docs%2Fguide.md')).text, '# Retained private guide');
    const part = await download();
    assert.deepEqual(Buffer.from(part.data), Buffer.from(await blob.arrayBuffer()));
    assert(checked.includes('owner') && checked.includes('reader'));
    await assert.rejects(hosted.refresh._handler(s.ctx, { id: 'own' }), denied);
    await assert.rejects(lifecycle.trash._handler(s.ctx, { id: 'own' }), denied);
    await assert.rejects(lifecycleActions.restore._handler(s.ctx, { id: 'own' }), denied);
    await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
    assert.equal(s.scheduled.length, 0);
    const ownImport = await hosted.start._handler(s.ctx, { url: 'example/project' });
    assert.notEqual(ownImport, 'own');
    assert.equal(s.tables.imports.get(ownImport).owner, 'reader');
    for (revoked of ['owner', 'reader']) {
      const before = s.reads();
      await assert.rejects(status(), denied);
      await assert.rejects(read('source?file=a.ts'), denied);
      await assert.rejects(read('readme?file=docs%2Fguide.md'), denied);
      await assert.rejects(download(), denied);
      assert.equal(s.reads(), before);
      assert.deepEqual((await sharingActions.list._handler(s.ctx, { paginationOpts })).page, []);
    }
    revoked = undefined;
    s.caller('owner');
    await sharing.remove._handler(s.ctx, { id: 'own', reader: 'reader' });
    s.caller('reader');
    const before = s.reads();
    await assert.rejects(read('source?file=a.ts'), denied);
    await assert.rejects(read('readme?file=docs%2Fguide.md'), denied);
    await assert.rejects(download(), denied);
    assert.equal(s.reads(), before);
    s.caller('owner');
    assert.equal((await status()).canRefresh, true);
    await hosted.refresh._handler(s.ctx, { id: 'own' });
    assert.equal(s.tables.imports.get('own').generation, 2);
  } finally {
    cleanup();
  }
});

test('shared list pagination checks current access; Trash and removal during provider calls stop all reader retrieval', async () => {
  const s = state(Array.from({ length: 41 }, (_, i) => ({ ...job(`import-${i}`), ref: `branch-${i}` })));
  let removeDuringRead = false;
  const cleanup = providers(user => {
    if (removeDuringRead && user === 'owner') s.tables.importReaders.clear();
    return false;
  });
  try {
    for (const row of s.tables.imports.values())
      await sharingActions.add._handler(s.ctx, { id: row._id, reader: 'reader' });
    s.caller('reader');
    const first = await sharingActions.list._handler(s.ctx, { paginationOpts });
    assert.equal(first.page.length, 20);
    assert.equal(first.isDone, false);
    const second = await sharingActions.list._handler(s.ctx, {
      paginationOpts: { ...paginationOpts, cursor: first.continueCursor },
    });
    const third = await sharingActions.list._handler(s.ctx, {
      paginationOpts: { ...paginationOpts, cursor: second.continueCursor },
    });
    assert.equal(second.page.length, 20);
    assert.equal(third.page.length, 1);
    assert.equal(third.isDone, true);
    assert.equal(new Set([...first.page, ...second.page, ...third.page].map(row => row.id)).size, 41);
    s.caller('owner');
    await lifecycle.trash._handler(s.ctx, { id: 'import-0' });
    s.caller('reader');
    await assert.rejects(hosted.status._handler(s.ctx, { id: 'import-0' }), denied);
    await assert.rejects(
      lifecycleActions.downloadPart._handler(s.ctx, { id: 'import-0', offset: 0 }),
      denied,
    );
    assert.equal(s.reads(), 0);
    s.caller('owner');
    await lifecycleActions.restore._handler(s.ctx, { id: 'import-0' });
    s.caller('reader');
    removeDuringRead = true;
    await assert.rejects(hosted.read._handler(s.ctx, { id: 'import-0', endpoint: 'readme' }), denied);
    assert.equal(s.reads(), 0);
    assert.deepEqual((await sharingActions.list._handler(s.ctx, { paginationOpts })).page, []);
  } finally {
    cleanup();
  }
});

test('public anonymous reads retain their existing behavior and never inherit a private named-reader grant', async () => {
  const s = state([{ ...job('public'), visibility: 'public', scope: 'public', owner: '' }]),
    cleanup = providers(() => false, false);
  try {
    s.caller(undefined);
    const metadata = JSON.parse(await hosted.status._handler(s.ctx, { id: 'public' }));
    assert.equal(metadata.visibility, 'public');
    assert.equal(metadata.canRefresh, true);
    assert.deepEqual((await sharingActions.list._handler(s.ctx, { paginationOpts })).page, []);
    assert.equal(await hosted.refresh._handler(s.ctx, { id: 'public' }), 'public');
  } finally {
    cleanup();
  }
});
