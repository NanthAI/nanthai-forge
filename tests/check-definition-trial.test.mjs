// SPDX-License-Identifier: Apache-2.0
// Item 687d1eda, 'Check-definition changes': a change to Forge's own check definition gets main's
// full check plus a trial of its own definition, run in addition, never instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { actionsGateSelection } from '../dist/hosted-actions-job-plan.js';
import {
  declaresDefinitionTrial,
  definitionTrialPaths,
  definitionTrialShard,
  runDefinitionTrial,
  selectionModules,
} from '../dist/check-definition-trial.js';

const standardCheck = { executable: 'node', args: ['scripts/forge-check.mjs'], definition: 'c'.repeat(64) };
/** A small synthetic tree: one source file, its test, and an unrelated test. */
const tree = (extra = []) =>
  new Map([
    ['package.json', '{"name":"synthetic","scripts":{"test":"node --test"}}'],
    ['package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'synthetic' } } })],
    ['src/a.ts', 'export const a = 1;'],
    ['src/b.ts', 'export const b = 1;'],
    ['tests/a.test.mjs', "import '../src/a.js';"],
    ['tests/b.test.mjs', "import '../src/b.js';"],
    ['scripts/test-impact.mjs', 'export const synthetic = 1;'],
    ['scripts/browser-test-policy.mjs', 'export const synthetic = 1;'],
    ...extra,
  ]);
const contractRun = { gate: { mode: 'contract', tests: ['tests/a.test.mjs'] }, check: standardCheck };

test('a check-definition change runs main’s full check plus a pinned trial; any other change is untouched', () => {
  const files = tree();
  const ordinary = actionsGateSelection(contractRun, ['src/a.ts'], files, true);
  assert.equal(ordinary.scope, 'scoped');
  assert.deepEqual(ordinary.tests, ['tests/a.test.mjs']);
  assert.equal(
    'trial' in ordinary,
    false,
    'no trial and no pinned field: the recipe and its cost stay as before',
  );
  // The contract gate alone would run only its declared test for this selection-policy change.
  const definition = actionsGateSelection(contractRun, ['scripts/browser-test-policy.mjs'], files, true);
  assert.equal(definition.scope, 'full', 'never narrower than main’s full check');
  assert.deepEqual(definition.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.deepEqual(definition.trial, { paths: ['scripts/browser-test-policy.mjs'] });
  assert.match(
    definition.reason,
    /^Check-definition change \(scripts\/browser-test-policy\.mjs\): main's full check/,
  );
  // A gate that already chose full keeps its own selection and reason, with the trial beside it.
  const full = actionsGateSelection(contractRun, ['scripts/forge-check.mjs'], files, true);
  assert.equal(full.scope, 'full');
  assert.deepEqual(full.trial, { paths: ['scripts/forge-check.mjs'] });
  // Another configured command keeps its own selection: the trial is Forge's standard check only.
  assert.equal(
    'trial' in
      actionsGateSelection(
        {
          ...contractRun,
          check: { executable: 'make', args: ['check'] },
          candidate: { base: { head: 'a'.repeat(64) } },
          request: { expectedHead: 'b'.repeat(64) },
        },
        ['scripts/test-impact.mjs'],
        files,
        false,
      ),
    false,
  );
});

test('the definition paths: entry, inputs, selection inputs and the Actions workflow; not other .github files', () => {
  for (const path of [
    'scripts/forge-check.mjs',
    'scripts/github-actions-check.mjs',
    'scripts/test-files.mjs',
    'scripts/browser-test-policy.mjs',
    'scripts/check-contract.mjs',
    '.github/workflows/forge-check.yml',
  ])
    assert.deepEqual(
      definitionTrialPaths(standardCheck, undefined, [path, 'src/a.ts']),
      { paths: [path] },
      path,
    );
  for (const path of [
    'src/a.ts',
    '.github/ISSUE_TEMPLATE/bug.md',
    '.github/workflows/web-deploy.yml',
    'docs/x.md',
  ])
    assert.equal(definitionTrialPaths(standardCheck, undefined, [path]), null, path);
  // A main audit or failed-file probe judges no change before it lands.
  for (const mode of ['audit', 'probe'])
    assert.equal(definitionTrialPaths(standardCheck, { mode }, ['scripts/forge-check.mjs']), null, mode);
  const many = Array.from({ length: 25 }, (_, i) => `scripts/test-n${i}.mjs`);
  assert.deepEqual(definitionTrialPaths(standardCheck, undefined, many), {
    paths: many.slice(0, 20),
    more: 5,
  });
});

test('Item 687d1eda: a Lane that changes a module scripts/test-impact.mjs imports gets main’s full check plus the trial', () => {
  // The selector's own imports decide which tests run (lead 2026-11-20), read from the inventory as text.
  const modules = ['selection-guard', 'core-queue-paths', 'script-impact', 'docs-readers'];
  const files = tree([
    [
      'scripts/test-impact.mjs',
      modules.map(name => `import { x } from './${name}.mjs';`).join('\n') +
        "\nimport './side-effect.mjs';\nimport { y } from '../src/a.js';" +
        "\nconst lazy = () => import('./lazy-selector.mjs');\nexport const standardSelection = lazy;",
    ],
    ...modules.map(name => [`scripts/${name}.mjs`, '']),
    ['scripts/docs-readers.mjs', "import { scan } from './tree-scan.mjs';"],
    ['scripts/tree-scan.mjs', ''],
    ['scripts/lazy-selector.mjs', ''],
    ['scripts/side-effect.mjs', ''],
    ['scripts/unrelated-tool.mjs', ''],
  ]);
  assert.deepEqual(selectionModules(files), [
    'scripts/core-queue-paths.mjs',
    'scripts/docs-readers.mjs',
    'scripts/lazy-selector.mjs',
    'scripts/script-impact.mjs',
    'scripts/selection-guard.mjs',
    'scripts/side-effect.mjs',
    'scripts/tree-scan.mjs',
  ]);
  for (const path of [...modules.map(name => `scripts/${name}.mjs`), 'scripts/tree-scan.mjs']) {
    const selected = actionsGateSelection(contractRun, [path], files, true);
    assert.equal(selected.scope, 'full', `${path}: main's full check`);
    assert.deepEqual(selected.trial, { paths: [path] }, `${path}: trial pinned`);
  }
  // A script the selector does not import stays an ordinary change.
  assert.equal(definitionTrialPaths(standardCheck, undefined, ['scripts/unrelated-tool.mjs'], files), null);
  // A Lane that changes no script reads no inventory file for this: its recipe and cost stay as before.
  const unread = new Map([...files.keys()].map(path => [path, '']));
  unread.get = path => assert.fail(`read ${path}`);
  assert.equal(definitionTrialPaths(standardCheck, undefined, ['src/a.ts', 'docs/x.md'], unread), null);
});

test('a Lane that deletes or weakens its check is still judged by main’s definition', t => {
  // The Candidate's selector claims nothing runs and its check entry is gone: the planner reads paths
  // only, never runs Candidate code, so main's full selection stands.
  const files = tree([
    ['scripts/test-impact.mjs', "export const standardSelection = () => ({ scope: 'docs', tests: [] });"],
  ]);
  files.delete('tests/b.test.mjs');
  const selected = actionsGateSelection(
    contractRun,
    ['scripts/test-impact.mjs', 'scripts/forge-check.mjs', 'tests/b.test.mjs'],
    files,
    true,
  );
  assert.equal(selected.scope, 'full');
  assert.deepEqual(selected.tests, ['tests/a.test.mjs']);
  assert.ok(selected.trial);
  // And its trial cannot be dropped: an entry without the trial declaration fails the trial job.
  const lane = temporaryDirectory(t, 'forge-trial-entry-');
  mkdirSync(join(lane, 'scripts'));
  assert.equal(declaresDefinitionTrial(lane), false, 'a deleted entry');
  writeFileSync(join(lane, 'scripts/forge-check.mjs'), 'process.exit(0);\n');
  assert.equal(declaresDefinitionTrial(lane), false, 'an entry that dropped the trial');
  writeFileSync(join(lane, 'scripts/forge-check.mjs'), 'export const CHECK_DEFINITION_TRIAL = 1;\n');
  assert.equal(declaresDefinitionTrial(lane), true);
});

test('the trial adds failures only: a pass changes nothing, a failure or missing entry fails the job', async () => {
  const run = async input => {
    const notes = [];
    let spawned = 0;
    const code = await runDefinitionTrial({
      declared: true,
      failed: false,
      spawn: async () => (spawned++, 0),
      note: line => notes.push(line),
      ...input,
    });
    return { code, notes, spawned: input.spawn ? undefined : spawned };
  };
  assert.deepEqual((await run({})).code, 0);
  const failing = await run({ spawn: async () => 3 });
  assert.equal(failing.code, 1);
  assert.match(failing.notes.at(-1), /Definition trial failed \(exit 3\): main's check passed/);
  const undeclared = await run({ declared: false });
  assert.equal(undeclared.code, 1);
  assert.equal(undeclared.spawned, 0);
  assert.match(undeclared.notes[0], /no longer declares CHECK_DEFINITION_TRIAL/);
  // A job that already failed spends no time on the trial.
  const failed = await run({ failed: true });
  assert.equal(failed.code, 0);
  assert.equal(failed.spawned, 0);
});

test('the trial runs in the browser job when the plan has one, else in the static job; never without a trial', () => {
  const trial = { paths: ['scripts/forge-check.mjs'] };
  const groups = [['tests/a.test.mjs'], ['tests/app-browser.test.mjs']];
  assert.equal(definitionTrialShard({ standard: true, groups, selection: { trial, browser: true } }), 1);
  assert.equal(definitionTrialShard({ standard: true, groups, selection: { trial, browser: false } }), 2);
  assert.equal(definitionTrialShard({ standard: true, groups, selection: { browser: true } }), null);
  assert.equal(definitionTrialShard({ standard: false, groups, selection: { trial } }), null);
});

/** A Candidate tree for the entry's trial mode: `tests/b.test.mjs` is a check test only this tree's
 * definition selects; its stub runner records the files it is asked to run. */
function trialTree(t, { failing = false, browser = false, shard = '0' } = {}) {
  const root = temporaryDirectory(t, 'forge-definition-trial-');
  for (const dir of ['src', 'web', 'convex', 'site', 'tests', 'scripts']) mkdirSync(join(root, dir));
  // The static job builds before the trial's tests; the synthetic build does nothing.
  const noop = 'node -e 0';
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'build:core': noop, 'build:web': noop } }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'tests/a.test.mjs'), '');
  writeFileSync(join(root, 'tests/b.test.mjs'), '');
  // A browser test by this tree's own naming rule, which main's plan (no browser job) did not run.
  if (browser) writeFileSync(join(root, 'tests/lane-only-browser.test.mjs'), '');
  const ran = join(root, 'ran.json');
  writeFileSync(
    join(root, 'scripts/test-files.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ran)}, JSON.stringify(process.argv.slice(2)));\n` +
      `writeFileSync(${JSON.stringify(ran)} + '.browser', process.env.FORGE_BROWSER_TESTS ?? '');\n` +
      (failing ? 'process.exitCode = 1;\n' : ''),
  );
  writeFileSync(join(root, 'scripts/prepare-convex-api.mjs'), '');
  const plan = join(root, 'plan.json');
  writeFileSync(
    plan,
    JSON.stringify({
      standard: true,
      pin: 'a'.repeat(64),
      head: 'b'.repeat(64),
      selection: {
        scope: 'full',
        reason: 'Main plan',
        tests: ['tests/a.test.mjs'],
        browser: false,
        trial: { paths: ['scripts/test-impact.mjs'] },
      },
      groups: [['tests/a.test.mjs']],
    }),
  );
  const entry = join(process.cwd(), 'scripts/forge-check.mjs');
  const trial = () =>
    spawnSync(process.execPath, [entry], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGE_ACTIONS_PLAN: plan, FORGE_ACTIONS_SHARD: shard, FORGE_CHECK_TRIAL: '1' },
    });
  return { trial, ran };
}

test('a Lane that adds a check test sees it run before landing: the trial runs what main’s plan left out', t => {
  const { trial, ran } = trialTree(t);
  const result = trial();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Definition trial: this tree's definition selects 2 test files; 1 beyond main's plan: tests\/b\.test\.mjs\./,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(ran, 'utf8')),
    ['tests/b.test.mjs'],
    'only the test main left out',
  );
  const failing = trialTree(t, { failing: true });
  const failed = failing.trial();
  assert.notEqual(failed.status, 0, 'a failing trial test fails the trial');
  assert.ok(existsSync(failing.ran));
});

test('Item 687d1eda: browser tests the trial finds in the static job are named, never run into a false red', t => {
  // Main's plan has no browser job, so the trial runs in the static job, which has no browser.
  const { trial, ran } = trialTree(t, { browser: true, shard: 'static' });
  const result = trial();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Definition trial: 1 browser test file not run: main's plan has no browser job\. Main's check runs them after landing: tests\/lane-only-browser\.test\.mjs\./,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(ran, 'utf8')),
    ['tests/b.test.mjs'],
    'the other extra test still runs; the browser test does not',
  );
  assert.equal(readFileSync(`${ran}.browser`, 'utf8'), '0', 'and it runs with browser tests off');
});
