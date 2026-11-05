// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertRunnableSelection, guardSelection, ZeroSelectionError } from '../scripts/selection-guard.mjs';
import {
  advisorySelection,
  guardedSelection,
  smokeTests,
  standardSelection,
} from '../scripts/test-impact.mjs';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';
import { actionsGateSelection } from '../dist/hosted-actions-job-plan.js';

const smoke = smokeTests[0];
const withSmoke = () =>
  new Map([
    ['src/leaf.ts', 'export const leaf = 1;'],
    ['tests/a.test.mjs', ''],
    [smoke, ''],
  ]);
const documentation = path => path.endsWith('.md');
const input = (files, extra = {}) => ({ files, documentation, smoke: [smoke], ...extra });
const empty = { scope: 'scoped', reason: 'Fixture', tests: [] };

test('a code change that selects zero tests runs the fixed smoke set, never nothing', () => {
  const guarded = guardSelection(empty, input(withSmoke(), { paths: ['src/leaf.ts'] }));
  assert.deepEqual(guarded.tests, [smoke]);
  assert.equal(guarded.scope, 'scoped');
  assert.equal(guarded.guard, 'zero-selection');
  assert.match(guarded.reason, /Zero-selection guard.*smoke set/);
  assert.deepEqual(Object.keys(guarded.reasons), [smoke]);
});

