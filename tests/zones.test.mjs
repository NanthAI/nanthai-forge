// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { setup as r2Setup } from './r2-harness.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, git } from './helpers.mjs';
import { capture } from '../dist/snapshot.js';
import { analyze } from '../dist/analyze.js';
import { encodeHostedArtifact, decodeHostedArtifact } from '../dist/hosted-artifact.js';
import { validateArtifact } from '../dist/artifact-validation.js';
import { job, providers } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const { ReferenceMap } = await import(moduleUrl('../web/src/Map.tsx'));
const actions = await import(moduleUrl('../convex/zoneActions.ts'));
const zones = await import(moduleUrl('../convex/sourceZones.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const imports = await import(moduleUrl('../convex/imports.ts'));
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const denied = error => ['ZONE_UNAVAILABLE', 'GITHUB_UNAVAILABLE'].includes(error.data?.code);
const code = expected => error => error.data?.code === expected;
const paginationOpts = { cursor: null, numItems: 20 };
async function setup(t) {
  const root = fixture(t, {
    'visible.ts':
      'import { HiddenValue } from "./restricted/hidden";\nexport const VisibleValue = HiddenValue;\n',
    'second.ts': 'import { VisibleValue } from "./visible";\nexport const answer = VisibleValue;\n',
    'restricted/hidden.ts': 'export const HiddenValue = "hidden-body-marker";\n',
    'restricted/caller.ts':
      'import { VisibleValue } from "../visible";\nexport const restrictedAnswer = VisibleValue;\n',
    'broken-secret.ts': 'export const broken = ;',
    'README.md': '# Private repository documentation\n',
    '.env': 'PRIVATE_SECRET=not-indexed\n',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Synthetic source Zone']);
  const snapshot = capture(root),
    artifact = {
      pack: analyze(snapshot),
      content: Object.fromEntries(snapshot.content),
      documents: {
        'README.md': '# Private repository documentation',
        '.nforge/home.md': 'Private home marker',
        'docs/guide.md': 'Private guide marker',
      },
      repository: {
        full_name: 'example/project',
        private: true,
        default_branch: 'main',
        html_url: 'https://github.com/example/project',
        license: null,
      },
    };
  const { s, fake } = await r2Setup(t);
  s.tables.imports.set('own', { ...job(), head: artifact.pack.source.gitHead });
  s.file('saved', await encodeHostedArtifact(artifact));
  const revoked = new Set(),
    cleanup = providers(actor => revoked.has(actor), true, artifact.pack.source.gitHead);
  t.after(cleanup);
  const request = {
    importId: 'own',
    name: 'Selected source',
    operationId: randomUUID(),
    sourceId: artifact.pack.source.id,
    files: ['visible.ts', 'second.ts'],
  };
  const change = (
    id,
    update,
    expectedRevision = s.tables.sourceZones.get(id).revision,
    operationId = randomUUID(),
  ) => actions.change._handler(s.ctx, { id, update, expectedRevision, operationId });
  const read = async (id, endpoint) => JSON.parse(await actions.read._handler(s.ctx, { id, endpoint }));
  return { s, fake, artifact, request, change, read, revoked };
}

test('human source Zones expose only selected bytes and valid graph identities, exclude documents and global counts, and never imply whole-import access', async t => {
  const { s, artifact, request, change, read } = await setup(t),
    id = await actions.create._handler(s.ctx, request);
  s.caller(undefined);
  const before = s.reads();
  await assert.rejects(read(id, 'status'), denied);
  assert.equal(s.reads(), before);
  s.caller('reader');
  await assert.rejects(read(id, 'status'), denied);
  assert.equal(s.reads(), before);
  s.caller('owner');
  await change(id, { kind: 'reader', reader: 'reader', present: true });
  s.caller('reader');
  const status = await read(id, 'status');
  assert.equal(status.files, 2);
  assert.equal(status.syntaxIssues, 0);
  assert.equal(status.pinned, true);
  assert.notEqual(status.sourceId, artifact.pack.source.id);
  assert.equal(status.zone.originalSourceId, artifact.pack.source.id);
  const source = await read(id, 'source?file=visible.ts');
  assert.equal(source.results[0].text, artifact.content['visible.ts']);
  assert.match(source.results[0].text, /restricted\/hidden/);
  for (const path of ['restricted/hidden.ts', '.env', '../visible.ts'])
    await assert.rejects(read(id, `source?file=${encodeURIComponent(path)}`), code('SOURCE_NOT_INDEXED'));
  assert.equal((await read(id, 'context?search=hidden-body-marker')).total, 0);
  assert.equal((await read(id, 'inspect?symbol=HiddenValue')).total, 0);
  const impact = await read(id, 'impact?file=visible.ts');
  assert.equal(impact.total, 1);
  assert.equal(impact.results[0].from, 'second.ts');
  const node = (await read(id, 'declarations?file=visible.ts')).results.find(
    node => node.name === 'VisibleValue',
  );
  const references = await read(id, `refs?symbol=${node.id}&state=${status.sourceId}`);
  const map = renderToStaticMarkup(
    createElement(ReferenceMap, {
      symbol: node,
      references,
      sourceId: status.sourceId,
      analysisId: status.analysisId,
      source: () => {},
    }),
  );
  assert.match(map, /second.ts/);
  assert.ok(!map.includes('restricted/caller.ts'));
  assert.ok(!map.includes('hidden-body-marker'));
  assert.ok(!JSON.stringify(impact).includes('hidden-body-marker'));
  assert.ok(!JSON.stringify(impact).includes('restricted/caller.ts'));
  await assert.rejects(read(id, 'impact?file=restricted%2Fhidden.ts'), code('SOURCE_NOT_INDEXED'));
  await assert.rejects(read(id, 'readme?file=docs%2Fguide.md'), code('NOT_FOUND'));
  assert.ok(!(await read(id, 'readme')).text.includes('Private repository'));
  assert.ok(!(await read(id, 'home')).text.includes('Private home'));
  await assert.rejects(read(id, 'files?state=' + artifact.pack.source.id), code('STATE_MISMATCH'));
  await assert.rejects(
    hosted.read._handler(s.ctx, { id: 'own', endpoint: 'status' }),
    code('GITHUB_UNAVAILABLE'),
  );
  const part = await actions.downloadPart._handler(s.ctx, { id, offset: 0 });
  assert.equal(part.direct, true);
  const bytes = await (await fetch(part.url)).arrayBuffer();
  assert.equal(part.digest, createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
  const exported = await decodeHostedArtifact(new Blob([bytes], { type: part.contentType }));
  assert.equal(validateArtifact(exported.pack), exported.pack);
  assert.deepEqual(Object.keys(exported.content).sort(), request.files.slice().sort());
  assert.deepEqual(exported.documents, {});
  assert.equal(exported.projection.originalAnalysisId, artifact.pack.id);
  assert.equal(exported.projection.gitHead, artifact.pack.source.gitHead);
  assert.ok(!JSON.stringify(exported).includes('hidden-body-marker'));
  assert.ok(!JSON.stringify(exported).includes('Private home marker'));
  assert.equal(exported.pack.source.files.length, 2);
  assert.deepEqual(exported.pack.source.excluded, {});
  assert.ok(
    exported.pack.references.every(edge => exported.pack.nodes.some(node => node.id === edge.target)),
  );
  const again = await actions.downloadPart._handler(s.ctx, { id, offset: 0, digest: part.digest });
  assert.equal(again.digest, part.digest);
  await assert.rejects(
    actions.downloadPart._handler(s.ctx, { id, offset: 0, digest: '0'.repeat(64) }),
    code('STATE_MISMATCH'),
  );
  await assert.rejects(actions.downloadPart._handler(s.ctx, { id, offset: part.size }), code('BAD_ARGUMENT'));
  assert.equal(JSON.parse(await actions.status._handler(s.ctx, { id, importId: 'own' })).canRefresh, false);
  await assert.rejects(actions.status._handler(s.ctx, { id, importId: 'another' }), denied);
});

test('source Zone creation reconciles a lost committed reply, rejects changed requests and snapshot races, and remains pinned after refresh', async t => {
  const { s, artifact, request, read, revoked } = await setup(t),
    mutation = s.ctx.runMutation;
  let lose = true;
  s.ctx.runMutation = async (fn, args) => {
    const result = await mutation(fn, args);
    if (lose && args.artifactKey) {
      lose = false;
      throw new Error('Lost source Zone reply');
    }
    return result;
  };
  await assert.rejects(actions.create._handler(s.ctx, request));
  const id = await actions.create._handler(s.ctx, request);
  assert.equal(await actions.create._handler(s.ctx, request), id);
  assert.equal(s.tables.sourceZones.size, 1);
  await assert.rejects(
    actions.create._handler(s.ctx, { ...request, files: ['visible.ts'] }),
    code('ZONE_OPERATION_CHANGED'),
  );
  await assert.rejects(
    actions.create._handler(s.ctx, { ...request, operationId: randomUUID(), sourceId: 'b'.repeat(64) }),
    code('ZONE_SOURCE_CHANGED'),
  );
  for (const files of [['missing.ts'], ['.env'], ['../visible.ts']])
    await assert.rejects(
      actions.create._handler(s.ctx, { ...request, operationId: randomUUID(), files }),
      code('AGENT_SCOPE_INVALID'),
    );
  revoked.add('owner');
  await assert.rejects(actions.create._handler(s.ctx, { ...request, operationId: randomUUID() }), denied);
  revoked.clear();
  const get = s.ctx.storage.get;
  s.ctx.storage.get = async key => {
    const blob = await get(key);
    s.tables.imports.get('own').artifactKey = 'changed';
    return blob;
  };
  await assert.rejects(
    actions.create._handler(s.ctx, { ...request, operationId: randomUUID() }),
    code('ZONE_SOURCE_CHANGED'),
  );
  s.ctx.storage.get = get;
  s.file('new', new Blob(['invalid new artifact']));
  await imports.update._handler(s.ctx, { id: 'own', generation: 2, phase: 'ready', artifactKey: 'new' });
  assert.equal((await read(id, 'source?file=visible.ts')).zone.originalSourceId, artifact.pack.source.id);
  const normalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    new URL(url).pathname.includes('/commits/')
      ? Response.json({ message: 'Missing ref' }, { status: 404 })
      : normalFetch(url, init);
  const unknown = await read(id, 'status');
  assert.equal(unknown.upstreamFreshness, 'unknown');
  assert.equal(unknown.upstreamHead, null);
  assert.equal(unknown.freshness, 'current');
  globalThis.fetch = normalFetch;
  globalThis.fetch = async (url, init) =>
    new URL(url).pathname.includes('/commits/')
      ? Response.json({ sha: 'b'.repeat(40) })
      : normalFetch(url, init);
  const stale = await read(id, 'status');
  assert.equal(stale.upstreamFreshness, 'stale');
  assert.equal(stale.freshness, 'current');
  assert.equal(stale.currentGitHead, artifact.pack.source.gitHead);
  globalThis.fetch = normalFetch;
});

test('Zone policy uses original operation receipts and CAS, preserves removed readers on replay, and denies reads after in-flight policy/provider/lifecycle changes', async t => {
  const { s, request, change, read, revoked } = await setup(t),
    id = await actions.create._handler(s.ctx, request),
    operationId = randomUUID();
  const add = { kind: 'reader', reader: 'reader', present: true },
    receipt = await change(id, add, 0, operationId);
  await assert.rejects(change(id, { kind: 'enabled', enabled: false }, 0), code('ZONE_CHANGED'));
  await change(id, { ...add, present: false });
  assert.deepEqual(await change(id, add, 0, operationId), receipt);
  assert.equal(s.tables.zoneReaders.size, 0);
  await assert.rejects(
    change(id, { ...add, present: false }, 0, operationId),
    code('ZONE_OPERATION_CHANGED'),
  );
  await assert.rejects(change(id, { ...add, reader: 'missing' }), code('BAD_ARGUMENT'));
  await change(id, add);
  s.caller('reader');
  await assert.rejects(change(id, { kind: 'enabled', enabled: false }), denied);
  for (const actor of ['owner', 'reader']) {
    revoked.add(actor);
    await assert.rejects(read(id, 'status'), denied);
    revoked.clear();
  }
  s.caller('owner');
  await change(id, { kind: 'enabled', enabled: false });
  await assert.rejects(read(id, 'status'), denied);
  await change(id, { kind: 'enabled', enabled: true });
  assert.equal((await read(id, 'status')).files, 2);
  s.caller('reader');
  const get = s.ctx.storage.get;
  s.ctx.storage.get = async key => {
    const blob = await get(key);
    s.tables.zoneReaders.clear();
    return blob;
  };
  await assert.rejects(read(id, 'source?file=visible.ts'), denied);
  s.ctx.storage.get = get;
  s.caller('owner');
  await change(id, add);
  s.caller('reader');
  s.ctx.storage.get = async key => {
    const blob = await get(key);
    revoked.add('reader');
    return blob;
  };
  await assert.rejects(actions.downloadPart._handler(s.ctx, { id, offset: 0 }), denied);
  s.ctx.storage.get = get;
  revoked.clear();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (new URL(url).pathname.includes('/commits/')) s.tables.imports.get('own').removal = 'trash';
    return response;
  };
  await assert.rejects(read(id, 'status'), denied);
  globalThis.fetch = fetch;
  s.caller('owner');
  await change(id, { kind: 'enabled', enabled: false });
  assert.equal((await zones.list._handler(s.ctx, { importId: 'own', paginationOpts })).page.length, 1);
  await lifecycle.restore._handler(s.ctx, { id: 'own', owner: 'owner' });
  await change(id, { kind: 'enabled', enabled: true });
  assert.equal((await read(id, 'status')).files, 2);
});

test('Zone owner/reader lists use current access and paginated relations; import deletion purges all Zone relations before snapshots without touching another import', async t => {
  const { s, request, change, revoked } = await setup(t),
    id = await actions.create._handler(s.ctx, request);
  await change(id, { kind: 'reader', reader: 'reader', present: true });
  s.caller('reader');
  assert.equal((await actions.shared._handler(s.ctx, { paginationOpts })).page[0].id, id);
  assert.deepEqual((await zones.list._handler(s.ctx, { importId: 'own', paginationOpts })).page, []);
  await assert.rejects(zones.readers._handler(s.ctx, { id, paginationOpts }), denied);
  revoked.add('reader');
  assert.deepEqual((await actions.shared._handler(s.ctx, { paginationOpts })).page, []);
  revoked.clear();
  s.caller(undefined);
  assert.deepEqual((await actions.shared._handler(s.ctx, { paginationOpts })).page, []);
  s.caller('owner');
  assert.deepEqual((await zones.readers._handler(s.ctx, { id, paginationOpts })).page, [
    { reader: 'reader' },
  ]);
  for (let n = 0; n < 21; n++)
    await s.ctx.db.insert('sourceZones', {
      ...s.tables.sourceZones.get(id),
      importId: 'own',
      operationId: randomUUID(),
    });
  for (let n = 0; n < 55; n++) {
    await s.ctx.db.insert('zoneReaders', { zoneId: id, reader: `reader-${n}` });
    await s.ctx.db.insert('zoneChanges', { zoneId: id, operationId: randomUUID() });
  }
  s.tables.imports.set('other-import', job('other-import'));
  const other = await s.ctx.db.insert('sourceZones', {
    ...s.tables.sourceZones.get(id),
    importId: 'other-import',
    artifactKey: 'other-saved',
  });
  await s.ctx.db.insert('zoneReaders', { zoneId: other, reader: 'retained-reader' });
  await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
  await lifecycle.purge._handler(s.ctx, { id: 'own' });
  assert.equal(s.deleted.length, 0, 'Snapshot deletion waits for batched Zone cleanup.');
  for (let n = 0; n < 10 && s.tables.imports.has('own'); n++)
    await lifecycle.purge._handler(s.ctx, { id: 'own' });
  assert.equal(s.tables.imports.has('own'), false);
  assert.equal(s.tables.sourceZones.size, 1);
  assert.equal(s.tables.zoneChanges.size, 0);
  assert.equal(s.tables.zoneReaders.size, 1);
  assert.equal(s.tables.sourceZones.get(other).importId, 'other-import');
});

test('source Zone navigation and copied links retain the scope while ordinary routes remain unchanged', async () => {
  const previousWindow = globalThis.window,
    previousLocation = globalThis.location;
  try {
    globalThis.location = new URL('http://127.0.0.1:5192/?codescape=original&zone=selected');
    globalThis.window = { location: globalThis.location };
    const { routeUrl, readRoute } = await import(moduleUrl('../web/src/api.ts'));
    const route = { file: 'visible.ts', view: 'source', state: 'pinned', line: 2 };
    const scoped = new URL(routeUrl(route));
    assert.equal(scoped.searchParams.get('zone'), 'selected');
    assert.equal(scoped.searchParams.get('codescape'), 'original');
    const reference = { ...route, view: 'map', symbol: 'symbol:original', lens: 'references' };
    const link = new URL(routeUrl(reference));
    globalThis.location.search = link.search;
    assert.equal(link.searchParams.get('zone'), 'selected');
    assert.deepEqual(readRoute(), reference);
    globalThis.location.search = scoped.search;
    assert.deepEqual(readRoute(), route);
    globalThis.location.pathname = '/local/forge/code/visible.ts';
    globalThis.location.search = '?codescape=original&zone=selected&state=pinned&line=2';
    assert.deepEqual(readRoute(), route);
    const cleanScoped = new URL(routeUrl(route));
    assert.equal(cleanScoped.searchParams.get('zone'), 'selected');
    assert.equal(cleanScoped.searchParams.get('codescape'), 'original');
    globalThis.location.search = '?codescape=original';
    assert.equal(new URL(routeUrl(route)).searchParams.has('zone'), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test('opted-in Zones export to R2 from old or R2 indexed originals without Convex writes', async t => {
  const { s, fake, artifact, request } = await setup(t);
  const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
  const job = s.tables.imports.get('own');
  job.r2Writes = true;
  const first = await actions.create._handler(s.ctx, request);
  const r2Original = await blobStore(s.ctx).store(await encodeHostedArtifact(artifact), {
    r2Namespace: 'v1/i/own/g/2',
  });
  await imports.update._handler(s.ctx, { id: 'own', generation: 1, phase: 'ready', artifactKey: r2Original });
  const second = await actions.create._handler(s.ctx, {
    ...request,
    name: 'R2 original',
    operationId: randomUUID(),
  });
  s.ctx.storage.store = () => assert.fail('Zone exports must not write Convex bytes');
  s.ctx.storage.generateUploadUrl = () => assert.fail('Zone exports must not create Convex upload URLs');
  for (const id of [first, second]) {
    const part = await actions.downloadPart._handler(s.ctx, { id, offset: 0 });
    assert.equal(part.direct, true);
    const scoped = await decodeHostedArtifact(
      new Blob([await (await fetch(part.url)).arrayBuffer()], { type: part.contentType }),
    );
    assert.deepEqual(Object.keys(scoped.content).sort(), [...request.files].sort());
    const before = fake.objects.size;
    await actions.downloadPart._handler(s.ctx, { id, offset: 0, digest: part.digest });
    assert.equal(fake.objects.size, before);
  }
  assert.equal(
    [...s.tables.derivedArtifacts.values()].filter(
      row => row.kind === 'zone-export-v1' && row.storageId?.startsWith('r2blob:'),
    ).length,
    2,
  );
});
