// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { writeCheckScope } from '../dist/work-check-scope.js';
import { fixture, write, git } from './helpers.mjs';
const output = t => {
  const path = mkdtempSync(join(tmpdir(), 'forge-scope-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
test('native comparison includes additions, removals, modifications and modes against pinned composed main', t => {
  const root = output(t);
  initNative(root);
  const source = new NativeSource(root);
  const blob = source.put(Buffer.from('before')),
    changed = source.put(Buffer.from('after'));
  const file = (path, bytes = blob, mode = 'file') => ({ path, blob: bytes, mode });
  const at = new Date().toISOString();
  const base = source.writeState(
    [file('removed.ts'), file('modified.ts'), file('mode.ts'), file('same.ts')],
    [],
    'base',
    at,
  );
  const head = source.writeState(
    [file('added.ts'), file('modified.ts', changed), file('mode.ts', blob, 'executable'), file('same.ts')],
    [base],
    'head',
    at,
  );
  const path = writeCheckScope(
    { native: true, root, load: () => ({ views: [] }) },
    { base: 'unused-intent-base', comparisonBase: base, head, mainCheck: { channel: 'main' } },
    output(t),
  );
  const input = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(input.base, base);
  assert.equal(input.head, head);
  assert.equal(input.comparison, 'main');
  assert.deepEqual(input.mainCheck, { channel: 'main' });
  assert.deepEqual(input.paths, ['added.ts', 'mode.ts', 'modified.ts', 'removed.ts']);
});
test('Git comparison uses immutable commits, includes deletions and ignores dirty files', t => {
  const root = fixture(t, { 'old.ts': 'old', 'same.ts': 'same' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  rmSync(join(root, 'old.ts'));
  write(root, 'new.ts', 'new');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'head']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  write(root, 'same.ts', 'dirty');
  const input = JSON.parse(
    readFileSync(
      writeCheckScope({ native: false, root }, { base, comparisonBase: base, head }, output(t)),
      'utf8',
    ),
  );
  assert.deepEqual(input.paths, ['new.ts', 'old.ts']);
  assert.equal(input.comparison, 'main');
});