test('with no smoke file the guard runs every test file; with none it fails closed with ZERO_SELECTION', () => {
  const noSmoke = new Map([
    ['tests/a.test.mjs', ''],
    ['tests/b.test.mjs', ''],
    ['src/x.ts', ''],
  ]);
  assert.deepEqual(guardSelection(empty, input(noSmoke)).tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.throws(
    () => guardSelection(empty, input(new Map([['src/x.ts', '']]), { paths: ['src/x.ts'] })),
    error =>
      error instanceof ZeroSelectionError &&
      error.code === 'ZERO_SELECTION' &&
      /no test file/.test(error.message),
  );
});

test('docs scope stays docs for Markdown but never carries a code path or a retry without paths', () => {
  const docs = { scope: 'docs', reason: 'Markdown', tests: [] };
  assert.equal(guardSelection(docs, input(withSmoke(), { paths: ['README.md'] })), docs);
  assert.equal(guardSelection(docs, input(withSmoke(), { interaction: {} })), docs);
  assert.equal(guardSelection(docs, input(withSmoke())), docs);
  const widened = guardSelection(docs, input(withSmoke(), { paths: ['README.md', 'src/leaf.ts'] }));
  assert.equal(widened.scope, 'full');
  assert.deepEqual(widened.tests, [smoke, 'tests/a.test.mjs'].sort());
});

test('selections that already name tests, and explicit partial evidence, pass through untouched', () => {
  const named = { scope: 'scoped', reason: 'Fixture', tests: ['tests/a.test.mjs'] };
  assert.equal(guardSelection(named, input(withSmoke())), named);
  const partial = { scope: 'partial', reason: 'Explicit', tests: [] };
  assert.equal(guardSelection(partial, input(withSmoke())), partial);
});

test('the standard selector never returns a non-docs selection with zero tests', () => {
  // No consumer, no smoke file: the graph selects nothing for this code change.
  const files = new Map([
    ['src/orphan.ts', 'export const orphan = 1;'],
    ['tests/other.test.mjs', "import 'node:test';"],
  ]);
  const selection = standardSelection({ files, paths: ['src/orphan.ts'], env: { FORGE_CHECK_SCOPED: '1' } });
  assert.notEqual(selection.scope, 'docs');
  assert.ok(selection.tests.length > 0);
  assert.ok(selection.tests.every(path => files.has(path)));
  assert.throws(
    () =>
      standardSelection({
        files: new Map([['src/orphan.ts', 'export const orphan = 1;']]),
        paths: ['src/orphan.ts'],
        env: { FORGE_CHECK_SCOPED: '1' },
      }),
    { code: 'ZERO_SELECTION' },
  );
  assert.equal(
    standardSelection({ files, paths: ['docs/a.md'], env: { FORGE_CHECK_SCOPED: '1' } }).scope,
    'docs',
  );
  assert.deepEqual(guardedSelection(empty, { files: withSmoke(), paths: ['src/leaf.ts'] }).tests, [smoke]);
});

test('hosted gate planning: a probe or contract gate with no tests runs smoke instead of passing empty', () => {
  const files = withSmoke();
  for (const gate of [
    { mode: 'probe', tests: [], reason: 'Failed-file probe' },
    { mode: 'contract', tests: [], contractVersion: 1, reason: 'Empty contract' },
  ]) {
    const selected = actionsGateSelection({ gate }, ['src/leaf.ts'], files, true);
    assert.ok(selected.tests.length > 0, gate.mode);
    assert.equal(selected.guard, 'zero-selection', gate.mode);
  }
  // An exact configured command has no test selection by design.
  assert.deepEqual(actionsGateSelection({}, ['src/leaf.ts'], files, false).tests, []);
});

test('the runner refuses a pinned selection with no test file unless it is the static job, docs or partial', () => {
  for (const selection of [{ scope: 'scoped' }, { scope: 'full' }, { scope: 'interaction' }])
    assert.throws(() => assertRunnableSelection(selection, []), { code: 'ZERO_SELECTION' });
  assertRunnableSelection({ scope: 'scoped' }, [], true);
  assertRunnableSelection({ scope: 'docs' }, []);
  assertRunnableSelection({ scope: 'partial' }, []);
  assertRunnableSelection({ scope: 'scoped' }, ['tests/a.test.mjs']);
  assertRunnableSelection(null, []);
});

test('an Actions plan for code with no test shard, or an empty shard, fails instead of passing', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-zero-selection-'));
  const previous = {
    cwd: process.cwd(),
    plan: process.env.FORGE_ACTIONS_PLAN,
    shard: process.env.FORGE_ACTIONS_SHARD,
  };
  t.after(() => {
    process.chdir(previous.cwd);
    for (const [key, value] of [
      ['FORGE_ACTIONS_PLAN', previous.plan],
      ['FORGE_ACTIONS_SHARD', previous.shard],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const plan = (selection, groups) => {
    mkdirSync(dirname(join(root, 'plan.json')), { recursive: true });
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ standard: true, selection, groups }));
  };
  process.chdir(root);
  process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
  const calls = [];
  const execute = (command, args) => calls.push([command, ...args]);
  process.env.FORGE_ACTIONS_SHARD = 'static';
  plan({ scope: 'scoped', reason: 'Fixture', tests: [] }, []);
  assert.throws(() => runActionsCheck(execute), /ZERO_SELECTION/);
  assert.equal(calls.filter(call => call.includes('scripts/verify.mjs')).length, 0);
  process.env.FORGE_ACTIONS_SHARD = '0';
  plan({ scope: 'scoped', reason: 'Fixture', tests: ['tests/a.test.mjs'] }, [[]]);
  assert.throws(() => runActionsCheck(execute), /ZERO_SELECTION/);
  assert.equal(calls.filter(call => call.includes('scripts/test-files.mjs')).length, 0);
  // Docs candidates legitimately have no test shard.
  process.env.FORGE_ACTIONS_SHARD = 'static';
  plan({ scope: 'docs', reason: 'Markdown', tests: [] }, []);
  assert.doesNotThrow(() => runActionsCheck(execute, { install: false }));
});

test('read-only reports of a source with no test file say so instead of failing; checks still fail closed', () => {
  const files = new Map([['src/orphan.ts', 'export const orphan = 1;']]);
  const input = { files, paths: ['src/orphan.ts'], env: { FORGE_CHECK_SCOPED: '1' } };
  assert.throws(() => standardSelection(input), { code: 'ZERO_SELECTION' });
  const report = advisorySelection(input);
  assert.deepEqual(report.tests, []);
  assert.match(report.reason, /ZERO_SELECTION/);
  assert.deepEqual(advisorySelection({ ...input, files: withSmoke(), paths: ['src/leaf.ts'] }).tests, [
    smoke,
  ]);
});
