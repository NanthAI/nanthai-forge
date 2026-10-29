// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import {
  nativeManifestSchema,
  sourceManifestSchema,
  workArchiveMetadata,
} from '../dist/work-archive-metadata.js';
import { exportWorkCommandSchema } from '../dist/work-types.js';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { digest } from '../dist/hash.js';
import { latestWorkFormat } from '../dist/work-format.js';
import { fixture, git, code } from './helpers.mjs';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { getFunctionName } from 'convex/server';
const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const artifact = id => `check-${id}/artifacts/artifact-0.bin`;
const first = artifact('11111111-1111-4111-8111-111111111111'),
  second = artifact('22222222-2222-4222-8222-222222222222');
function contract() {
  const bytes = Buffer.from('identical retained build output');
  return {
    schema: 2,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head: 'a'.repeat(64),
    revision: 0,
    files: [
      { path: first, size: bytes.length, sha256: digest(bytes) },
      { path: second, size: bytes.length, sha256: digest(bytes) },
    ],
    artifactAliases: [{ path: second, target: first }],
    unavailable: [],
    coverage: 'Exact original paths and bytes.',
  };
}
test('native schema 2 validates direct artifact aliases; strict schema 1 remains the ordinary format', () => {
  const value = contract();
  assert.deepEqual(nativeManifestSchema.parse(value), value);
  assert.deepEqual(sourceManifestSchema.parse(value), value);
  const ordinary = { ...value, schema: 1 };
  delete ordinary.artifactAliases;
  assert.deepEqual(nativeManifestSchema.parse(ordinary), ordinary);
  assert.equal(nativeManifestSchema.safeParse({ ...ordinary, artifactAliases: [] }).success, false);
  assert.equal(nativeManifestSchema.safeParse({ ...value, unknown: 'ignored' }).success, false);
  assert.equal(nativeManifestSchema.safeParse({ ...value, schema: 3 }).success, false);
});
test('alias metadata rejects missing, repeated, non-artifact, forward, chained and different-byte targets', () => {
  const bad = mutate => {
    const value = contract();
    mutate(value);
    assert.equal(nativeManifestSchema.safeParse(value).success, false);
    assert.equal(sourceManifestSchema.safeParse(value).success, false);
  };
  bad(m => m.artifactAliases.push(m.artifactAliases[0]));
  bad(m => m.files.push(m.files[0]));
  bad(m => (m.artifactAliases[0].path = first));
  bad(m => (m.artifactAliases[0].target = artifact(randomUUID())));
  bad(m => (m.artifactAliases[0].path = artifact(randomUUID())));
  bad(m => (m.artifactAliases[0].target = 'work.json'));
  bad(m => (m.artifactAliases[0].path = `objects/${m.head}`));
  bad(m => (m.artifactAliases[0].target = '../' + first));
  bad(m => m.files.reverse());
  bad(m => m.files[1].size++);
  bad(m => (m.files[1].sha256 = 'b'.repeat(64)));
  bad(m => {
    const third = artifact(randomUUID());
    m.files.push({ ...m.files[1], path: third });
    m.artifactAliases.push({ path: third, target: second });
  });
  bad(m => (m.artifactAliases[0].extra = true));
  bad(m => m.unavailable.push(first));
  bad(m => m.unavailable.push(second));
});
function header(name, size) {
  const h = Buffer.alloc(512);
  h.write(name);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h[156] = 48;
  h.fill(32, 148, 156);
  h.write(
    h
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  return h;
}
const entry = (name, bytes) =>
  Buffer.concat([header(name, bytes.length), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
async function nativeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-schema2-metadata-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  initNative(root);
  const w = new WorkService(root),
    exported = (await w.dispatch({ action: 'export-work', archive: true }, w.store.load().revision)).result;
  const original = JSON.parse(readFileSync(join(exported.path, 'manifest.json'), 'utf8')),
    work = readWorkBytes(join(exported.path, 'work.json'));
  const synthetic = contract(),
    manifest = {
      ...original,
      schema: 2,
      files: [...original.files, ...synthetic.files],
      artifactAliases: synthetic.artifactAliases,
    };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)),
    bytes = gzipSync(
      Buffer.concat([
        entry('manifest.json', manifestBytes),
        entry('work.json', work),
        entry(first, Buffer.from('identical retained build output')),
        Buffer.alloc(1024),
      ]),
    );
  return { root, w, manifest, manifestBytes, work, bytes };
}
test('bounded metadata and browser preview preserve exact schema 2 logical source/Work pins', async t => {
  const f = await nativeFixture(t),
    metadata = await workArchiveMetadata(new Blob([f.bytes]));
  assert.deepEqual(Buffer.from(metadata.manifest), f.manifestBytes);
  assert.deepEqual(Buffer.from(metadata.work), f.work);
  const preview = await previewWorkArchive(new File([f.bytes], 'compact-native.tar.gz'));
  assert.equal(preview.format, 'native');
  assert.equal(preview.head, f.manifest.head);
  assert.equal(preview.files, f.manifest.files.length);
  assert.equal(preview.manifestDigest, digest(f.manifestBytes));
  const bad = { ...f.manifest, artifactAliases: [{ path: second, target: 'work.json' }] },
    badBytes = gzipSync(
      Buffer.concat([
        entry('manifest.json', Buffer.from(JSON.stringify(bad))),
        entry('work.json', f.work),
        Buffer.alloc(1024),
      ]),
    );
  await assert.rejects(previewWorkArchive(new File([badBytes], 'invalid-native.tar.gz')));
});
test('provider readers accept exact schema 2 metadata and still recheck current authorization and digest pins', async t => {
  const f = await nativeFixture(t),
    s = state([]);
  s.tables.projectContributors = new Map();
  s.tables.hostedProjects = new Map([
    [
      'project',
      {
        _id: 'project',
        owner: 'owner',
        key: randomUUID(),
        name: 'Compact fixture',
        revision: 1,
        currentBackup: 'backup',
      },
    ],
  ]);
  s.tables.projectBackups = new Map([
    [
      'backup',
      {
        _id: 'backup',
        projectId: 'project',
        digest: digest(f.bytes),
        size: f.bytes.length,
        status: 'stored',
        storageId: 'storage',
        preview: { manifestDigest: digest(f.manifestBytes) },
      },
    ],
  ]);
  const prior = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref) === 'projectBackups:get' ? backups.get._handler(s.ctx, args) : prior(ref, args);
  s.files.set('storage', { blob: new Blob([f.bytes]) });
  s.ctx.storage.get = () => {
    throw Error('Do not read full archive');
  };
  const source = await actions.source(s.ctx, 'backup', 'owner');
  assert.deepEqual(source.manifest, f.manifest);
  assert.deepEqual(Buffer.from(JSON.stringify(source.data)), Buffer.from(JSON.stringify(JSON.parse(f.work))));
  const project = s.tables.hostedProjects.get('project'),
    before = structuredClone(project),
    getUrl = s.ctx.storage.getUrl;
  s.ctx.storage.getUrl = async id => {
    const url = await getUrl(id);
    project.owner = 'revoked';
    return url;
  };
  await assert.rejects(actions.source(s.ctx, 'backup', 'owner'), e => e.data?.code === 'PROJECT_UNAVAILABLE');
  assert.equal(project.currentBackup, before.currentBackup);
  project.owner = 'owner';
  s.ctx.storage.getUrl = getUrl;
  s.tables.projectBackups.get('backup').preview.manifestDigest = 'b'.repeat(64);
  await assert.rejects(actions.source(s.ctx, 'backup', 'owner'), code('INVALID_WORK_BACKUP'));
  assert.deepEqual(project, before);
});
test('artifact deduplication is explicit, default-off and supported only for portable native archives', async t => {
  assert.deepEqual(exportWorkCommandSchema.parse({ action: 'export-work' }), { action: 'export-work' });
  assert.equal(
    exportWorkCommandSchema.safeParse({ action: 'export-work', deduplicateArtifacts: 'true' }).success,
    false,
  );
  const f = await nativeFixture(t),
    before = readWorkBytes(join(f.w.store.directory, 'work.json'));
  assert.equal(f.w.status({ compact: true }).capabilities.artifactDeduplication, true);
  for (const command of [
    { action: 'export-work', deduplicateArtifacts: true },
    { action: 'export-work', archive: false, deduplicateArtifacts: true },
    { action: 'export-work', archive: 'true' },
    { action: 'export-work', archive: true, deduplicateArtifacts: 1 },
  ])
    await assert.rejects(f.w.dispatch(command, f.w.store.load().revision), code('BAD_ARGUMENT'));
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
  const gitRoot = fixture(t, { 'a.ts': 'export const a=1;' });
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-qm', 'Original']);
  const gitWork = new WorkService(gitRoot),
    revision = gitWork.status().revision;
  assert.equal(gitWork.status().capabilities.artifactDeduplication, false);
  await assert.rejects(
    gitWork.dispatch({ action: 'export-work', archive: true, deduplicateArtifacts: true }, revision),
    code('UNSUPPORTED_WORK_BACKUP'),
  );
  const ordinary = (
    await gitWork.dispatch({ action: 'export-work', archive: true, deduplicateArtifacts: false }, revision)
  ).result;
  assert.equal(JSON.parse(readFileSync(join(ordinary.path, 'manifest.json'), 'utf8')).schema, 1);
});

