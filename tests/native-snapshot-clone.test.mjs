// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource } from '../dist/native-source.js';
import { snapshotBlob } from '../dist/native-snapshot-clone.js';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { readAutoSnapshot, snapshotLane } from '../dist/lane-auto-snapshot.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-snapshot-clone-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new NativeSource(root);
  source.put(Buffer.from('seed object directory'));
  return { root, source, path: join(root, 'live.bin'), bytes: Buffer.alloc(8 * 1024 * 1024, 37) };
}
function replaceClone(t, replacement) {
  const originalExec = childProcess.execFileSync,
    originalCopy = fs.copyFileSync;
  childProcess.execFileSync = (file, args, options) =>
    file === '/bin/cp'
      ? replacement(() => originalExec(file, args, options), args.at(-1))
      : originalExec(file, args, options);
  fs.copyFileSync = (source, destination, flags) =>
    flags & fs.constants.COPYFILE_FICLONE_FORCE
      ? replacement(() => originalCopy(source, destination, flags), destination)
      : originalCopy(source, destination, flags);
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFileSync = originalExec;
    fs.copyFileSync = originalCopy;
    syncBuiltinESMExports();
  });
}

test('snapshot blob clones preserve captured bytes after later edits to the live file', t => {
  const f = fixture(t);
  writeFileSync(f.path, f.bytes);
  const retained = snapshotBlob(f.source, f.path, f.bytes, false);
  writeFileSync(f.path, 'later edit');
  assert.deepEqual(f.source.object(retained.blob), f.bytes);
  assert.equal(fs.lstatSync(join(f.source.directory, retained.blob)).nlink, 1);
  assert.equal(fs.lstatSync(join(f.source.directory, retained.blob)).mode & 0o777, 0o600);
  assert.ok(['clone', 'copy'].includes(retained.storage.method));
  assert.equal(
    readdirSync(f.source.directory).some(name => name.endsWith('.tmp')),
    false,
  );
});

test('a changed clone retains the original capture and records its reason', t => {
  const f = fixture(t);
  writeFileSync(f.path, f.bytes);
  // Simulate a clone that succeeded but captured a concurrent edit; real clones are
  // unavailable on some filesystems (Linux CI returns ENOTSUP).
  replaceClone(t, (_clone, target) => {
    writeFileSync(target, 'concurrent edit');
  });
  const retained = snapshotBlob(f.source, f.path, f.bytes, false);
  assert.deepEqual(f.source.object(retained.blob), f.bytes);
  assert.deepEqual(retained.storage, { method: 'copy', reason: 'source-changed-during-clone' });
  assert.equal(
    readdirSync(f.source.directory).some(name => name.endsWith('.tmp')),
    false,
  );
});

test('unsupported snapshot clones use copy fallback with an explicit reason', t => {
  const f = fixture(t);
  writeFileSync(f.path, f.bytes);
  replaceClone(t, () => {
    throw Object.assign(new Error('Unsupported filesystem'), { code: 'ENOTSUP' });
  });
  const retained = snapshotBlob(f.source, f.path, f.bytes, false);
  assert.deepEqual(f.source.object(retained.blob), f.bytes);
  assert.deepEqual(retained.storage, { method: 'copy', reason: 'ENOTSUP' });
});

test(
  'snapshot clones do not carry source xattrs or file flags into retained objects',
  { skip: process.platform !== 'darwin' },
  t => {
    const f = fixture(t);
    writeFileSync(f.path, f.bytes);
    childProcess.execFileSync('/usr/bin/xattr', ['-w', 'com.nanthai.fixture', 'source-only', f.path]);
    childProcess.execFileSync('/usr/bin/xattr', [
      '-w',
      'com.apple.quarantine',
      '0081;fixture;fixture;',
      f.path,
    ]);
    childProcess.execFileSync('/usr/bin/chflags', ['hidden', f.path]);
    const retained = snapshotBlob(f.source, f.path, f.bytes, false),
      target = join(f.source.directory, retained.blob);
    const attributes = childProcess.execFileSync('/usr/bin/xattr', [target], { encoding: 'utf8' });
    // macOS may attach its own provenance attribute even to fresh byte writes.
    assert.equal(attributes.includes('com.nanthai.fixture'), false);
    assert.equal(attributes.includes('com.apple.quarantine'), false);
    assert.equal(
      childProcess.execFileSync('/usr/bin/stat', ['-f', '%f', target], { encoding: 'utf8' }).trim(),
      '0',
    );
    assert.equal(
      childProcess
        .execFileSync('/usr/bin/xattr', ['-p', 'com.nanthai.fixture', f.path], { encoding: 'utf8' })
        .trim(),
      'source-only',
    );
    assert.deepEqual(f.source.object(retained.blob), f.bytes);
  },
);

test('automatic snapshot restores identical binary bytes, executable modes, links and deletions', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'delete.txt'), 'remove later');
  writeFileSync(join(f.root, 'run'), 'original');
  initNative(f.root);
  const agent = new AgentWorkflow(f.root),
    lane = (await agent.dispatch({ action: 'start', outcome: 'Snapshot restore' })).result;
  writeFileSync(join(lane.path, 'binary.bin'), f.bytes);
  writeFileSync(join(lane.path, 'run'), 'changed executable');
  chmodSync(join(lane.path, 'run'), 0o700);
  symlinkSync('binary.bin', join(lane.path, 'link'));
  rmSync(join(lane.path, 'delete.txt'));
  const result = snapshotLane(agent.work.store, lane.laneId);
  assert.equal(result.status, 'snapshot');
  const pointer = readAutoSnapshot(agent.work.store, lane.laneId);
  assert.equal(pointer.storage.cloned + pointer.storage.copied, 2);
  const restored = join(f.root, '.forge/work', `lane-${randomUUID()}`);
  f.source.materialize(result.state, restored);
  assert.deepEqual(f.source.capture(restored, false, result.state), f.source.state(result.state).files);
  assert.deepEqual(readFileSync(join(restored, 'binary.bin')), f.bytes);
  assert.equal(existsSync(join(restored, 'delete.txt')), false);
  assert.equal(agent.work.store.select('lanes', lane.laneId).head, lane.head);
});
