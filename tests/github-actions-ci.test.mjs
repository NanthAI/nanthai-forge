import { runDetails } from '../dist/work-detail-store.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { assertCurrentWorkFormat } from '../dist/work-format.js';
import { parseAgentAction } from '../dist/agent-action-parse.js';
import { successfulCheck, retainedPassedCheck, validateReusedCheck } from '../dist/check-reuse-evidence.js';
import { adoptFinishRun } from '../dist/agent-finish-reuse.js';
import { modalPlan, validateModalPlan } from '../dist/modal-plan.js';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  return { root, write };
}

test('run accepts explicit file lists for either selector and validates file paths', () => {
  const id = randomUUID();
  for (const selector of [{ laneId: id }, { viewId: id }]) {
    assert.deepEqual(
      parseAgentAction({
        action: 'run',
        ...selector,
        tests: ['tests/b.test.mjs', 'tests/a.test.mjs', 'tests/b.test.mjs'],
      }).tests,
      ['tests/a.test.mjs', 'tests/b.test.mjs'],
    );
    assert.deepEqual(parseAgentAction({ action: 'run', ...selector, tests: [] }).tests, []);
    assert.equal(parseAgentAction({ action: 'run', ...selector }).tests, undefined);
  }
  for (const tests of [
    'tests/a.test.mjs',
    [null],
    ['/tests/a.test.mjs'],
    ['tests/../a.test.mjs'],
    ['src/a.ts'],
    ['tests/a.test.mjs\n'],
    ['tests/*.test.mjs'],
  ])
    assert.throws(
      () => parseAgentAction({ action: 'run', viewId: id, tests }),
      error => error.code === 'BAD_ARGUMENT',
    );
});

for (const tests of [[], ['tests/a.test.mjs']])
  test(`explicit ${tests.length}-file run retains partial evidence, replay identity and gate refusals`, async t => {
    const { root, write } = fixture(t);
    write('scripts/forge-check.mjs', `console.log(process.env.FORGE_SELECTED_TESTS);`);
    write('tests/a.test.mjs', '// synthetic test');
    write('tests/b.test.mjs', '// unselected test');
    initNative(root);
    const work = new WorkService(root),
      agent = new AgentWorkflow(root);
    const act = command => work.execute(command, work.store.revision()).result;
    await agent.dispatch({ action: 'set-policy', operationId: randomUUID(), preset: 'trusted' });
    const intent = act({ action: 'intent', outcome: 'Explicit tests fixture' });
    const lane = act({ action: 'lane', intentId: intent.id, name: 'Fixture' });
    const view = act({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    });
    const check = act({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: ['scripts/forge-check.mjs'],
    });
    const input = { action: 'run', laneId: lane.id, operationId: randomUUID(), tests };
    const receipt = (await agent.dispatch(input)).result;
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.checkSelection.scope, 'partial');
    assert.deepEqual(
      runDetails(work.store, work.store.select('runs', receipt.runId)).checkSelection.tests,
      tests,
    );
    if (tests.length) assert.equal(receipt.detailSummary.tests, tests.length);
    else assert.equal(receipt.detailSummary, undefined);
    assert.match(receipt.coverage, /Partial evidence/);
    const run = runDetails(work.store, work.store.select('runs', receipt.runId));
    assert.ok(work.store.load().schema >= 15);
    assert.throws(() => assertCurrentWorkFormat({ ...work.store.load(), schema: 14 }), {
      code: 'WORK_UPGRADE_REQUIRED',
    });
    const output = readFileSync(join(work.store.directory, `check-${run.id}/stdout.log`), 'utf8');
    assert.deepEqual(JSON.parse(output.trim()).tests, tests);
    assert.equal(JSON.parse(output.trim()).scope, 'partial');
    assert.equal(successfulCheck(run), false);
    assert.equal(retainedPassedCheck(work.store, run), undefined);
    assert.throws(
      () => validateReusedCheck(work.store, run),
      error => error.code === 'CHECK_REQUIRED',
    );
    assert.equal(
      adoptFinishRun(work.store, { checkId: check.id, expectedDefinition: check.definition }, view.id),
      undefined,
    );
    assert.equal((await agent.dispatch(input)).result.runId, run.id);
    await assert.rejects(
      agent.dispatch({ ...input, tests: ['tests/b.test.mjs'] }),
      error => error.code === 'EVIDENCE_CHANGED',
    );
    await assert.rejects(
      agent.dispatch({ action: 'accept', viewId: view.id }),
      error => error.code === 'CHECK_REQUIRED',
    );
    const invariant = (
      await work.dispatch(
        {
          action: 'define-invariant',
          operationId: randomUUID(),
          invariantId: randomUUID(),
          intentId: intent.id,
          name: 'Check gate',
          statement: 'Needs complete check evidence',
          checkIds: [check.id],
          reviewers: [],
        },
        work.store.revision(),
      )
    ).result;
    const assessment = (
      await work.dispatch(
        {
          action: 'assess-invariant',
          id: invariant.id,
          definition: invariant.definition,
          viewId: view.id,
          expectedHead: view.head,
        },
        work.store.revision(),
      )
    ).result;
    assert.equal(assessment.satisfied, false);
    assert.match(assessment.checks[0].reasons.join(' '), /partial evidence/);
    const { assessInvariant } = await import('../dist/work-invariant.js');
    const data = work.store.load();
    const complete = { ...run, id: randomUUID(), checkSelection: undefined };
    data.runs = [complete, run];
    const prior = assessInvariant(work.store, data, {
      action: 'assess-invariant',
      id: invariant.id,
      definition: invariant.definition,
      viewId: view.id,
      expectedHead: view.head,
    });
    assert.equal(prior.satisfied, true, 'partial evidence does not invalidate an existing complete pass');
    assert.equal(prior.checks[0].runId, complete.id);

    const directory = join(root, 'plan');
    mkdirSync(directory);
    const plan = await modalPlan(work.store, run, directory, 8);
    assert.equal(plan.selection.scope, 'partial');
    assert.deepEqual(plan.groups.flat().sort(), tests);
    run.backend = { ...run.backend, pin: plan.pin };
    validateModalPlan(plan, run);
    assert.equal(new WorkService(root).store.select('runs', run.id).checkSelection.scope, 'partial');
    const missing = join(root, 'missing-plan');
    mkdirSync(missing);
    await assert.rejects(
      modalPlan(
        work.store,
        { ...run, checkSelection: { ...run.checkSelection, tests: ['tests/missing.test.mjs'] } },
        missing,
      ),
      /absent from the pinned source/,
    );
  });

