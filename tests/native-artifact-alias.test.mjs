// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
  readdirSync,
  copyFileSync,
  linkSync,
  unlinkSync,
  chmodSync,
  renameSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';
import { artifactArchivePlan, materializeArtifactAliases } from '../dist/native-artifact-alias.js';
import { packWorkArchive, withWorkArchive } from '../dist/work-backup-archive.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = error => error.code === 'INVALID_WORK_BACKUP';
function temporary(t) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'forge-artifact-alias-')));
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return path;
}
async function retainedOutputs(t) {
  const directory = temporary(t),
    root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;');
  initNative(root);
  const work = new WorkService(root),
    act = command => work.execute(command, work.store.load().revision).result;
  const intent = act({ action: 'intent', outcome: 'Independent retained outputs' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Unchanged source' });
  const view = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const check = act({
    action: 'define-check',
    name: 'Repeated exact output',
    executable: process.execPath,
    args: [
      '-e',
      "require('node:fs').writeFileSync('out.bin',Buffer.alloc(256*1024,73));console.log('retained original run')",
    ],
    artifactPaths: ['out.bin'],
  });
  for (let i = 0; i < 2; i++) {
    const environment = work.status().environment;
    await work.dispatch(
      {
        action: 'run-check',
        operationId: randomUUID(),
        viewId: view.id,
        expectedHead: view.head,
        checkId: check.id,
        expectedDefinition: check.definition,
        expectedEnvironment: environment.fingerprint,
      },
      work.store.load().revision,
    );
    for (let attempt = 0; attempt < 500 && work.store.load().runs[i].status !== 'passed'; attempt++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(work.store.load().runs[i].status, 'passed');
  }
  return { directory, root, work };
}
test('optional deduplicated native archives preserve every original byte, Work record and independent output inode', async t => {
  const { directory, work } = await retainedOutputs(t),
    originalWork = readWorkBytes(join(work.store.directory, 'work.json'));
  const legacy = (await exportNativeWork(work.store, work.store.load().revision, true)).result;
  const selected = (await exportNativeWork(work.store, work.store.load().revision, true, true)).result,
    manifest = JSON.parse(selected.json);
  assert.equal(JSON.parse(legacy.json).schema, 1);
  assert.equal(JSON.parse(legacy.json).artifactAliases, undefined);
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.artifactAliases.length, 1);
  assert.equal(selected.transport.aliasedArtifacts, 1);
  assert.equal(selected.transport.logicalFiles - selected.transport.physicalFiles, 1);
  assert.equal(selected.transport.logicalBytes - selected.transport.physicalBytes, 256 * 1024);
  assert.deepEqual(manifest.files, JSON.parse(legacy.json).files);
  assert.deepEqual(manifest.unavailable, []);
  await withWorkArchive(selected.archive.path, async directory => {
    const { path, target } = manifest.artifactAliases[0];
    assert.deepEqual(readFileSync(join(directory, path)), readFileSync(join(directory, target)));
    assert.notEqual(statSync(join(directory, path)).ino, statSync(join(directory, target)).ino);
    assert.equal(statSync(join(directory, path)).nlink, 1);
    assert.equal(statSync(join(directory, target)).nlink, 1);
  });
  for (const [name, backup] of [
    ['legacy', legacy],
    ['deduplicated', selected],
  ]) {
    const target = join(directory, name);
    await restoreNativeWork(backup.archive.path, target);
    assert.deepEqual(readWorkBytes(join(target, '.forge/work/work.json')), originalWork);
    for (const file of manifest.files)
      assert.deepEqual(
        file.path === 'work.json'
          ? readWorkBytes(join(target, '.forge/work', file.path))
          : readFileSync(join(target, '.forge/work', file.path)),
        file.path === 'work.json'
          ? readWorkBytes(join(work.store.directory, file.path))
          : readFileSync(join(work.store.directory, file.path)),
      );
    const paths = manifest.files
      .filter(file => file.path.includes('/artifacts/'))
      .map(file => join(target, '.forge/work', file.path));
    assert.notEqual(statSync(paths[0]).ino, statSync(paths[1]).ino);
  }
  const sparse = join(directory, 'sparse');
  mkdirSync(sparse);
  copyFileSync(join(selected.path, 'manifest.json'), join(sparse, 'manifest.json'));
  for (const file of artifactArchivePlan(manifest).physical) {
    mkdirSync(dirname(join(sparse, file.path)), { recursive: true });
    copyFileSync(join(selected.path, file.path), join(sparse, file.path));
  }
  await restoreNativeWork(sparse, join(directory, 'sparse-restored'));
  assert.equal(
    existsSync(join(sparse, manifest.artifactAliases[0].path)),
    false,
    'Selected directory was not mutated',
  );
  await assert.rejects(
    exportNativeWork(work.store, work.store.load().revision, false, true),
    error => error.code === 'BAD_ARGUMENT',
  );
  unlinkSync(join(work.store.directory, manifest.artifactAliases[0].target));
  const incomplete = (await exportNativeWork(work.store, work.store.load().revision, true, true)).result;
  assert.equal(JSON.parse(incomplete.json).artifactAliases.length, 0);
  assert.deepEqual(incomplete.unavailable, [manifest.artifactAliases[0].target]);
  const missing = join(directory, 'unavailable-restored');
  await restoreNativeWork(incomplete.archive.path, missing);
  assert.deepEqual(readWorkBytes(join(missing, '.forge/work/work.json')), originalWork);
  assert.equal(existsSync(join(missing, '.forge/work', manifest.artifactAliases[0].target)), false);
});
function aliasFixture() {
  const bytes = Buffer.from('identical recorded outputs'),
    a = `check-${randomUUID()}/artifacts/artifact-0.bin`,
    b = `check-${randomUUID()}/artifacts/artifact-0.bin`;
  return {
    schema: 2,
    kind: 'forge-native-work-backup',
    files: [
      { path: 'work.json', size: 2, sha256: sha('{}') },
      { path: a, size: bytes.length, sha256: sha(bytes) },
      { path: b, size: bytes.length, sha256: sha(bytes) },
    ],
    artifactAliases: [{ path: b, target: a }],
    unavailable: [],
  };
}
test('cycles, chains, forwards, unavailable, source/Work references and conflicting logical declarations are rejected', () => {
  const original = aliasFixture(),
    [a, b] = original.files.slice(1).map(file => file.path),
    cases = [];
  const add = change => {
    const value = structuredClone(original);
    change(value);
    cases.push(value);
  };
  add(v => (v.artifactAliases = [{ path: a, target: b }]));
  add(
    v =>
      (v.artifactAliases = [
        { path: a, target: b },
        { path: b, target: a },
      ]),
  );
  add(v => {
    const c = `check-${randomUUID()}/artifacts/artifact-0.bin`;
    v.files.push({ ...v.files[2], path: c });
    v.artifactAliases.push({ path: c, target: b });
  });
  add(v => v.artifactAliases.push(v.artifactAliases[0]));
  add(v => (v.artifactAliases[0].path = '../escape'));
  add(v => (v.artifactAliases[0].target = 'work.json'));
  add(v => (v.artifactAliases[0].path = 'objects/' + sha('source')));
  add(v => (v.artifactAliases[0].target = `check-${randomUUID()}/artifacts/artifact-0.bin`));
  add(v => v.files[2].size++);
  add(v => (v.files[2].sha256 = sha('changed')));
  add(v => v.files.push(v.files[2]));
  add(v => v.unavailable.push(a));
  add(v => v.unavailable.push(b));
  add(v => delete v.artifactAliases);
  add(v => (v.schema = 1));
  for (const value of cases) assert.throws(() => artifactArchivePlan(value), invalid);
});
test('unexpected physical duplicates, missing targets, tampered bytes and hardlinks cannot reach archive consumers', async t => {
  const root = temporary(t),
    manifest = aliasFixture(),
    [a, b] = manifest.files.slice(1).map(file => file.path),
    directory = join(root, 'source');
  mkdirSync(directory);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'work.json'), '{}');
  for (const path of [a, b]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), 'identical recorded outputs');
  }
  for (const [name, files] of [
    ['unexpected', ['work.json', a, b]],
    ['missing', ['work.json']],
  ]) {
    const archive = await packWorkArchive(directory, files);
    copyFileSync(archive.path, join(root, name + '.tar.gz'));
    await assert.rejects(
      withWorkArchive(join(root, name + '.tar.gz'), async () =>
        assert.fail('Bad physical coverage reached consumer'),
      ),
      invalid,
    );
  }
  writeFileSync(join(directory, a), 'tampered!');
  const corrupt = await packWorkArchive(directory, ['work.json', a]);
  await assert.rejects(
    withWorkArchive(corrupt.path, async () => assert.fail('Tampered target reached consumer')),
    invalid,
  );
  const linked = join(root, 'hardlink');
  mkdirSync(linked);
  mkdirSync(dirname(join(linked, a)), { recursive: true });
  writeFileSync(join(linked, a), 'identical recorded outputs');
  linkSync(join(linked, a), join(linked, 'other-link'));
  await assert.rejects(materializeArtifactAliases(linked, manifest.files, manifest.artifactAliases), invalid);
  assert.equal(existsSync(join(linked, b)), false);
});
test('corrupt references fail without creating a native restore target or changing the selected archive', async t => {
  const { directory, work } = await retainedOutputs(t),
    selected = (await exportNativeWork(work.store, work.store.load().revision, true, true)).result;
  const manifest = JSON.parse(selected.json),
    original = readFileSync(selected.archive.path),
    target = join(directory, 'never-created');
  manifest.artifactAliases[0].target = manifest.artifactAliases[0].path;
  writeFileSync(join(selected.path, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreNativeWork(selected.path, target), invalid);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readFileSync(selected.archive.path), original);
  assert.equal(
    readdirSync(directory).some(name => name.startsWith('.forge-native-restore-')),
    false,
  );
});

