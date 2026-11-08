// SPDX-License-Identifier: Apache-2.0
// One documentation rule for every selector (Issue c2f6a26a): `.txt` is prose only by name or under a
// docs folder; fixture and test-data files are never documentation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { documentationPath } from '../dist/prose-paths.js';
import { packageTestSelection } from '../dist/package-test-selection.js';
import { buildPackageGraph } from '../dist/package-graph.js';
import { runnerSelection } from '../dist/project-test-runner.js';

test('documentationPath: prose by extension or prose name; data otherwise', () => {
  for (const path of [
    'README.md',
    'docs/guide.mdx',
    'docs/api.rst',
    'manual/intro.adoc',
    'LICENSE.txt',
    'pkg/NOTICE.txt',
    'THIRD_PARTY_NOTICES.txt',
    'llms.txt',
    'docs/notes.txt',
    'tests/README.md',
  ])
    assert.equal(documentationPath(path), true, path);
  for (const path of [
    'requirements.txt',
    'requirements-dev.txt',
    'constraints.txt',
    'CMakeLists.txt',
    'bindings/CMakeLists.txt',
    'meson_options.txt',
    'tests/fixtures/expected.txt',
    'tests/fixtures/expected.md',
    'pkg/a/testdata/golden.txt',
    'src/__snapshots__/a.test.ts.snap.md',
    'spec/fixtures/files/a.md',
    'tests/expected-output.md',
    'src/data/words.txt',
  ])
    assert.equal(documentationPath(path), false, path);
});

test('replay: a fixture- or dependency-only change is never planned as docs-only', () => {
  const tree = { 'pyproject.toml': '[project]\nname = "root"\n' };
  const graph = buildPackageGraph(Object.keys(tree), path => tree[path]);
  for (const changed of [['tests/fixtures/expected.txt'], ['requirements.txt'], ['CMakeLists.txt']])
    assert.notEqual(packageTestSelection(graph, changed).scope, 'docs', changed[0]);
  assert.equal(packageTestSelection(graph, ['README.md', 'LICENSE.txt']).scope, 'docs');
  const runner = {
    source: 'declared',
    program: 'declared',
    globs: ['**/*.test.js'],
    command: ['t'],
    layout: 'generic',
  };
  // Before: `.txt` was docs here, so a fixture-only change planned "docs-only" and ran nothing.
  assert.notEqual(runnerSelection(runner, ['a.test.js'], ['tests/fixtures/expected.txt']).scope, 'docs');
  assert.equal(runnerSelection(runner, ['a.test.js'], ['docs/a.md']).scope, 'docs');
});

test('guard: no selector keeps its own documentation regex with .txt', () => {
  // A second list drifts (requirements.txt was docs to one selector and a manifest to another).
  const allowed = new Set([
    'prose-paths.ts', // the one rule
    'first-check-risk-v4.ts', // a frozen, versioned copy for stored proofs
    'intent-test-contract.ts', // excludes document extensions from test names, never skips a change
  ]);
  const offenders = readdirSync(new URL('../src/', import.meta.url))
    .filter(name => name.endsWith('.ts') && !allowed.has(name))
    .filter(name =>
      /md\|[^/\n]*\btxt\b|\btxt\|[^/\n]*\bmd\b/.test(
        readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'),
      ),
    );
  assert.deepEqual(offenders, [], 'use documentationPath from src/prose-paths.ts');
});