test('generated workflow starts static verification and test shards independently', () => {
  const workflow = githubActionsWorkflow('ubuntu-latest');
  assert.deepEqual(
    [...workflow.split('jobs:\n')[1].matchAll(/^  (\w+):/gm)].map(match => match[1]),
    ['shard', 'static'],
  );
  assert.doesNotMatch(workflow, /needs:|actions\/(?:upload|download)-artifact|forge-build/);
  assert.match(workflow, /if: \$\{\{ inputs.plan != '\[\]' \}\}/);
  assert.match(workflow, /fail-fast: false/);
  assert.equal((workflow.match(/run: node scripts\/forge-check.mjs/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /secrets\./);
});

for (const scope of ['partial', 'full'])
  test(`${scope} Actions selection builds in each job and preserves its test files`, t => {
    const { root, write } = fixture(t);
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
    });
    const plan = {
      pin: 'a'.repeat(64),
      head: 'b'.repeat(64),
      standard: true,
      selection: { scope, reason: 'Fixture selection', tests: ['tests/a.test.mjs'] },
      groups: [['tests/a.test.mjs']],
    };
    write('plan.json', JSON.stringify(plan));
    process.chdir(root);
    process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
    const calls = [],
      execute = (command, args, options) => calls.push({ command, args, env: { ...options.env } });
    process.env.FORGE_ACTIONS_SHARD = '0';
    runActionsCheck(execute);
    assert.deepEqual(calls.at(-1).args, ['scripts/test-files.mjs', 'tests/a.test.mjs']);
    assert.equal(calls.at(-1).env.FORGE_TEST_COVERAGE_HEAD, scope === 'full' ? plan.head : undefined);
    assert.deepEqual(
      calls.slice(0, -1).map(call => call.args),
      [
        ['ci', '--ignore-scripts'],
        ['run', 'build:core'],
        ['run', 'build:web'],
      ],
    );
    calls.length = 0;
    process.env.FORGE_ACTIONS_SHARD = 'static';
    runActionsCheck(execute);
    assert.deepEqual(
      calls.map(call => call.args),
      [['ci', '--ignore-scripts'], ['scripts/verify.mjs']],
    );
    assert.deepEqual(JSON.parse(calls.at(-1).env.FORGE_SELECTED_TESTS), {
      ...plan.selection,
      tests: [],
    });
  });

test('explicit lists are not silently ignored by arbitrary commands', async t => {
  const { root, write } = fixture(t);
  write('a.txt', 'fixture');
  initNative(root);
  const work = new WorkService(root),
    agent = new AgentWorkflow(root);
  const act = command => work.execute(command, work.store.revision()).result;
  const intent = act({ action: 'intent', outcome: 'Unsupported command fixture' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Fixture' });
  const view = act({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const check = act({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'throw Error("must not execute")'],
  });
  await assert.rejects(
    agent.dispatch({ action: 'run', viewId: view.id, tests: [] }),
    error => error.code === 'BAD_ARGUMENT',
  );
  assert.equal(work.store.load().runs.length, 0);
  const previous = process.env.FORGE_SELECTED_TESTS;
  process.env.FORGE_SELECTED_TESTS = 'synthetic declared input';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_SELECTED_TESTS;
    else process.env.FORGE_SELECTED_TESTS = previous;
  });
  act({
    action: 'define-check',
    checkId: check.id,
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'console.log(process.env.FORGE_SELECTED_TESTS)'],
    env: ['FORGE_SELECTED_TESTS'],
  });
  const ordinary = (await agent.dispatch({ action: 'run', viewId: view.id })).result;
  assert.equal(ordinary.status, 'passed');
  assert.match(
    readFileSync(join(work.store.directory, `check-${ordinary.runId}/stdout.log`), 'utf8'),
    /synthetic declared input/,
  );
});
