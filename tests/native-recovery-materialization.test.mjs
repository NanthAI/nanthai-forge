// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import fs, {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';
import { NativeMaterialization } from '../dist/native-materialization.js';
import { initNative } from '../dist/native-work.js';
import { exportNativeWork, restoreNativeWork, restoreNativeExchangeStage } from '../dist/native-backup.js';
import { pullNativeExchange } from '../dist/native-exchange.js';
import { digest } from '../dist/hash.js';
async function fixture(t) {
  const owner = realpathSync(mkdtempSync(join(tmpdir(), 'forge-recovery-materialization-'))),
    parent = realpathSync(mkdtempSync(join(tmpdir(), 'forge-recovery-targets-')));
  t.after(() => {
    rmSync(owner, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  });
  writeFileSync(join(owner, 'large.bin'), Buffer.alloc(3 * 1024 * 1024, 17));
  writeFileSync(join(owner, 'run.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(owner, 'run.sh'), 0o700);
  initNative(owner);
  const service = new WorkService(owner),
    act = command => service.execute(command, service.store.revision()).result;
  const intent = act({ action: 'intent', outcome: 'Independent writable restored files' });
  const lanes = ['first', 'second'].map(name => act({ action: 'lane', intentId: intent.id, name }));
  const before = service.store.load(),
    exported = (await exportNativeWork(service.store, before.revision, false)).result;
  return { owner, parent, lanes, before, exported, manifest: JSON.parse(exported.json) };
}

test('direct restore preserves input and creates independently writable root and eager Lanes with shared verified reads', async t => {
  const f = await fixture(t),
    target = join(f.parent, 'restored'),
    calls = new Map(),
    original = NativeSource.prototype.object;
  NativeSource.prototype.object = function (id) {
    if (this instanceof NativeMaterialization) calls.set(id, (calls.get(id) ?? 0) + 1);
    return original.call(this, id);
  };
  try {
    await restoreNativeWork(f.exported.path, target);
  } finally {
    NativeSource.prototype.object = original;
  }
  assert.deepEqual(new WorkStore(target).load(), f.before);
  assert(
    [...calls.values()].every(count => count === 1),
    'Materialization reuses each verified object within this recovery',
  );
  const roots = [target, ...f.lanes.map(lane => join(target, '.forge/work', `lane-${lane.id}`))];
  const paths = roots.map(root => join(root, 'large.bin')),
    stats = paths.map(path => lstatSync(path));
  assert.equal(new Set(stats.map(stat => `${stat.dev}:${stat.ino}`)).size, paths.length);
  assert(stats.every(stat => stat.nlink === 1));
  for (const root of roots) {
    assert(lstatSync(join(root, 'run.sh')).mode & 0o100);
    assert.equal(new WorkStore(root).root, target);
  }
  writeFileSync(paths[1], 'independent edit');
  assert.equal(readFileSync(paths[0]).length, 3 * 1024 * 1024);
  assert.equal(readFileSync(paths[2]).length, 3 * 1024 * 1024);
  assert.equal(readFileSync(join(f.exported.path, 'manifest.json'), 'utf8'), f.exported.json);
  for (const file of f.manifest.files)
    assert.equal(digest(readFileSync(join(f.exported.path, file.path))), file.sha256);
  await assert.rejects(
    restoreNativeWork(f.exported.path, target),
    error => error.code === 'RESTORE_TARGET_EXISTS',
  );
  assert.equal(readFileSync(paths[1], 'utf8'), 'independent edit');
});

test('Lane materialization failure keeps destination absent and cleans scratch without changing the input', async t => {
  const f = await fixture(t),
    target = join(f.parent, 'failed'),
    original = NativeMaterialization.prototype.materialize;
  NativeMaterialization.prototype.materialize = function (id, path, marker = true) {
    if (path.endsWith(f.lanes[1].id))
      throw Object.assign(new Error('Simulated disk failure'), { code: 'ENOSPC' });
    return original.call(this, id, path, marker);
  };
  try {
    await assert.rejects(restoreNativeWork(f.exported.path, target), error => error.code === 'ENOSPC');
  } finally {
    NativeMaterialization.prototype.materialize = original;
  }
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(f.parent), []);
  assert.equal(readFileSync(join(f.exported.path, 'manifest.json'), 'utf8'), f.exported.json);
});

test('private owner staging preserves the existing Lane free-space check before publication', async t => {
  const f = await fixture(t),
    target = join(f.parent, 'disk-low'),
    previous = process.env.FORGE_DISK_BLOCK_GB;
  process.env.FORGE_DISK_BLOCK_GB = '1000000000';
  try {
    await assert.rejects(restoreNativeWork(f.exported.path, target), error => error.code === 'DISK_LOW');
  } finally {
    if (previous === undefined) delete process.env.FORGE_DISK_BLOCK_GB;
    else process.env.FORGE_DISK_BLOCK_GB = previous;
  }
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(join(f.exported.path, 'manifest.json'), 'utf8'), f.exported.json);
});

test('verified-byte budget only controls reuse and a new recovery still observes corrupt source', async t => {
  const f = await fixture(t),
    source = new NativeSource(f.owner),
    state = source.state(f.before.nativeHead),
    large = state.files.find(file => file.path === 'large.bin').blob;
  const small = new NativeMaterialization(f.owner, 1);
  assert.equal(small.object(large).length, 3 * 1024 * 1024);
  const reused = new NativeMaterialization(f.owner),
    copy = reused.object(large);
  copy[0] = 99;
  assert.equal(reused.object(large)[0], 17, 'Returned buffers cannot mutate retained verified bytes');
  writeFileSync(join(source.directory, large), 'corrupt');
  assert.throws(
    () => new NativeMaterialization(f.owner).object(large),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
});

test('streamed large recovery validates transport output and hands off only its disposable stage', async t => {
  const f = await fixture(t),
    target = join(f.parent, 'streamed'),
    streamed = [];
  const transport = {
    async manifest() {
      return {
        json: f.exported.json,
        size: Buffer.byteLength(f.exported.json),
        digest: digest(f.exported.json),
      };
    },
    async download(pin) {
      const file = f.manifest.files.find(file => file.sha256 === pin.sha256);
      return readFileSync(join(f.exported.path, file.path));
    },
    async downloadToFile(pin, path) {
      assert(pin.size > 2 * 1024 * 1024);
      writeFileSync(path, await this.download(pin), { mode: 0o400, flag: 'wx' });
      streamed.push({ path, stat: lstatSync(path), sha256: pin.sha256 });
    },
  };
  const result = await pullNativeExchange('fixture', target, transport);
  assert.equal(streamed.length, 1);
  assert.deepEqual(new WorkStore(target).load(), f.before);
  const moved = lstatSync(join(target, '.forge/work/objects', streamed[0].sha256));
  assert.equal(
    moved.mode & 0o777,
    0o600,
    'Moved physical files retain the existing owner-writable restore mode',
  );
  if (moved.dev === streamed[0].stat.dev)
    assert.equal(moved.ino, streamed[0].stat.ino, 'Private stage moves instead of recopying its payload');
  assert.equal(existsSync(streamed[0].path), false);
  assert.equal(result.transport, 'objects');
  assert.equal(readFileSync(join(f.exported.path, 'manifest.json'), 'utf8'), f.exported.json);
  const failed = join(f.parent, 'corrupt-stream');
  transport.downloadToFile = async (_, path) => writeFileSync(path, 'corrupt', { mode: 0o600, flag: 'wx' });
  await assert.rejects(
    pullNativeExchange('fixture', failed, transport),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(existsSync(failed), false);
});

test('private-stage cross-device fallback preserves content and excludes unlisted temporary files', async t => {
  const f = await fixture(t),
    stage = join(f.parent, 'private-stage'),
    target = join(f.parent, 'cross-device');
  cpSync(f.exported.path, stage, { recursive: true });
  writeFileSync(join(stage, 'unlisted.tmp'), 'not a manifest member', { mode: 0o600 });
  const rename = fs.renameSync;
  let fallbacks = 0;
  fs.renameSync = (from, to) => {
    if (from === stage) {
      fallbacks++;
      throw Object.assign(new Error('Cross device'), { code: 'EXDEV' });
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await restoreNativeExchangeStage(stage, target);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(fallbacks, 1);
  assert.deepEqual(new WorkStore(target).load(), f.before);
  assert.equal(existsSync(join(target, '.forge/work/unlisted.tmp')), false);
  assert.equal(readFileSync(join(f.exported.path, 'manifest.json'), 'utf8'), f.exported.json);
});
