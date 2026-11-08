// SPDX-License-Identifier: Apache-2.0
// Opt-in docs-only paths per check (like GitHub's paths-ignore): Issue 24e0948f.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCS_PATHS_MAX,
  declaredTestedDocs,
  docsOnlyChange,
  docsPathsSchema,
  isDocsPath,
} from '../dist/docs-paths.js';
import { actionsGateSelection } from '../dist/hosted-actions-job-plan.js';
import { hostedCheckCommandSchema, hostedCheckDefinition, testsNotAffected } from '../dist/hosted-check.js';
import { pinnedTestedDocs } from '../dist/tested-docs.js';

const command = { name: 'verify', executable: 'bash', args: ['ci/check.sh'], environmentLabel: '' };
const opaque = (docsPaths, extra = {}) => ({
  check: { executable: 'bash', args: ['ci/check.sh'], definition: 'd'.repeat(64), docsPaths },
  ...extra,
});
const select = (run, paths) => actionsGateSelection(run, paths, new Map(), false);

test('docs globs match like paths-ignore, in any directory layout', () => {
  const globs = ['**/*.md', 'docs/**', 'LICENSE'];
  for (const path of ['README.md', 'packages/a/README.md', 'docs/site/a.png', 'docs/x', 'LICENSE'])
    assert.ok(isDocsPath(globs, path), path);
  for (const path of ['src/a.ts', 'packages/a/src/index.ts', 'README.md.bak', 'LICENSE.txt', 'xdocs/a'])
    assert.equal(isDocsPath(globs, path), false, path);
});

test('a change is docs-only only when it exists and every changed path matches', () => {
  const globs = ['**/*.md'];
  assert.equal(docsOnlyChange(globs, ['README.md', 'docs/a.md']), true);
  assert.equal(docsOnlyChange(globs, ['README.md', 'src/a.ts']), false);
  assert.equal(docsOnlyChange(globs, []), false);
  // The default is safe: nothing declared, nothing skipped.
  assert.equal(docsOnlyChange(undefined, ['README.md']), false);
  assert.equal(docsOnlyChange([], ['README.md']), false);
});

test('the setting accepts only safe repository-relative globs, in a bounded list', () => {
  assert.ok(docsPathsSchema.safeParse(['docs/**', '**/*.md']).success);
  for (const bad of [
    [],
    [''],
    ['/etc/**'],
    ['../x/**'],
    ['docs/[a'],
    ['a'.repeat(201)],
    ['a/**'].concat(['']),
    Array.from({ length: DOCS_PATHS_MAX + 1 }, (_, i) => `d${i}/**`),
  ])
    assert.equal(docsPathsSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
});

test('an opaque command runs in full by default and when a change touches any other path', () => {
  assert.equal(select(opaque(undefined), ['README.md']).scope, 'full');
  assert.equal(select(opaque(['**/*.md']), ['README.md', 'packages/a/src/x.ts']).scope, 'full');
  assert.equal(select(opaque(['**/*.md']), []).scope, 'full');
});

test('an opaque command with declared docs paths gets the docs scope and selects no test', () => {
  const selected = select(opaque(['**/*.md', 'docs/**']), ['README.md', 'docs/a/b.png']);
  assert.equal(selected.scope, 'docs');
  assert.deepEqual(selected.tests, []);
  assert.match(selected.reason, /docs paths/);
});

test('audit and probe runs keep the whole opaque command', () => {
  const paths = ['README.md'];
  assert.equal(select(opaque(['**/*.md'], { gate: { mode: 'audit' } }), paths).scope, 'full');
  assert.equal(select(opaque(['**/*.md'], { gate: { mode: 'probe', tests: [] } }), paths).scope, 'full');
});

test('tests are reported as not affected only for the standard check or declared docs paths', () => {
  const docs = { scope: 'docs', reason: 'Every changed path matches', tests: [] };
  assert.equal(testsNotAffected(docs, false), undefined);
  assert.equal(testsNotAffected(docs, false, []), undefined);
  assert.deepEqual(testsNotAffected(docs, false, ['**/*.md']), {
    part: 'tests',
    status: 'not-affected',
    reason: docs.reason,
  });
  assert.equal(testsNotAffected({ ...docs, scope: 'full' }, false, ['**/*.md']), undefined);
});

test('only Markdown outside the declared docs paths counts as tested for first-check reuse', () => {
  const files = ['README.md', 'docs/a.md', 'tools/schema.md', 'src/a.ts', 'packages/a/CHANGELOG.md'];
  assert.equal(declaredTestedDocs(undefined, files), undefined, 'nothing declared: every Markdown is tested');
  const pinned = declaredTestedDocs(['README.md', 'docs/**', '**/CHANGELOG.md'], files);
  assert.deepEqual(pinned.paths, ['tools/schema.md']);
  assert.deepEqual([...pinnedTestedDocs({ testedDocs: pinned })], ['tools/schema.md']);
});

test('the docs paths belong to the check definition and its digest', () => {
  const plain = hostedCheckDefinition(
    command,
    'a'.repeat(8) + '-0000-4000-8000-000000000000',
    '2026-11-08T00:00:00.000Z',
  );
  const declared = hostedCheckDefinition(
    { ...command, docsPaths: ['**/*.md', '**/*.md'] },
    plain.id,
    plain.at,
  );
  assert.deepEqual(declared.docsPaths, ['**/*.md']);
  assert.notEqual(declared.definition, plain.definition);
  assert.equal(plain.docsPaths, undefined);
  assert.equal(hostedCheckCommandSchema.safeParse({ ...command, docsPaths: ['/abs/**'] }).success, false);
});
