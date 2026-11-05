// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundled, controlBuildKey } from '../scripts/control-build-key.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-build-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', '{}');
  write('package-lock.json', '{"lock":1}');
  write('tsconfig.json', '{}');
  write('scripts/prepare-convex-api.mjs', 'a');
  write('scripts/build-edit-hook.mjs', 'b');
  write('scripts/child-env.mjs', 'export const childEnv = 1;');
  write('scripts/child-env.d.mts', 'export const childEnv: number;');
  write('scripts/other-tool.mjs', 'runtime only');
  write(
    'src/agent-edit-hook.ts',
    "import { childEnv } from '../scripts/child-env.mjs';\nimport './util.js';",
  );
  write('src/util.ts', 'export {};');
  write('docs/guide.md', 'docs');
  write('convex/schema.ts', 'convex');
  return { root, write };
}

test('control build key follows the lockfile and build sources, not the commit or unrelated files', t => {
  const { root, write } = fixture(t);
  const key = controlBuildKey(root);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(controlBuildKey(root), key, 'stable for identical content');
  // A copy at another path (another checkout of any commit) has the same key.
  const copy = mkdtempSync(join(tmpdir(), 'forge-test-build-key-copy-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(root, copy, { recursive: true });
  assert.equal(controlBuildKey(copy), key);
  for (const [path, text] of [
    ['docs/guide.md', 'changed'],
    ['convex/schema.ts', 'changed'],
    ['scripts/other-tool.mjs', 'changed'],
    ['tests/new.test.mjs', 'new'],
    ['src/notes.md', 'not compiled'],
  ]) {
    write(path, text);
    assert.equal(controlBuildKey(root), key, `${path} does not feed the build`);
  }
  for (const [path, text] of [
    ['package-lock.json', '{"lock":2}'],
    ['package.json', '{"a":1}'],
    ['tsconfig.json', '{"a":1}'],
    ['src/util.ts', 'export const x = 1;'],
    ['src/added.ts', 'export {};'],
    ['scripts/child-env.mjs', 'export const childEnv = 2;'],
    ['scripts/child-env.d.mts', 'export const childEnv: string;'],
    ['scripts/build-edit-hook.mjs', 'changed'],
    ['scripts/prepare-convex-api.mjs', 'changed'],
  ]) {
    const before = controlBuildKey(root);
    write(path, text);
    assert.notEqual(controlBuildKey(root), before, `${path} feeds the build`);
  }
});

test('the key covers every module the vite bundle inlines and the repo build inputs exist', () => {
  const files = bundled('.', 'src/agent-edit-hook.ts');
  assert(files.includes('src/agent-edit-hook.ts'));
  assert(files.includes('scripts/child-env.mjs'), 'bundled scripts feed dist/agent-edit-hook.js');
  assert(!files.includes('scripts/hosted-actions-job.mjs'), 'entry points outside the bundle stay out');
  assert.match(controlBuildKey('.'), /^[0-9a-f]{64}$/);
});
