// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  MICRO,
  microAdmission,
  compareMicro,
  microWorkers,
  microWaves,
  publicMicroResult,
} from '../scripts/bench-t3code/micro-report.mjs';
import { setupProblems } from '../scripts/bench-t3code/micro-setup.mjs';
import { previousMicroStarts } from '../scripts/bench-t3code/micro-gate.mjs';
import { scriptedForge } from '../scripts/bench-t3code/scripted.mjs';

const epoch = Date.parse('2026-01-02T00:00:00Z');
const ago = hours => new Date(epoch - hours * 3600_000).toISOString();
const sample = () => ({
  wallSeconds: 600,
  pinsStable: true,
  scenario: { fixtureCommit: 'f'.repeat(40), checkDefinition: 'c'.repeat(64), runner: 'ubuntu-latest' },
  convex: { valid: true, costUsd: 0.03 },
  ci: { billedMinutes: 34, unfinishedRuns: 0, runs: 6 },
  tasks: MICRO.tasks.map(t => ({ id: t.id, receiptId: 'accepted', timeToMainSeconds: 300 })),
});

// The workflow uses literal paths and single-segment prefix globs, as GitHub does here.
const workflow = readFileSync(
  new URL('../.github/workflows/landing-micro-bench.yml', import.meta.url),
  'utf8',
);
const pathsBlock = workflow.split('    paths:\n')[1].split('  workflow_dispatch:')[0];
const triggerGlobs = [...pathsBlock.matchAll(/^\s*-\s*['"]([^'"]+)['"]\s*$/gm)].map(m => m[1]);
const triggers = path =>
  triggerGlobs.some(glob =>
    new RegExp(
      '^' +
        glob
          .split('*')
          .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*') +
        '$',
    ).test(path),
  );

const setupStep = workflow
  .split('      - name: Validate benchmark setup\n')[1]
  .split('\n      - id: admission')[0];
const setupScript = setupStep
  .split("          node --input-type=module <<'JS'\n")[1]
  .split('\n          JS')[0]
  .split('\n')
  .map(line => line.slice(10))
  .join('\n');
const validSetup = JSON.stringify({
  forge: { url: 'https://fixture.convex.cloud', deployment: 'fixture', projectId: 'bench' },
  fixture: { repository: 'NanthAI/forge-b15d-t3code', commit: 'a'.repeat(40) },
});
function validateWorkflowSetup(config, tokenPresent = true, keyPresent = true) {
  const root = mkdtempSync(join(tmpdir(), 'forge-micro-setup-'));
  const output = join(root, 'output');
  writeFileSync(output, '');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: new URL('../', import.meta.url),
      input: setupScript,
      encoding: 'utf8',
      env: {
        FORGE_MICRO_SETUP: config,
        HAS_FORGE_BENCH_TOKEN: String(tokenPresent),
        HAS_CONVEX_DEPLOY_KEY: String(keyPresent),
        GITHUB_OUTPUT: output,
      },
    });
    if (result.error) throw result.error;
    return { ...result, output: readFileSync(output, 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('unconfigured micro-bench skips without failure or admitting the measured scenario', () => {
  for (const [config, token, key] of [
    ['', false, false],
    ['', true, true],
    [validSetup, false, true],
    [validSetup, false, false],
  ]) {
    const result = validateWorkflowSetup(config, token, key);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '::notice::micro-bench not set up: skipped\n');
    assert.equal(result.stderr, '');
    assert.equal(result.output, '');
  }
  assert.match(workflow, /- id: admission\n\s+if: steps\.setup\.outputs\.ready == 'true'/);
});

test('present but malformed micro-bench setup fails even before the token is provisioned', () => {
  for (const config of ['{', '{}', 'null', JSON.stringify({ fixture: {} })]) {
    for (const token of [false, true]) {
      const result = validateWorkflowSetup(config, token);
      assert.equal(result.status, 1);
      assert.notEqual(result.stderr, '');
      assert.equal(result.stdout, '');
      assert.equal(result.output, '');
    }
  }
});

test('setup validation receives presence flags and admits only complete benchmark setup', () => {
  const ready = validateWorkflowSetup(validSetup);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.output, 'ready=true\n');
  assert.equal(ready.stdout, '');
  const missingKey = validateWorkflowSetup(validSetup, true, false);
  assert.equal(missingKey.status, 1);
  assert.equal(missingKey.output, '');
  assert.match(missingKey.stderr, /deployment key missing/);
  const setupEnv = setupStep.split('\n        env:\n')[1];
  assert.doesNotMatch(setupEnv, /^\s+(FORGE_AUTH_TOKEN|CONVEX_DEPLOY_KEY):/m);
  assert.match(setupEnv, /HAS_FORGE_BENCH_TOKEN: \$\{\{ secrets\.FORGE_BENCH_TOKEN != '' \}\}/);
  assert.match(setupEnv, /HAS_CONVEX_DEPLOY_KEY: \$\{\{ secrets\.CONVEX_DEPLOY_KEY != '' \}\}/);
});

