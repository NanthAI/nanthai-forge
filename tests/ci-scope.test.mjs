// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { classifyGitChanges, classifyPaths } from '../scripts/ci-scope.mjs';

const manifest = {
  files: ['dist', 'README.md', 'docs/status.md', 'docs/vendor-notices/native-components'],
};
const classify = (paths, manifests = [manifest, manifest]) => classifyPaths(paths, manifests).scope;
test('real package manifest permits packaged and root Markdown docs', () => {
  const actual = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(actual.files.includes('docs'));
  for (const path of [
    'docs/concepts.md',
    'docs/agents/workflow.md',
    'docs/operations/optimistic-landing.md',
    'PRODUCT.md',
    'DESIGN.md',
  ])
    assert.equal(classify([path], [actual, actual]), 'docs', path);
});
test('unpackaged prose uses foundation', () => {
  assert.equal(classify(['docs/notes.md', 'docs/drafts/collaboration.md']), 'docs');
});
test('packaged Markdown documents and deleted entries use documentation checks', () => {
  for (const path of ['README.md', 'docs/status.md', 'docs/vendor-notices/native-components/LICENSE.md'])
    assert.equal(classify([path]), 'docs', path);
  assert.equal(classify(['docs/status.md'], [manifest, { files: ['dist'] }]), 'docs');
});
test('code, tests, scripts, workflows, skills and unknown paths require full verification', () => {
  for (const path of [
    'src/index.ts',
    'tests/agent-finish.test.mjs',
    'scripts/ci-scope.mjs',
    '.github/workflows/foundation.yml',
    'skills/forge-agent/SKILL.md',
    'package-lock.json',
    'docs/evidence/fixture.js',
    'docs/evidence/unknown.json',
    'docs/../src/hidden.md',
    'docs/line\nbreak.md',
    'docs/\ufffd.md',
  ])
    assert.equal(classify([path]), 'full', path);
  assert.equal(classify(['docs/notes.md', 'src/index.ts']), 'full');
});
test('absent paths or uncertain package selection never skip full verification', () => {
  for (const paths of [[], null, ['']]) assert.equal(classify(paths), 'full');
  for (const manifests of [[], [manifest], [manifest, {}], [manifest, { files: ['docs/**/*.md'] }]])
    assert.equal(classify(['docs/notes.md'], manifests), 'full');
});
function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-ci-scope-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  git('init', '--quiet');
  git('config', 'user.name', 'CI scope fixture');
  git('config', 'user.email', 'ci-scope@example.invalid');
  put('package.json', JSON.stringify(manifest));
  put('docs/notes.md', 'Initial documentation\n');
  put('docs/status.md', 'Initial status\n');
  put('src/code.ts', 'export const value = 1;\n');
  const commit = () => {
    git('add', '--all');
    git('commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const base = commit();
  const scope = (head, extras = {}) =>
    classifyGitChanges({ cwd, eventName: 'pull_request', base, head, ...extras });
  return { cwd, base, put, commit, scope };
}
test('actual pinned Git diff ignores dirty checkout and reads exact commits', t => {
  const r = repository(t);
  r.put('docs/notes.md', 'Committed prose\n');
  const head = r.commit();
  r.put('src/code.ts', 'Uncommitted source\n');
  assert.equal(r.scope(head).scope, 'docs');
  assert.equal(r.scope(head, { eventName: 'push' }).scope, 'docs');
});
test('actual source deletion and rename into documentation require full verification', t => {
  const r = repository(t);
  renameSync(join(r.cwd, 'src/code.ts'), join(r.cwd, 'docs/renamed.md'));
  assert.equal(r.scope(r.commit()).scope, 'full');
  r.put('src/code.ts', 'Restored fixture\n');
  const base = r.commit();
  rmSync(join(r.cwd, 'src/code.ts'));
  assert.equal(r.scope(r.commit(), { base }).scope, 'full');
});
test('actual documentation deletion and rename remain documentation', t => {
  const r = repository(t);
  renameSync(join(r.cwd, 'docs/notes.md'), join(r.cwd, 'docs/renamed.md'));
  assert.equal(r.scope(r.commit()).scope, 'docs');
  rmSync(join(r.cwd, 'docs/renamed.md'));
  assert.equal(r.scope(r.commit()).scope, 'docs');
});
test('packaged documentation deletion uses docs validation; a manifest change runs full', t => {
  const r = repository(t);
  rmSync(join(r.cwd, 'docs/status.md'));
  assert.equal(r.scope(r.commit()).scope, 'docs');
  r.put('package.json', JSON.stringify({ files: ['dist'] }));
  assert.equal(r.scope(r.commit()).scope, 'full');
});
test('manual, unknown, empty, zero and unavailable exact Git pins require full verification', t => {
  const r = repository(t);
  assert.equal(r.scope(r.base).scope, 'full');
  for (const extras of [
    { eventName: 'workflow_dispatch' },
    { eventName: 'unknown' },
    { base: undefined },
    { head: undefined },
    { base: '0'.repeat(40) },
    { head: '--help' },
    { base: 'f'.repeat(40) },
  ])
    assert.equal(r.scope(r.base, extras).scope, 'full');
  assert.equal(
    classifyGitChanges({ cwd: join(r.cwd, 'missing'), eventName: 'push', base: r.base, head: r.base }).scope,
    'full',
  );
});
test('malformed committed package metadata fails toward full verification', t => {
  const r = repository(t);
  r.put('package.json', '{invalid');
  r.put('docs/notes.md', 'Updated\n');
  assert.equal(r.scope(r.commit()).scope, 'full');
});
test('CLI writes only a fixed scope value, including missing-input fallback', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-ci-output-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const output = join(cwd, 'output');
  const stdout = execFileSync(
    process.execPath,
    [new URL('../scripts/ci-scope.mjs', import.meta.url).pathname],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CI_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output },
    },
  );
  assert.equal(JSON.parse(stdout).scope, 'full');
  assert.equal(readFileSync(output, 'utf8'), 'scope=full\n');
});
test('CLI uses supplied exact PR pins for documentation scope output', t => {
  const r = repository(t);
  r.put('docs/notes.md', 'Updated prose\n');
  const head = r.commit();
  const output = join(r.cwd, 'ci-output');
  const stdout = execFileSync(
    process.execPath,
    [new URL('../scripts/ci-scope.mjs', import.meta.url).pathname],
    {
      cwd: r.cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI_EVENT_NAME: 'pull_request',
        CI_BASE_SHA: r.base,
        CI_HEAD_SHA: head,
        GITHUB_OUTPUT: output,
      },
    },
  );
  assert.equal(JSON.parse(stdout).scope, 'docs');
  assert.equal(readFileSync(output, 'utf8'), 'scope=docs\n');
});

test('docs checks preserve package inventory and original-notice validation without building', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-documents-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  cpSync(new URL('../docs/', import.meta.url), join(cwd, 'docs'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), readFileSync(new URL('../package.json', import.meta.url)));
  const check = () =>
    execFileSync(process.execPath, [new URL('../scripts/check-documents.mjs', import.meta.url).pathname], {
      cwd,
      stdio: 'pipe',
    });
  assert.match(check().toString(), /original notice hashes verified/);
  writeFileSync(join(cwd, 'docs/unlisted.md'), 'Unlisted packaged prose\n');
  assert.throws(
    check,
    /Unlisted packaged document: docs\/unlisted\.md\. Add it to packageDocuments in scripts\/package-documents\.mjs/,
  );
  rmSync(join(cwd, 'docs/unlisted.md'));
  rmSync(join(cwd, 'docs/concepts.md'));
  assert.throws(check, /Missing packaged document/);
  writeFileSync(join(cwd, 'docs/concepts.md'), readFileSync(new URL('../docs/concepts.md', import.meta.url)));
  writeFileSync(join(cwd, 'docs/vendor-notices/convex-backend-LICENSE.md'), 'Changed original bytes\n');
  assert.throws(check, /AssertionError/);
});