test('browser archive preview supports legacy and current Work formats for ordinary and compact native exports', async t => {
  const f = await nativeFixture(t),
    data = f.w.store.load();
  delete data.autonomyPolicy;
  for (const schema of [6, 7, 8, 9, 10, 11, 12])
    for (const deduplicateArtifacts of [false, true]) {
      data.schema = schema;
      writeFileSync(join(f.w.store.directory, 'work.json'), JSON.stringify(data));
      const exported = (
        await f.w.dispatch(
          { action: 'export-work', archive: true, deduplicateArtifacts },
          f.w.store.load().revision,
        )
      ).result;
      const bytes = readFileSync(exported.archive.path),
        metadata = await workArchiveMetadata(new Blob([bytes]));
      assert.equal(JSON.parse(Buffer.from(metadata.work)).schema, schema);
      assert.equal(JSON.parse(Buffer.from(metadata.manifest)).schema, deduplicateArtifacts ? 2 : 1);
      const preview = await previewWorkArchive(new File([bytes], 'current-work.tar.gz'));
      assert.equal(preview.format, 'native');
      assert.equal(preview.head, data.nativeHead);
      assert.equal(preview.revision, data.revision);
    }
  for (const change of [
    { schema: '7' },
    { schema: latestWorkFormat + 1 },
    { runs: {} },
    { nativeHead: 42 },
  ]) {
    const changed = Buffer.from(JSON.stringify({ ...data, ...change })),
      manifest = structuredClone(f.manifest);
    const file = manifest.files.find(item => item.path === 'work.json');
    file.size = changed.length;
    file.sha256 = digest(changed);
    const bytes = gzipSync(
      Buffer.concat([
        entry('manifest.json', Buffer.from(JSON.stringify(manifest))),
        entry('work.json', changed),
        Buffer.alloc(1024),
      ]),
    );
    await assert.rejects(previewWorkArchive(new File([bytes], 'invalid-work.tar.gz')));
  }
});