test('rung 2 triggers for queue, acceptance, conflict and actual Lane start/open modules', () => {
  const groups = {
    convex: [
      'projectHostedLanding',
      'projectHostedFinish',
      'projectHostedCompose',
      'projectHostedAccept',
      'projectHostedOverlap',
      'projectHostedLane',
      'projectHostedStart',
      'projectHostedQueue',
    ],
    src: [
      'hosted-agent-actions.',
      'hosted-agent-contract.',
      'hosted-agent-transport.',
      'hosted-agent-finish',
      'hosted-finish',
      'hosted-conflict',
      'hosted-observed-conflict',
      'hosted-would-conflict',
      'hosted-start-continuation',
      'hosted-lane.',
      'hosted-lane-checkout',
      'hosted-lane-location',
      'hosted-lane-transport',
      'hosted-lane-adopt',
      'hosted-root-checkout',
      'hosted-main-checkout',
      'hosted-checkout',
    ],
  };
  for (const [directory, prefixes] of Object.entries(groups)) {
    const files = readdirSync(new URL(`../${directory}/`, import.meta.url));
    for (const prefix of prefixes) {
      const affected = files.filter(file => file.endsWith('.ts') && file.startsWith(prefix));
      assert.ok(affected.length, `Update trigger contract after moving ${prefix}`);
      for (const file of affected)
        assert.ok(triggers(`${directory}/${file}`), `${directory}/${file} is not covered`);
    }
  }
});

test('rung 2 does not start a benchmark for unrelated screen, documentation or harness-only changes', () => {
  for (const path of [
    'web/src/Now.tsx',
    'docs/status.md',
    'README.md',
    'scripts/bench-t3code/micro-report.mjs',
  ])
    assert.equal(triggers(path), false, path);
});

test('rung 2 admits no more than one start per six hours, including failed runs', () => {
  assert.equal(microAdmission([], epoch).admitted, true);
  assert.equal(microAdmission([ago(5.99)], epoch).admitted, false);
  assert.equal(microAdmission([ago(6)], epoch).admitted, true);
});

test('rung 2 enforces four starts in a rolling day across UTC midnight', () => {
  assert.equal(microAdmission([ago(6), ago(12), ago(18), ago(23)], epoch).admitted, false);
  assert.equal(microAdmission([ago(6), ago(12), ago(18), ago(24)], epoch).admitted, true);
  assert.throws(() => microAdmission(['unreadable'], epoch));
  assert.throws(() => microAdmission([ago(-1)], epoch));
});