test('transport references cannot revive an output unavailable in its original Work record', async t => {
  const { directory, work } = await retainedOutputs(t),
    selected = (await exportNativeWork(work.store, work.store.load().revision, true, true)).result;
  const manifest = JSON.parse(selected.json),
    data = JSON.parse(readWorkBytes(join(selected.path, 'work.json'), 'utf8'));
  data.runs[0].artifacts[0] = {
    status: 'unavailable',
    sourcePath: 'out.bin',
    details: 'Unavailable original output',
  };
  const bytes = Buffer.from(JSON.stringify(data));
  writeFileSync(join(selected.path, 'work.json'), bytes);
  const file = manifest.files.find(file => file.path === 'work.json');
  file.size = bytes.length;
  file.sha256 = sha(bytes);
  writeFileSync(join(selected.path, 'manifest.json'), JSON.stringify(manifest));
  const target = join(directory, 'never-revived');
  await assert.rejects(restoreNativeWork(selected.path, target), invalid);
  assert.equal(existsSync(target), false);
});

test('ordinary copied backup directories retain readable-file support and reject symlink parents for both formats', async t => {
  const { directory, work } = await retainedOutputs(t);
  for (const deduplicate of [false, true]) {
    const backup = (await exportNativeWork(work.store, work.store.load().revision, true, deduplicate)).result,
      manifest = JSON.parse(backup.json);
    for (const file of manifest.files) chmodSync(join(backup.path, file.path), 0o644);
    const accepted = join(directory, `readable-${manifest.schema}`);
    await restoreNativeWork(backup.path, accepted);
    for (const file of manifest.files) {
      assert.equal(statSync(join(backup.path, file.path)).mode & 0o777, 0o644);
      assert.deepEqual(
        file.path === 'work.json'
          ? readWorkBytes(join(accepted, '.forge/work', file.path))
          : readFileSync(join(accepted, '.forge/work', file.path)),
        readFileSync(join(backup.path, file.path)),
      );
      assert.equal(statSync(join(accepted, '.forge/work', file.path)).mode & 0o777, 0o600);
    }
    const external = join(directory, `outside-objects-${manifest.schema}`);
    renameSync(join(backup.path, 'objects'), external);
    symlinkSync(external, join(backup.path, 'objects'));
    const target = join(directory, `never-follow-${manifest.schema}`);
    await assert.rejects(restoreNativeWork(backup.path, target), invalid);
    assert.equal(existsSync(target), false);
    assert.equal(
      statSync(
        join(external, manifest.files.find(file => file.path.startsWith('objects/')).path.split('/')[1]),
      ).mode & 0o777,
      0o644,
    );
  }
});
