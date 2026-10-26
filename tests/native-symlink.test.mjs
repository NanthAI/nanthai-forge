import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { NativeSource, nativeMarker } from '../dist/native-source.js';
import { nativeDiff } from '../dist/native-diff.js';
import { nativeFile } from '../dist/native-file.js';
import { syncWorkspace, syncTestHooks } from '../dist/native-sync-workspace.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-native-symlink-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = join(root, 'owner');
  mkdirSync(owner);
  nativeMarker(owner);
  return { root, owner, source: new NativeSource(owner) };
}
test('capture and live review retain link target bytes without reading external files or symlink parents', t => {
  const f = fixture(t),
    external = join(f.root, 'outside');
  writeFileSync(external, 'PRIVATE TARGET CONTENT');
  symlinkSync(external, join(f.owner, 'link'));
  const files = f.source.capture(f.owner, true),
    entry = files.find(file => file.path === 'link');
  assert.equal(entry.mode, 'symlink');
  assert.equal(f.source.object(entry.blob).toString(), external);
  const diff = nativeDiff(f.source, [], files, f.owner);
  assert.ok(diff.includes(external));
  assert.ok(!diff.includes('PRIVATE TARGET CONTENT'));
  symlinkSync(f.root, join(f.owner, 'redirect'));
  assert.throws(
    () => nativeFile(f.owner, 'redirect/outside'),
    error => error.code === 'UNSAFE_PATH',
  );
  assert.equal(readFileSync(external, 'utf8'), 'PRIVATE TARGET CONTENT');
});
test('staged Lane checkout and interrupted sync preserve symlinks and file/link transitions', t => {
  const f = fixture(t),
    link = { path: 'link', mode: 'symlink', blob: f.source.put(Buffer.from('../missing')) };
  const head = f.source.writeState([link], [], 'link', '2026-01-01T00:00:00Z');
  const lane = join(f.owner, '.forge', 'work', `lane-${randomUUID()}`);
  f.source.materialize(head, lane);
  assert.ok(lstatSync(join(lane, 'link')).isSymbolicLink());
  assert.equal(readlinkSync(join(lane, 'link')), '../missing');
  const regular = { path: 'link', mode: 'file', blob: f.source.put(Buffer.from('regular bytes')) };
  syncWorkspace(f.source, lane, head, [link], [regular]);
  assert.equal(readFileSync(join(lane, 'link'), 'utf8'), 'regular bytes');
  const after = f.source.writeState([regular], [head], 'regular', '2026-01-01T00:00:01Z');
  syncTestHooks.afterReplace = () => {
    throw Error('crash');
  };
  t.after(() => {
    delete syncTestHooks.afterReplace;
  });
  assert.throws(() => syncWorkspace(f.source, lane, after, [regular], [link]), /crash/);
  delete syncTestHooks.afterReplace;
  syncWorkspace(f.source, lane, after, [regular], [link]);
  assert.equal(readlinkSync(join(lane, 'link')), '../missing');
});
test('divergent symlink targets and incompatible mode changes remain conflicts', t => {
  const f = fixture(t),
    entry = (mode, text) => ({ path: 'link', mode, blob: f.source.put(Buffer.from(text)) });
  const at = '2026-01-01T00:00:00Z',
    base = f.source.writeState([entry('symlink', 'a\nb\nc\n')], [], 'base', at);
  const left = f.source.writeState([entry('symlink', 'A\nb\nc\n')], [base], 'left', at),
    right = f.source.writeState([entry('symlink', 'a\nb\nC\n')], [base], 'right', at);
  assert.deepEqual(f.source.compose(left, right, 'merge', at).conflicts, ['link']);
  const original = f.source.writeState([entry('file', 'target')], [], 'regular', at);
  const link = f.source.writeState([entry('symlink', 'target')], [original], 'link', at),
    exec = f.source.writeState([entry('executable', 'target')], [original], 'exec', at);
  assert.deepEqual(f.source.compose(link, exec, 'merge', at).conflicts, ['link']);
});