test('rung 2 counts old workflow reruns by their execution time, across history pages', async () => {
  const run = { id: 1, run_started_at: ago(1), created_at: ago(100) };
  const first = Array.from({ length: 100 }, (_, id) => ({ id, run_started_at: ago(30) }));
  const requested = [];
  const starts = await previousMicroStarts({
    repository: 'fixture/repo',
    now: epoch,
    api: async path => {
      requested.push(path);
      if (path.includes('/jobs?'))
        return {
          jobs: [
            {
              steps: [
                { name: 'Run measured scenario', started_at: ago(1), conclusion: 'failure' },
                { name: 'Other step', started_at: ago(1) },
              ],
            },
          ],
        };
      return { workflow_runs: path.endsWith('page=1') ? first : [run] };
    },
  });
  assert.deepEqual(starts, [ago(1)]);
  assert.equal(requested.length, 3);
});

test('rung 2 does not count skipped measured steps as live starts', async () => {
  const starts = await previousMicroStarts({
    repository: 'fixture/repo',
    now: epoch,
    api: async path =>
      path.includes('/jobs?')
        ? {
            jobs: [{ steps: [{ name: 'Run measured scenario', started_at: ago(1), conclusion: 'skipped' }] }],
          }
        : { workflow_runs: [{ id: 1, run_started_at: ago(1) }] },
  });
  assert.deepEqual(starts, []);
});

test('rung 2 flags strictly over 1.5 times the stored wall, task, check and dollar baseline', () => {
  const before = sample(),
    result = sample();
  result.wallSeconds *= 1.5;
  result.convex.costUsd *= 1.5;
  result.ci.runs *= 1.5;
  result.tasks[0].timeToMainSeconds *= 1.5;
  assert.equal(compareMicro(result, before).passed, true);
  result.wallSeconds++;
  result.convex.costUsd += 0.001;
  result.ci.runs++;
  result.tasks[0].timeToMainSeconds++;
  const verdict = compareMicro(result, before);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.regressions.length, 4);
  assert.match(verdict.nextStep, /same slice/);
});

test('rung 2 cannot establish or refresh a baseline with missing cost coverage', () => {
  for (const bad of [null, undefined, NaN, -1]) {
    const result = sample();
    result.convex.costUsd = bad;
    assert.equal(compareMicro(result, { status: 'unmeasured' }).passed, false);
    assert.equal(compareMicro(result, sample()).passed, false);
  }
});

test('rung 2 rejects missing acceptances, duplicate tasks, pin drift and unfinished CI', () => {
  for (const mutate of [
    r => delete r.tasks[0].receiptId,
    r => (r.tasks[0] = r.tasks[1]),
    r => (r.pinsStable = false),
    r => (r.ci.unfinishedRuns = 1),
    r => (r.convex.valid = false),
  ]) {
    const result = sample();
    mutate(result);
    assert.equal(compareMicro(result, sample()).passed, false);
  }
});

test('rung 2 reports the approved dollar budget even when an old baseline was expensive', () => {
  const result = sample(),
    baseline = sample();
  result.convex.costUsd = baseline.convex.costUsd = 0.061;
  assert.match(compareMicro(result, baseline).problems.join(' '), /approved/);
});

test('rung 2 records first measured baseline without fabricating historical numbers', () => {
  const result = sample();
  assert.equal(compareMicro(result, { status: 'unmeasured' }).passed, true);
  assert.equal(compareMicro(result, null).passed, false);
});

test('rung 2 refuses comparisons across changed workloads and malformed task evidence', () => {
  for (const key of ['fixtureCommit', 'checkDefinition', 'runner']) {
    const result = sample();
    result.scenario[key] = 'different workload';
    assert.match(compareMicro(result, sample()).problems.join(' '), /workload changed/);
  }
  const malformed = sample();
  malformed.tasks = {};
  assert.equal(compareMicro(malformed, sample()).passed, false);
});

test('rung 2 prepares each hot-file cluster before dispatch and finishes it before the next', async () => {
  const events = [];
  const results = await microWaves(
    async task => {
      events.push(`prepared:${task.id}`);
      return task;
    },
    async task => {
      events.push(`landed:${task.id}`);
      return { id: task.id };
    },
  );
  assert.deepEqual(
    new Set(events.slice(0, 3)),
    new Set(MICRO.tasks.slice(0, 3).map(t => `prepared:${t.id}`)),
  );
  assert.deepEqual(new Set(events.slice(3, 6)), new Set(MICRO.tasks.slice(0, 3).map(t => `landed:${t.id}`)));
  assert.deepEqual(new Set(events.slice(6, 8)), new Set(MICRO.tasks.slice(3).map(t => `prepared:${t.id}`)));
  assert.equal(results.length, 5);
});

test('rung 2 preparation failure retains the cluster without dispatching tasks or hanging peers', async () => {
  let landed = 0;
  const results = await microWaves(
    async task => {
      if (task.id === 't22302') throw Error('synthetic preparation failure');
      return task;
    },
    async task => {
      landed++;
      return { id: task.id };
    },
  );
  assert.equal(landed, 0);
  assert.equal(results.length, 3);
  assert.ok(results.every(task => task.error));
});

test('public rung 2 summaries exclude shared deployment diagnostics and private reset evidence', () => {
  const result = sample();
  result.reset = { diagnostic: 'synthetic-private-reset' };
  result.convex.deploymentWide = { diagnostic: 'synthetic-other-project' };
  const summary = publicMicroResult(result);
  assert.equal(summary.convex.costUsd, result.convex.costUsd);
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-private-reset|synthetic-other-project/);
  assert.ok(result.reset && result.convex.deploymentWide);
});

test('rung 2 runs only three tasks concurrently and joins failed siblings', async () => {
  let active = 0,
    peak = 0,
    finished = 0;
  const gates = [];
  const promise = microWorkers(MICRO.tasks, async task => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => gates.push(resolve));
    active--;
    finished++;
    if (task.id === 't19456') throw Error('fixture task failure');
    return { id: task.id };
  });
  assert.equal(active, 3);
  while (finished < 5) {
    gates.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  const records = await promise;
  assert.equal(peak, 3);
  assert.equal(records.length, 5);
  assert.equal(records.filter(r => r.error).length, 1);
});

test('shared benchmark setup refuses missing authority and a nonqualified fixture before mutations', () => {
  const config = {
    forge: { url: 'https://fixture.convex.cloud', deployment: 'fixture', projectId: 'bench' },
    fixture: { repository: 'NanthAI/forge-b15d-t3code', commit: 'a'.repeat(40) },
    alerts: { projectId: 'owner' },
  };
  const env = { FORGE_AUTH_TOKEN: 'synthetic', CONVEX_DEPLOY_KEY: 'synthetic' };
  assert.deepEqual(setupProblems(config, env), []);
  assert.equal(setupProblems(config, {}).length, 2);
  assert.match(setupProblems({ ...config, fixture: {} }, env).join(' '), /qualified/);
  config.forge.url = 'http://fixture.invalid';
  assert.match(setupProblems(config, env).join(' '), /URL/);
});

test('portable no-model driver retains its accepted receipt outside the source checkout', () => {
  const root = mkdtempSync(join(tmpdir(), "forge-micro-'$(fixture)-"));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, '.forge'));
    writeFileSync(
      join(root, '.forge/hosted-lane.json'),
      JSON.stringify({ selection: { laneId: 'fixture' } }),
    );
    writeFileSync(
      join(bin, 'nforge'),
      `#!${process.execPath}\nconsole.log(JSON.stringify({result:{submission:{phase:'landed',acceptance:{receiptId:'fixture-receipt'}}}}));\n`,
      { mode: 0o755 },
    );
    const script = scriptedForge(bin),
      receipt = join(root, 'receipt.json');
    execFileSync('bash', [script, 't19456', 'overlap-preview'], {
      cwd: root,
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, BENCH_SCRIPTED_RESULT: receipt },
    });
    assert.equal(JSON.parse(readFileSync(receipt)).submission.acceptance.receiptId, 'fixture-receipt');
    assert.equal(readFileSync(join(root, '.bench/dry/group-overlap-preview.md'), 'utf8'), 't19456\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
