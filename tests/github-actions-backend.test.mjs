// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { setPolicy, localPerson } from '../dist/work-autonomy.js';
import { initNative } from '../dist/native-work.js';
import { checkEnvironment, recoverRuns, adoptModalRun } from '../dist/work-run.js';
import { launchGithubActionsRun } from '../dist/work-github-actions-run.js';
import { controlActions } from '../dist/github-actions-controller.js';
import { exportActionsSnapshot, deleteActionsRef } from '../dist/github-actions-export.js';
import { modalPlan } from '../dist/modal-plan.js';
import { composedNativeMain } from '../dist/native-composition-candidate.js';
import { NativeSource } from '../dist/native-source.js';
import { standardSelection } from '../scripts/test-impact.mjs';
import { githubActionsWorkflow, githubActionsRecipe } from '../dist/github-actions-workflow.js';
import { actionsApi, ActionsApiError, observe } from '../dist/github-actions-api.js';
import { syncGit, redactGitStderr, GitSyncError, transientGitFailure } from '../dist/github-sync-git.js';
import { checkRoute } from '../dist/check-backend.js';
import { editedPolicy, policyPreset } from '../dist/autonomy-policy.js';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries({ 'fixture.txt': 'synthetic source', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  initNative(root);
  const work = new WorkService(root);
  const act = command => work.execute(command, work.store.load().revision).result;
  setPolicy(
    work.store,
    {
      action: 'set-policy',
      operationId: randomUUID(),
      checks: { runner: 'github-actions', repo: 'synthetic/checks' },
    },
    localPerson(),
    work.store.load().revision,
  );
  const intent = act({ action: 'intent', outcome: 'Synthetic Actions check' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const view = act({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const check = act({
    action: 'define-check',
    name: 'Tiny check',
    executable: process.execPath,
    args: ['-e', 'console.log("synthetic smoke passed")'],
  });
  const run = {
    id: randomUUID(),
    viewId: view.id,
    supersessionBaseline: view.id,
    head: view.head,
    base: view.base,
    inputs: view.inputs,
    dependencies: [],
    check,
    environment: checkEnvironment(),
    status: 'queued',
    startedAt: new Date().toISOString(),
    runner: { pid: process.pid, host: hostname() },
    details: 'fixture',
    backend: { requested: 'github-actions', actual: 'github-actions' },
  };
  work.store.locked(() => {
    const tx = work.store.records();
    tx.append('runs', run);
    work.store.commitRecords(tx);
  });
  return { work, run, view, path: join(work.store.directory, `check-${run.id}`) };
}
function transport(plan, journal, options = {}) {
  const calls = [],
    waits = [];
  const job = {
    id: 20,
    name: 'forge-static',
    started_at: '2026-10-01T12:00:00Z',
    completed_at: '2026-10-01T12:01:01Z',
    run_attempt: 1,
    status: 'completed',
    conclusion: options.conclusion ?? 'success',
  };
  let retries = 0;
  const api = {
    async request(endpoint, method = 'GET', body) {
      calls.push({ endpoint, method, body });
      if (endpoint.includes('/branches/')) return { commit: { sha: journal.commit } };
      if (endpoint.endsWith('/dispatches')) {
        if (options.dispatchError) throw Error('synthetic-secret-token');
        return;
      }
      if (endpoint.endsWith('/cancel')) {
        job.conclusion = 'cancelled';
        return;
      }
      if (endpoint.endsWith('/rerun')) {
        retries++;
        job.id++;
        job.run_attempt++;
        job.conclusion = options.retryConclusion ?? 'success';
        return;
      }
      if (endpoint.endsWith('/timing'))
        return {
          billable: {
            UBUNTU: { total_ms: 60_001, jobs: 1, job_runs: [{ job_id: 20, duration_ms: 60_001 }] },
          },
        };
      return {
        id: 10,
        head_sha: options.wrongHead ? 'wrong' : journal.commit,
        status:
          options.running && !calls.some(call => call.endpoint.endsWith('/cancel'))
            ? 'in_progress'
            : 'completed',
        conclusion: job.conclusion,
        run_attempt: retries + 1,
      };
    },
    async pages(endpoint) {
      calls.push({ endpoint });
      if (endpoint.includes('/runs?'))
        return [{ id: 10, head_sha: journal.commit, display_title: `forge-check/${plan.runId}` }];
      return [
        structuredClone(job),
        ...plan.groups.map((_, index) => ({
          ...structuredClone(job),
          id: 100 + index,
          name: `forge-shard-${index}`,
        })),
      ];
    },
    async log() {
      return options.log ?? 'synthetic smoke passed\n';
    },
    async sleep(ms) {
      waits.push(ms);
    },
  };
  return { api, calls, waits };
}
function controllerFixture(t, groups = []) {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = { runId: randomUUID(), output: root, groups };
  const journal = {
    commit: 'a'.repeat(40),
    repo: 'synthetic/checks',
    retrying: [],
    retrySources: {},
    oom: [],
    logged: [],
    states: {},
  };
  return { plan, journal };
}

for (const mode of ['completed', 'discover', 'cancel', 'unfinished', 'unstarted']) {
  test(`pre-upgrade Actions runtime permits observation without new execution: ${mode}`, async t => {
    const { work, run, path } = fixture(t);
    mkdirSync(path, { recursive: true });
    const plan = await modalPlan(
      work.store,
      run,
      path,
      undefined,
      'github-actions;repo:synthetic/checks;node:24.19.0;runs-on:ubuntu-latest;unfinished-retry:1',
    );
    run.backend.pin = plan.pin;
    const journal = {
      pin: plan.pin,
      repo: 'synthetic/checks',
      runsOn: 'ubuntu-latest',
      commit: 'a'.repeat(40),
      pushed: true,
      retrying: [],
      retrySources: {},
      oom: [],
      logged: [],
      states: {},
      ...(mode === 'unstarted' ? {} : mode === 'discover' ? { dispatching: true } : { runId: 10 }),
    };
    writeFileSync(join(path, 'github-actions.json'), JSON.stringify(journal));
    if (mode === 'cancel') run.cancelRequested = true;
    const fake = transport(plan, journal, {
      running: mode === 'cancel',
      conclusion: mode === 'unfinished' ? 'startup_failure' : 'success',
    });
    await launchGithubActionsRun(
      work.store,
      run,
      fake.api,
      async () => assert.fail('Old runtime must not export a replacement workflow'),
      async () => {},
    );
    const result = read(join(path, 'result.json'));
    assert.equal(
      result.status,
      mode === 'cancel' ? 'cancelled' : ['unfinished', 'unstarted'].includes(mode) ? 'interrupted' : 'passed',
    );
    assert.equal(result.backend.runtime, plan.runtime);
    assert.equal(
      fake.calls.filter(call => call.method === 'POST' && !call.endpoint.endsWith('/cancel')).length,
      0,
    );
    if (mode === 'unstarted') assert.match(result.details, /UNSUPPORTED_NODE/);
    else assert.ok(fake.calls.some(call => call.endpoint.endsWith('/timing')));
  });
}

test('policy, native routing and workflow preserve labels and shard selection', () => {
  const policy = editedPolicy(policyPreset('trusted'), {
    checks: {
      runner: 'github-actions',
      repo: 'synthetic/checks',
      runsOn: 'blacksmith-4vcpu-ubuntu-2404',
      shards: 3,
    },
  });
  assert.equal(policy.checks.runner, 'github-actions');
  assert.equal(checkRoute('github-actions', {}, true).actual, 'github-actions');
  assert.equal(checkRoute('github-actions', { env: ['SECRET'] }, true).actual, 'local');
  assert.equal(checkRoute('github-actions', {}, false).actual, 'local');
  assert.throws(() => editedPolicy(policy, { checks: { repo: '../bad' } }));
  const workflow = githubActionsWorkflow(policy.checks.runsOn);
  assert.match(workflow, /runs-on: "blacksmith-4vcpu-ubuntu-2404"/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /FORGE_ACTIONS_SHARD: static/);
  assert.match(workflow, /inputs.plan != '\[\]'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /secrets\./);
});
test('dispatch, log collection and job timing use the retained run identity', async t => {
  const { plan, journal } = controllerFixture(t),
    { api, calls } = transport(plan, journal);
  const progress = [];
  const outcome = await controlActions(
    plan,
    journal,
    () => {},
    api,
    () => false,
    line => progress.push(line),
  );
  assert.equal(outcome.status, 'passed');
  assert.deepEqual(outcome.billableMinutes, [{ jobId: 20, minutes: 2 }]);
  assert.equal(calls.filter(call => call.endpoint.endsWith('/dispatches')).length, 1);
  assert.equal(calls.find(call => call.body)?.body.ref, `forge-check/${plan.runId}`);
  assert.match(readFileSync(join(plan.output, 'shards/static.log'), 'utf8'), /synthetic smoke/);
  assert.ok(progress.some(line => line.includes('forge-static')));
});
test('ambiguous dispatch is reconciled without a second mutation', async t => {
  const { plan, journal } = controllerFixture(t),
    { api, calls } = transport(plan, journal, { dispatchError: true });
  assert.equal(
    (
      await controlActions(
        plan,
        journal,
        () => {},
        api,
        () => false,
        () => {},
      )
    ).status,
    'passed',
  );
  assert.equal(journal.dispatching, true);
  assert.equal(calls.filter(call => call.endpoint.endsWith('/dispatches')).length, 1);
});
test('observed failures and OOM remain failed without retries', async t => {
  const { plan, journal } = controllerFixture(t),
    { api, calls } = transport(plan, journal, {
      conclusion: 'failure',
      log: 'Process completed with exit code 137.',
    });
  const result = await controlActions(
    plan,
    journal,
    () => {},
    api,
    () => false,
    () => {},
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 137);
  assert.equal(calls.filter(call => call.endpoint.endsWith('/rerun')).length, 0);
});
test('only unfinished shards retry once and retain their original logs', async t => {
  const { plan, journal } = controllerFixture(t),
    { api, calls } = transport(plan, journal, { conclusion: 'timed_out' });
  const result = await controlActions(
    plan,
    journal,
    () => {},
    api,
    () => false,
    () => {},
  );
  assert.equal(result.status, 'passed');
  assert.equal(calls.filter(call => call.endpoint.endsWith('/rerun')).length, 1);
  assert.ok(existsSync(join(plan.output, 'shards/static.log')));
  assert.ok(existsSync(join(plan.output, 'shards/static.attempt-2.log')));
});
test('exhausted unfinished recovery is interrupted', async t => {
  const { plan, journal } = controllerFixture(t),
    { api, calls } = transport(plan, journal, { conclusion: 'timed_out', retryConclusion: 'timed_out' });
  assert.equal(
    (
      await controlActions(
        plan,
        journal,
        () => {},
        api,
        () => false,
        () => {},
      )
    ).status,
    'interrupted',
  );
  assert.equal(calls.filter(call => call.endpoint.endsWith('/rerun')).length, 1);
});
test('cancellation before dispatch starts no remote work', async t => {
  const { plan, journal } = controllerFixture(t),
    { api, calls } = transport(plan, journal);
  assert.equal(
    (
      await controlActions(
        plan,
        journal,
        () => {},
        api,
        () => true,
        () => {},
      )
    ).status,
    'cancelled',
  );
  assert.equal(calls.length, 0);
});
test('cancellation cancels and observes the exact retained execution', async t => {
  const { plan, journal } = controllerFixture(t);
  journal.runId = 10;
  const { api, calls } = transport(plan, journal, { running: true });
  assert.equal(
    (
      await controlActions(
        plan,
        journal,
        () => {},
        api,
        () => true,
        () => {},
      )
    ).status,
    'cancelled',
  );
  assert.equal(calls.filter(call => call.endpoint.endsWith('/10/cancel')).length, 1);
});
test('changed remote source refuses evidence', async t => {
  const { plan, journal } = controllerFixture(t),
    { api } = transport(plan, journal, { wrongHead: true });
  await assert.rejects(
    controlActions(
      plan,
      journal,
      () => {},
      api,
      () => false,
      () => {},
    ),
    /source changed/,
  );
});
test('read-only failures back off; mutation callers get no automatic retry', async () => {
  const waits = [];
  let attempt = 0;
  assert.equal(
    await observe({ sleep: async ms => waits.push(ms) }, async () => {
      if (++attempt < 4) throw Error('rate limit');
      return 1;
    }),
    1,
  );
  assert.deepEqual(waits, [5000, 10000, 20000]);
});
test('export and cleanup use only run-owned CAS refs and generated workflow', async t => {
  const { plan, journal } = controllerFixture(t);
  plan.source = join(plan.output, 'source');
  mkdirSync(plan.source);
  plan.selection = { scope: 'full', tests: [] };
  journal.runsOn = 'ubuntu-latest';
  delete journal.commit;
  const calls = [];
  let remote = '';
  const git = async (_, args) => {
    calls.push(args);
    if (args.includes('rev-parse')) return 'a'.repeat(40);
    if (args.includes('ls-remote')) return remote;
    if (args.includes('push') && args.at(-1).startsWith('a'))
      remote = `${'a'.repeat(40)}\trefs/heads/forge-check/${plan.runId}`;
    return '';
  };
  await exportActionsSnapshot(
    plan,
    journal,
    () => {},
    git,
    () => 'a'.repeat(40),
  );
  await exportActionsSnapshot(
    plan,
    journal,
    () => {},
    git,
    () => 'a'.repeat(40),
  );
  assert.equal(calls.filter(args => args.includes('push')).length, 1);
  assert.match(
    readFileSync(join(plan.source, '.github/workflows/forge-check.yml'), 'utf8'),
    /workflow_dispatch/,
  );
  assert.ok(calls.find(args => args.includes(`--force-with-lease=refs/heads/forge-check/${plan.runId}:`)));
  await deleteActionsRef(plan, journal, () => {}, git);
  assert.equal(journal.deleted, true);
  assert.ok(calls.some(args => args.at(-1) === `:refs/heads/forge-check/${plan.runId}`));
});
test('colliding refs cannot be overwritten or deleted', async t => {
  const { plan, journal } = controllerFixture(t);
  plan.source = plan.output;
  const git = async (_, args) => {
    assert.ok(!args.includes('push'));
    return `other\trefs/heads/forge-check/${plan.runId}`;
  };
  await assert.rejects(
    exportActionsSnapshot(plan, journal, () => {}, git),
    /different source/,
  );
  await assert.rejects(
    deleteActionsRef(plan, journal, () => {}, git),
    /changed ref/,
  );
});
test('runner records result before deleting success ref; recovery reads receipt', async t => {
  const { work, run, path } = fixture(t);
  let api;
  const proxy = {
    request: (...args) => api.request(...args),
    pages: (...args) => api.pages(...args),
    log: (...args) => api.log(...args),
    sleep: async () => {},
  };
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async (plan, journal, save) => {
      journal.commit = 'a'.repeat(40);
      journal.pushed = true;
      save();
      api = transport(plan, journal).api;
    },
    async () => assert.equal(read(join(path, 'result.json')).status, 'passed'),
  );
  assert.equal(read(join(path, 'result.json')).status, 'passed');
  assert.equal(recoverRuns(work.store, { runs: [run] }), true);
  assert.equal(run.status, 'passed');
  assert.equal(read(join(path, 'modal-plan.json')).head, run.head);
});
test('a stuck job recovery is explained in the result receipt and retained journal', async t => {
  const { work, run, path } = fixture(t);
  let api;
  const proxy = {
    request: (...args) => api.request(...args),
    pages: (...args) => api.pages(...args),
    log: (...args) => api.log(...args),
    sleep: async () => {},
  };
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async (plan, journal, save) => {
      journal.commit = 'a'.repeat(40);
      journal.pushed = true;
      save();
      api = transport(plan, journal, {
        log: '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
      }).api;
      const pages = api.pages;
      api.pages = async (...args) =>
        (await pages(...args)).map(job =>
          job.name === 'forge-static'
            ? { ...job, status: 'in_progress', conclusion: null, completed_at: null }
            : job,
        );
    },
    async () => assert.equal(read(join(path, 'result.json')).status, 'passed'),
  );
  const receipt = read(join(path, 'result.json'));
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.exitCode, 0);
  assert.match(
    receipt.details,
    /job status stuck on GitHub.*log shows 1 passed, 0 failed.*run concluded success/,
  );
  assert.equal(read(join(path, 'github-actions.json')).stuckJobs[20].source, 'node-test-summary');
  assert.match(readFileSync(join(path, 'stdout.log'), 'utf8'), /using log and run evidence/);
});
test('raw transport diagnostics never enter receipts and logs', async t => {
  const { work, run, path } = fixture(t);
  await launchGithubActionsRun(work.store, run, {}, async () => {
    throw Error('synthetic-secret-token');
  });
  assert.equal(read(join(path, 'result.json')).status, 'interrupted');
  assert.doesNotMatch(
    readFileSync(join(path, 'result.json'), 'utf8') + readFileSync(join(path, 'stdout.log'), 'utf8'),
    /synthetic-secret-token/,
  );
});
test('a git failure keeps its redacted, bounded stderr in the receipt', async t => {
  const { work, run, path } = fixture(t);
  await launchGithubActionsRun(work.store, run, {}, async () => {
    await syncGit(tmpdir(), [
      'ls-remote',
      'https://octo:ghp_synthetictoken123@127.0.0.1:1/synthetic/checks.git',
    ]);
  });
  const text = read(join(path, 'result.json')).details;
  assert.match(text, /GITHUB_SYNC_GIT_FAILED: git said "[^"]+"/);
  assert.match(text, /127\.0\.0\.1/);
  assert.doesNotMatch(text + readFileSync(join(path, 'stdout.log'), 'utf8'), /ghp_synthetictoken123|octo:/);
  const long = redactGitStderr(
    `Authorization: Bearer ghs_abcdef123456 x-access-token:abc ${'z'.repeat(3000)}`,
  );
  assert.ok(long.length <= 604);
  assert.doesNotMatch(long, /ghs_abcdef|abc /);
});
test('credential snapshots are not exported', async t => {
  const { work, run, path } = fixture(t);
  const { NativeSource } = await import('../dist/native-source.js');
  const source = new NativeSource(work.store.root);
  run.head = source.writeState(
    [
      ...source.state(run.head).files,
      { path: '.npmrc', mode: 'file', blob: source.put(Buffer.from('# synthetic configuration')) },
    ],
    [run.head],
    'Synthetic imported configuration',
    new Date().toISOString(),
  );
  await launchGithubActionsRun(work.store, run, {}, async () => assert.fail('must not export'));
  assert.equal(read(join(path, 'result.json')).status, 'runner-unavailable');
});
test('dead Actions controller can be claimed for adoption', async t => {
  const { work, run } = fixture(t);
  work.store.locked(() => {
    const tx = work.store.records();
    const selected = tx.find('runs', run.id);
    selected.record.runner.pid = 2147483647;
    tx.replace('runs', selected.position, selected.record);
    work.store.commitRecords(tx);
  });
  let adopted = false;
  await adoptModalRun(work.store, run.id, async (_, retained) => {
    adopted = true;
    assert.equal(retained.backend.actual, 'github-actions');
  });
  assert.equal(adopted, true);
});
test('one real tiny Actions smoke', { skip: !process.env.FORGE_GITHUB_ACTIONS_SMOKE_REPO }, async t => {
  const { work, run, path } = fixture(t, {
    'scripts/forge-check.mjs': 'console.log("synthetic smoke passed");\n',
  });
  setPolicy(
    work.store,
    {
      action: 'set-policy',
      operationId: randomUUID(),
      checks: {
        repo: process.env.FORGE_GITHUB_ACTIONS_SMOKE_REPO,
        runsOn: process.env.FORGE_GITHUB_ACTIONS_SMOKE_RUNS_ON ?? 'ubuntu-latest',
      },
    },
    localPerson(),
    work.store.load().revision,
  );
  await launchGithubActionsRun(work.store, run, actionsApi);
  assert.equal(read(join(path, 'result.json')).status, 'passed');
  assert.equal(read(join(path, 'github-actions.json')).deleted, true);
});

test('Actions shard command uses the pinned complete selection and Modal worker environment', async t => {
  const { runActionsCheck } = await import('../scripts/github-actions-check.mjs');
  const { plan } = controllerFixture(t);
  const filename = join(plan.output, 'recipe.json');
  writeFileSync(
    filename,
    JSON.stringify({
      standard: true,
      groups: [['tests/a.test.mjs', 'tests/b.test.mjs']],
      selection: { scope: 'full', tests: ['tests/a.test.mjs', 'tests/b.test.mjs'] },
    }),
  );
  const previous = { plan: process.env.FORGE_ACTIONS_PLAN, shard: process.env.FORGE_ACTIONS_SHARD };
  t.after(() => {
    for (const [key, value] of [
      ['FORGE_ACTIONS_PLAN', previous.plan],
      ['FORGE_ACTIONS_SHARD', previous.shard],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.FORGE_ACTIONS_PLAN = filename;
  process.env.FORGE_ACTIONS_SHARD = '0';
  const calls = [];
  runActionsCheck((command, args, options) => calls.push({ command, args, env: options.env }));
  assert.deepEqual(
    calls.map(call => call.args),
    [
      ['ci', '--ignore-scripts'],
      ['run', 'build:core'],
      ['run', 'build:web'],
      ['scripts/test-files.mjs', 'tests/a.test.mjs', 'tests/b.test.mjs'],
    ],
  );
  assert.equal(calls.at(-1).env.FORGE_TEST_WORKERS, '2');
  process.env.FORGE_ACTIONS_SHARD = 'static';
  calls.length = 0;
  runActionsCheck((command, args, options) => calls.push({ command, args, env: options.env }));
  assert.deepEqual(calls.at(-1).args, ['scripts/verify.mjs']);
  assert.deepEqual(JSON.parse(calls.at(-1).env.FORGE_SELECTED_TESTS).tests, []);
});
test('remote cancellation without an owner request is an infrastructure interruption', async t => {
  const { plan, journal } = controllerFixture(t),
    { api } = transport(plan, journal, { conclusion: 'cancelled' });
  assert.equal(
    (
      await controlActions(
        plan,
        journal,
        () => {},
        api,
        () => false,
        () => {},
      )
    ).status,
    'interrupted',
  );
});
test('log and timing outages preserve an observed failing verdict', async t => {
  const { plan, journal } = controllerFixture(t),
    { api } = transport(plan, journal, { conclusion: 'failure' });
  const request = api.request;
  api.request = async (...args) => {
    if (args[0].endsWith('/timing')) throw Error('offline');
    return request(...args);
  };
  api.log = async () => {
    throw Error('offline');
  };
  const result = await controlActions(
    plan,
    journal,
    () => {},
    api,
    () => false,
    () => {},
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.billableMinutes, []);
});
test('queue cancellation before export starts no remote mutation', async t => {
  const { work, run, path } = fixture(t);
  const { CheckQueue } = await import('../dist/check-queue.js');
  t.mock.method(CheckQueue.prototype, 'cancelled', () => true);
  await launchGithubActionsRun(work.store, run, {}, async () => assert.fail('must not export'));
  assert.equal(read(join(path, 'result.json')).status, 'cancelled');
});

test('snapshot commit preserves CRLF bytes despite source Git attributes', async t => {
  const { work, run, path } = fixture(t, {
    '.gitattributes': '*.txt text eol=lf\n',
    'fixture.txt': 'synthetic\r\nsource\r\n',
  });
  const { workGit } = await import('../dist/work-git.js');
  let api;
  const proxy = {
    request: (...args) => api.request(...args),
    pages: (...args) => api.pages(...args),
    log: (...args) => api.log(...args),
    sleep: async () => {},
  };
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async (plan, journal, save) => {
      await exportActionsSnapshot(plan, journal, save, async (_, args) => {
        assert.ok(args.includes('ls-remote') || args.includes('push'));
        return '';
      });
      assert.equal(
        workGit(plan.source, ['show', `${journal.commit}:fixture.txt`]),
        'synthetic\r\nsource\r\n',
      );
      assert.match(
        workGit(plan.source, ['show', `${journal.commit}:.github/workflows/forge-check.yml`]),
        /workflow_dispatch/,
      );
      api = transport(plan, journal).api;
    },
    async () => {},
  );
  assert.equal(read(join(path, 'result.json')).status, 'passed');
});
test('lost rerun response reconciles new jobs without a second rerun', async t => {
  const { plan, journal } = controllerFixture(t),
    { api, calls } = transport(plan, journal, { conclusion: 'timed_out' });
  const request = api.request;
  api.request = async (...args) => {
    const result = await request(...args);
    if (args[0].endsWith('/rerun')) throw Error('lost response');
    return result;
  };
  await assert.rejects(
    controlActions(
      plan,
      journal,
      () => {},
      api,
      () => false,
      () => {},
    ),
  );
  assert.equal(
    (
      await controlActions(
        plan,
        journal,
        () => {},
        api,
        () => false,
        () => {},
      )
    ).status,
    'passed',
  );
  assert.equal(calls.filter(call => call.endpoint.endsWith('/rerun')).length, 1);
});

test('gh transport uses stdin JSON, paged reads and raw job-log output with a fake executable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-gh-shim-'));
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    join(root, 'gh'),
    `#!${process.execPath}\n(async()=>{const args=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;if(args[1].endsWith('/logs'))process.stdout.write('synthetic job log');else if(args.includes('--slurp'))process.stdout.write(JSON.stringify([{jobs:[{id:1}]},{jobs:[{id:2}]}]));else process.stdout.write(JSON.stringify({args,body:JSON.parse(input||'null')}));})();\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${previous}`;
  const response = await actionsApi.request('repos/synthetic/checks/fixture', 'POST', { runId: 'synthetic' });
  assert.deepEqual(response.body, { runId: 'synthetic' });
  assert.ok(response.args.includes('--input'));
  assert.deepEqual(await actionsApi.pages('repos/synthetic/checks/jobs', 'jobs'), [{ id: 1 }, { id: 2 }]);
  assert.equal(await actionsApi.log(20, 'synthetic/checks'), 'synthetic job log');
});

for (const scenario of [
  { name: 'docs check without scoped opt-in', path: 'docs/development.md', scope: 'docs', normal: true },
  { name: 'docs candidate', path: 'docs/development.md', scope: 'docs', optimistic: true },
  { name: 'scoped code candidate', path: 'src/a.ts', scope: 'scoped', optimistic: true },
  { name: 'recovery candidate', path: 'src/a.ts', scope: 'scoped', recovery: true },
  { name: 'explicit full code check', path: 'src/a.ts', scope: 'full' },
  { name: 'post-accept docs audit', path: 'docs/development.md', scope: 'full', audit: true },
  { name: 'protected tooling candidate', path: 'package-lock.json', scope: 'full', optimistic: true },
  { name: 'missing main comparison', path: 'src/a.ts', scope: 'full', optimistic: true, missing: true },
  {
    name: 'docs interaction retry',
    path: 'docs/development.md',
    scope: 'docs',
    optimistic: true,
    interaction: true,
  },
]) {
  test(`Actions scope matches local and Modal: ${scenario.name}`, async t => {
    const { work, run, view, path } = fixture(t, {
      'docs/development.md': '# Synthetic docs\n',
      'src/a.ts': 'export const a = 1;\n',
      'tests/a.test.mjs': "import { a } from '../dist/a.js';\n",
      'tests/unrelated.test.mjs': 'export {};\n',
      'scripts/forge-check.mjs': '// Synthetic standard command\n',
      'package-lock.json': '{"packages":{}}\n',
    });
    const source = new NativeSource(work.store.root);
    // Fresh native owners must pin bootstrap main without any accepted moves.
    assert.equal(work.store.load().channelMoves.length, 0);
    assert.equal(view.composedMain, run.head);
    run.comparisonBase = view.composedMain;
    run.head = source.writeState(
      source
        .state(run.head)
        .files.map(file =>
          file.path === scenario.path
            ? { ...file, blob: source.put(Buffer.from(source.object(file.blob).toString() + '\n')) }
            : file,
        ),
      [run.head],
      'Synthetic candidate',
      new Date().toISOString(),
    );
    run.check = { ...run.check, args: ['scripts/forge-check.mjs'] };
    // Optimistic/recovery candidates must override an inherited full environment,
    // exactly as local preparation does. Ordinary checks and audits stay full.
    run.environment.env = scenario.normal ? {} : { FORGE_CHECK_FULL: '1' };
    setPolicy(
      work.store,
      {
        action: 'set-policy',
        operationId: randomUUID(),
        checks: { shards: 1 },
      },
      localPerson(),
      work.store.load().revision,
    );
    if (scenario.optimistic) run.optimistic = true;
    if (scenario.recovery)
      run.recovery = { auditRunId: randomUUID(), phase: 'retry', tests: ['tests/unrelated.test.mjs'] };
    if (scenario.audit) run.mainCheck = { channel: 'main' };
    if (scenario.missing) {
      delete run.comparisonBase;
      run.environment.env = { FORGE_CHECK_SCOPED: '1' };
    }
    if (scenario.interaction) {
      work.store.locked(() => {
        const tx = work.store.records();
        tx.setSchema(15);
        work.store.commitRecords(tx);
      });
      run.interaction = {
        version: 1,
        reusedRunId: randomUUID(),
        base: run.comparisonBase,
        checkedHead: run.comparisonBase,
        main: run.comparisonBase,
        mergedHead: run.head,
        eligible: true,
        reason: 'Synthetic docs overlap',
        basis: 'docs-overlap',
        lanePaths: [scenario.path],
        mainPaths: [scenario.path],
        overlap: [scenario.path],
      };
    }
    const modalPath = join(work.store.directory, `modal-parity-${run.id}`);
    mkdirSync(modalPath);
    const modal = await modalPlan(work.store, run, modalPath, 1);
    const files = new Map(
      source.state(run.head).files.map(file => [file.path, source.object(file.blob).toString('utf8')]),
    );
    const local = standardSelection({
      files,
      paths: scenario.missing ? undefined : [scenario.path],
      optimistic: !!(run.optimistic || run.recovery),
      recovery: run.recovery,
      mainCheck: run.mainCheck,
      interaction: run.interaction,
      env: run.environment.env,
    });
    assert.equal(local.scope, scenario.scope, local.reason);
    let fake, exported;
    const proxy = {
      request: (...args) => fake.api.request(...args),
      pages: (...args) => fake.api.pages(...args),
      log: (...args) => fake.api.log(...args),
      sleep: async () => {},
    };
    await launchGithubActionsRun(
      work.store,
      run,
      proxy,
      async (plan, journal, save) => {
        exported = githubActionsRecipe(plan);
        assert.deepEqual(exported.selection, local);
        assert.deepEqual(exported.selection, modal.selection);
        assert.deepEqual(exported.groups, modal.groups);
        journal.commit = 'a'.repeat(40);
        journal.pushed = true;
        save();
        fake = transport(plan, journal);
      },
      async () => {},
    );
    assert.equal(read(join(path, 'result.json')).status, 'passed');
    assert.deepEqual(read(join(path, 'result.json')).checkSelection, {
      scope: local.scope,
      reason: local.reason,
      tests: local.tests,
      ...(local.coverage ? { coverage: local.coverage } : {}),
    });
    const dispatch = fake.calls.find(call => call.endpoint.endsWith('/dispatches'));
    const matrix = JSON.parse(dispatch.body.inputs.plan);
    assert.deepEqual(
      matrix,
      exported.groups.map((_, index) => index),
    );
    if (scenario.scope === 'docs') assert.deepEqual(matrix, []);
    else assert.ok(matrix.length > 0);
    if (scenario.scope === 'scoped') {
      assert.ok(exported.selection.tests.includes('tests/a.test.mjs'));
      assert.equal(exported.selection.tests.includes('tests/unrelated.test.mjs'), !!scenario.recovery);
    }
  });
}

test('bootstrap scope is used only before main has an acceptance', t => {
  const { work, run } = fixture(t);
  const source = new NativeSource(work.store.root);
  const data = work.store.load();
  assert.equal(composedNativeMain(source, data, run.head), data.nativeHead);
  const accepted = source.writeState(
    source.state(run.head).files,
    [run.head],
    'Synthetic accepted main',
    new Date().toISOString(),
  );
  data.channelMoves.push({ channel: 'main', status: 'accepted', head: accepted });
  assert.equal(composedNativeMain(source, data, run.head), undefined);
  assert.equal(composedNativeMain(source, data, accepted), accepted);
});

test('benchmark one and four shard plans match the Forge Actions plan and executor', async t => {
  const { benchmarkPlan } = await import('../scripts/bench-landing-shard.mjs');
  const { runActionsCheck } = await import('../scripts/github-actions-check.mjs');
  const { work, run } = fixture(t, {
    'scripts/forge-check.mjs': '// Synthetic standard check\n',
    'package-lock.json': '{}\n',
    'tests/z.test.mjs': '// synthetic z\n',
    'tests/a.test.mjs': '// synthetic a\n',
    'tests/m.test.mjs': '// synthetic m\n',
    'tests/b.test.mjs': '// synthetic b\n',
    'tests/x.test.mjs': '// synthetic x\n',
  });
  run.check = { ...run.check, args: ['scripts/forge-check.mjs'] };
  run.environment.env = { FORGE_CHECK_FULL: '1' };
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.FORGE_CHECK_FULL = '1';
  const source = new NativeSource(work.store.root);
  const files = new Map(
    source.state(run.head).files.map(file => [file.path, source.object(file.blob).toString('utf8')]),
  );
  for (const count of [1, 4]) {
    const path = join(work.store.directory, `bench-parity-${count}`);
    mkdirSync(path);
    const forge = await modalPlan(work.store, run, path, count);
    const github = benchmarkPlan(count, {}, files);
    assert.deepEqual(github.selection, forge.selection);
    assert.deepEqual(github.groups, forge.groups);
    assert.equal(github.groups.length, count);
    const filename = join(path, 'benchmark-plan.json');
    writeFileSync(filename, JSON.stringify(github));
    process.env.FORGE_ACTIONS_PLAN = filename;
    for (const shard of ['static', ...github.groups.map((_, index) => String(index))]) {
      process.env.FORGE_ACTIONS_SHARD = shard;
      const calls = [];
      runActionsCheck((command, args, options) => calls.push({ command, args, env: options.env }), {
        install: false,
      });
      assert.ok(
        calls.every(call => call.args[0] !== 'ci'),
        'workflow already installed dependencies',
      );
      if (shard === 'static') {
        assert.deepEqual(calls.at(-1).args, ['scripts/verify.mjs']);
        assert.deepEqual(JSON.parse(calls.at(-1).env.FORGE_SELECTED_TESTS).tests, []);
      } else {
        assert.deepEqual(
          calls.map(call => call.args),
          [
            ['run', 'build:core'],
            ['run', 'build:web'],
            ['scripts/test-files.mjs', ...forge.groups[Number(shard)]],
          ],
        );
      }
      assert.equal(calls.at(-1).env.FORGE_MAX_CONCURRENT_CHECKS, '2');
      assert.equal(calls.at(-1).env.FORGE_TEST_WORKERS, '2');
    }
  }
  const docs = benchmarkPlan(1, { paths: ['docs/example.md'] }, files);
  // Full overrides remain pinned; scoped docs selection is covered without that override.
  delete process.env.FORGE_CHECK_FULL;
  process.env.FORGE_CHECK_SCOPED = '1';
  const scopedDocs = benchmarkPlan(1, { paths: ['docs/example.md'] }, files);
  assert.equal(docs.selection.scope, 'full');
  assert.equal(scopedDocs.selection.scope, 'docs');
  assert.deepEqual(scopedDocs.groups, []);
});

test('exhausted transient check-ref pushes end as terminal infrastructure failure', async t => {
  const { work, run, path } = fixture(t);
  let pushes = 0;
  const waits = [];
  await launchGithubActionsRun(
    work.store,
    run,
    { sleep: async ms => waits.push(ms) },
    async (plan, journal, save, _git, _commit, sleep, progress) => {
      await exportActionsSnapshot(
        plan,
        journal,
        save,
        async (_, args) => {
          if (args[0] === 'ls-remote') return '';
          pushes++;
          const detail = '! [remote rejected] a -> forge-check/run (failed)';
          throw new GitSyncError(detail, transientGitFailure(detail));
        },
        () => 'a'.repeat(40),
        sleep,
        progress,
      );
    },
  );
  const receipt = read(join(path, 'result.json'));
  assert.equal(receipt.status, 'interrupted');
  assert.equal(receipt.error.code, 'GITHUB_ACTIONS_PUSH_EXHAUSTED');
  assert.match(receipt.details, /terminal infrastructure failure, not a source verdict/);
  assert.equal(read(join(path, 'github-actions.json')).terminal, true);
  const { strandedActionsRun } = await import('../dist/github-actions-recovery.js');
  assert.equal(strandedActionsRun(work.store, { ...run, status: 'interrupted' }), false);
  assert.equal(pushes, 5);
  assert.equal(waits.length, 4);
  waits.forEach((ms, i) => assert.ok(ms >= 1000 * 2 ** i && ms <= 3000 * 2 ** i));
  assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 45_000);
  assert.match(readFileSync(join(path, 'stdout.log'), 'utf8'), /retry 5\/5/);
  assert.equal(read(join(path, 'github-actions.json')).dispatching, undefined);
});

test('Blacksmith zero API billing still records timestamp USD, retries and pinned rate on adoption', async t => {
  const { work, run, path } = fixture(t);
  setPolicy(
    work.store,
    {
      action: 'set-policy',
      operationId: randomUUID(),
      checks: {
        runsOn: 'blacksmith-4vcpu-ubuntu-2404',
        ratesUsdPerMinute: { 'blacksmith-4vcpu-ubuntu-2404': 0.008 },
      },
    },
    localPerson(),
    work.store.revision(),
  );
  let api;
  const proxy = {
    request: (...args) => api.request(...args),
    pages: (...args) => api.pages(...args),
    log: (...args) => api.log(...args),
    sleep: async () => {},
  };
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async (plan, journal, save) => {
      journal.commit = 'a'.repeat(40);
      journal.pushed = true;
      save();
      api = transport(plan, journal, { conclusion: 'timed_out' }).api;
      const request = api.request;
      api.request = async (...args) =>
        args[0].endsWith('/timing')
          ? { billable: { SELF_HOSTED: { jobs: 1, job_runs: [] } } }
          : request(...args);
    },
    async () => {},
  );
  const receipt = read(join(path, 'result.json'));
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(receipt.backend.billableMinutes, []);
  assert.equal(receipt.backend.cost.billedMinutes, 4);
  assert.equal(receipt.backend.estimatedCostUsd, 0.032);
  assert.deepEqual(
    receipt.backend.cost.items.map(item => item.id),
    ['20', '21'],
  );
  setPolicy(
    work.store,
    {
      action: 'set-policy',
      operationId: randomUUID(),
      checks: {
        runner: 'local',
        runsOn: 'ubuntu-latest',
        ratesUsdPerMinute: { 'blacksmith-4vcpu-ubuntu-2404': 100 },
      },
    },
    localPerson(),
    work.store.revision(),
  );
  run.status = 'running';
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async () => {},
    async () => {},
  );
  assert.equal(read(join(path, 'result.json')).backend.cost.estimatedCostUsd, 0.032);
  assert.equal(read(join(path, 'github-actions.json')).rateUsdPerMinute, 0.008);
});

for (const replacement of ['same-family', 'same-family-legacy', 'other-family', 'accepted', 'none']) {
  test(`runner supersession cancels only an older Candidate: ${replacement}`, async t => {
    const { work, run, view, path } = fixture(t);
    if (replacement === 'same-family-legacy') {
      delete run.supersessionBaseline;
      work.store.locked(() => {
        const tx = work.store.records();
        tx.replace('runs', tx.find('runs', run.id).position, run);
        work.store.commitRecords(tx);
      });
    }
    if (replacement === 'accepted')
      work.store.locked(() => {
        const tx = work.store.records();
        tx.append('channelMoves', {
          id: randomUUID(),
          channel: 'main',
          viewId: view.id,
          head: view.head,
          previous: null,
          at: new Date().toISOString(),
          status: 'accepted',
          provenance: 'user-declared-local',
        });
        work.store.commitRecords(tx);
      });
    let api,
      calls,
      replaced = false,
      polls = 0;
    const proxy = {
      request: async (...args) => {
        const value = await api.request(...args);
        if (!replaced && args[0].endsWith('/runs/10')) {
          replaced = true;
          if (replacement !== 'none')
            work.store.locked(() => {
              const tx = work.store.records();
              tx.append('views', {
                ...view,
                id: randomUUID(),
                ...(replacement === 'same-family-legacy'
                  ? { at: new Date(Date.parse(run.startedAt) + 1).toISOString() }
                  : {}),
                ...(replacement === 'other-family' ? { inputs: [] } : {}),
              });
              work.store.commitRecords(tx);
            });
        }
        return value;
      },
      pages: (...args) => api.pages(...args),
      log: (...args) => api.log(...args),
      sleep: async () => {},
    };
    await launchGithubActionsRun(
      work.store,
      run,
      proxy,
      async (plan, journal, save) => {
        journal.commit = 'a'.repeat(40);
        journal.pushed = true;
        save();
        ({ api, calls } = transport(plan, journal));
        if (replacement.startsWith('same-family')) {
          const request = api.request;
          api.request = async (...args) => {
            const value = await request(...args);
            if (args[0].endsWith('/runs/10') && ++polls === 1) value.status = 'in_progress';
            return value;
          };
        }
      },
      async () => {},
    );
    const receipt = read(join(path, 'result.json'));
    assert.equal(receipt.status, replacement.startsWith('same-family') ? 'cancelled' : 'passed');
    assert.equal(
      calls.filter(call => call.endpoint.endsWith('/10/cancel')).length,
      replacement.startsWith('same-family') ? 1 : 0,
    );
    if (replacement.startsWith('same-family')) {
      assert.equal(receipt.cancellation.reason, 'superseded');
      assert.deepEqual(receipt.cancellation.actor, { kind: 'system', name: 'Forge check controller' });
      assert.match(receipt.details, /cancelled-superseded/);
      assert.equal(
        receipt.cancellation.supersededBy,
        work.store.records().all('views', view.intentId, 'intentId').at(-1).id,
      );
      assert.deepEqual(receipt.backend.executionIds, ['10']);
      assert.equal(work.store.select('runs', run.id).cancellation.reason, 'superseded');
    }
  });
}

test('controller signal observation retains SIGTERM and leaves sender unknown', async t => {
  const { CheckQueue } = await import('../dist/check-queue.js');
  const { work, run, path } = fixture(t);
  t.mock.method(CheckQueue.prototype, 'cancelled', () => {
    process.emit('SIGTERM', 'SIGTERM');
    return false;
  });
  await launchGithubActionsRun(work.store, run, {}, async () => assert.fail('must not export'));
  const receipt = read(join(path, 'result.json'));
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.cancellation.reason, 'signal');
  assert.equal(receipt.cancellation.signal, 'SIGTERM');
  assert.equal(receipt.cancellation.actor, undefined);
});

for (const legacy of [false, true, 'unknown-time']) {
  test(`a fresh request can check an already superseded Candidate (legacy=${legacy})`, async t => {
    const { work, run, view, path } = fixture(t);
    const replacement = {
      ...view,
      id: randomUUID(),
      ...(legacy === 'unknown-time' ? { at: 'unknown' } : {}),
    };
    if (legacy) delete run.supersessionBaseline;
    else run.supersessionBaseline = replacement.id;
    work.store.locked(() => {
      const tx = work.store.records();
      tx.append('views', replacement);
      tx.replace('runs', tx.find('runs', run.id).position, run);
      work.store.commitRecords(tx);
    });
    let api;
    const proxy = {
      request: (...args) => api.request(...args),
      pages: (...args) => api.pages(...args),
      log: (...args) => api.log(...args),
      sleep: async () => {},
    };
    await launchGithubActionsRun(
      work.store,
      run,
      proxy,
      async (plan, journal, save) => {
        journal.commit = 'a'.repeat(40);
        journal.pushed = true;
        save();
        api = transport(plan, journal).api;
      },
      async () => {},
    );
    assert.equal(read(join(path, 'result.json')).status, 'passed');
    assert.equal(work.store.select('runs', run.id).cancelRequested, undefined);
  });
}

test('acceptance racing supersession observation prevents cancellation of the accepted check', async t => {
  const { work, run, view, path } = fixture(t);
  const locked = work.store.locked.bind(work.store),
    readRecords = work.store.readRecords.bind(work.store);
  let replaced = false,
    observed = false,
    accepted = false;
  t.mock.method(work.store, 'readRecords', () => {
    const tx = readRecords();
    if (replaced) observed = true;
    return tx;
  });
  t.mock.method(work.store, 'locked', (...args) => {
    if (replaced && observed && !accepted) {
      accepted = true;
      locked(() => {
        const tx = work.store.records();
        tx.append('channelMoves', {
          id: randomUUID(),
          channel: 'main',
          viewId: view.id,
          head: view.head,
          previous: null,
          at: new Date().toISOString(),
          status: 'accepted',
          provenance: 'user-declared-local',
        });
        work.store.commitRecords(tx);
      });
    }
    return locked(...args);
  });
  let api, calls;
  const proxy = {
    request: async (...args) => {
      const value = await api.request(...args);
      if (!replaced && args[0].endsWith('/runs/10')) {
        work.store.locked(() => {
          const tx = work.store.records();
          tx.append('views', { ...view, id: randomUUID() });
          work.store.commitRecords(tx);
        });
        replaced = true;
        value.status = 'in_progress';
      }
      return value;
    },
    pages: (...args) => api.pages(...args),
    log: (...args) => api.log(...args),
    sleep: async () => {},
  };
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async (plan, journal, save) => {
      journal.commit = 'a'.repeat(40);
      journal.pushed = true;
      save();
      ({ api, calls } = transport(plan, journal));
    },
    async () => {},
  );
  assert.equal(accepted, true);
  assert.equal(read(join(path, 'result.json')).status, 'passed');
  assert.equal(calls.filter(call => call.endpoint.endsWith('/cancel')).length, 0);
});

test('exhausted dispatch rejections record failed with HTTP status, not interrupted', async t => {
  const { work, run, path } = fixture(t);
  let dispatches = 0;
  const api = {
    async request(endpoint) {
      if (endpoint.includes('/branches/')) return { commit: { sha: 'a'.repeat(40) } };
      assert.ok(endpoint.endsWith('/dispatches'));
      dispatches++;
      throw new ActionsApiError(404);
    },
    async sleep() {},
    async pages() {
      assert.fail('no run lookup after definitive rejection');
    },
  };
  await launchGithubActionsRun(
    work.store,
    run,
    api,
    async (_plan, journal, save) => {
      journal.commit = 'a'.repeat(40);
      journal.pushed = true;
      save();
    },
    async () => assert.equal(read(join(path, 'result.json')).status, 'failed'),
  );
  const receipt = read(join(path, 'result.json'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.exitCode, 1);
  assert.match(receipt.details, /GITHUB_ACTIONS_DISPATCH_REJECTED.*HTTP 404/);
  assert.equal(dispatches, 5);
  const journal = read(join(path, 'github-actions.json'));
  assert.equal(journal.dispatching, false);
  assert.equal(journal.dispatchOutcome, 'rejected');
  assert.equal(journal.dispatchStatus, 404);
});

for (const via of ['run-check', 'finish', 'observation']) {
  test(`same-op ${via} retry recovers a retained interrupted dispatch without new source or run`, async t => {
    const { work, run, path } = fixture(t);
    const commit = 'a'.repeat(40);
    await launchGithubActionsRun(
      work.store,
      run,
      {
        async request(endpoint) {
          if (endpoint.includes('/branches/')) return { commit: { sha: commit } };
          throw new Error('synthetic lost response');
        },
        async pages() {
          return [];
        },
        async sleep() {},
      },
      async (_plan, journal, save) => {
        journal.commit = commit;
        journal.pushed = true;
        save();
      },
    );
    assert.equal(recoverRuns(work.store, { runs: [run] }), true);
    assert.equal(run.status, 'interrupted');
    assert.equal(run.error.code, 'GITHUB_ACTIONS_PENDING_INFRA');
    assert.match(run.error.message, /pending-infra/);
    // Model an old stranded journal as well as the new ambiguous journal.
    const retained = read(join(path, 'github-actions.json'));
    if (via === 'observation') {
      retained.dispatchRecoveryUsed = true;
      writeFileSync(join(path, 'github-actions.json'), JSON.stringify(retained));
    }
    if (via === 'finish') {
      delete retained.dispatchOutcome;
      delete retained.dispatchLookupExhausted;
      writeFileSync(join(path, 'github-actions.json'), JSON.stringify(retained));
    }
    work.store.locked(() => {
      const tx = work.store.records();
      tx.replace('runs', tx.find('runs', run.id).position, run);
      work.store.commitRecords(tx);
    });
    const previousPath = process.env.PATH;
    const bin = join(path, 'fake-bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!${process.execPath}\nif(process.argv.includes('ls-remote'))process.stdout.write(${JSON.stringify(`${commit}\trefs/heads/forge-check/${run.id}`)});else if(!process.argv.includes('push')&&!process.argv.includes('init'))process.exit(1);\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${previousPath}`;
    t.after(() => {
      process.env.PATH = previousPath;
    });
    const plan = read(join(path, 'modal-plan.json'));
    const fake = transport(plan, retained);
    let dispatches = 0;
    t.mock.method(actionsApi, 'request', async (...args) => {
      if (args[0].endsWith('/dispatches')) dispatches++;
      return fake.api.request(...args);
    });
    let discoveryReads = 0;
    t.mock.method(actionsApi, 'pages', async (...args) => {
      if (args[0].includes('/runs?') && ++discoveryReads <= 2 && via !== 'observation') return [];
      return fake.api.pages(...args);
    });
    t.mock.method(actionsApi, 'log', (...args) => fake.api.log(...args));
    t.mock.method(actionsApi, 'sleep', async () => {});
    const { waitForAgentRun } = await import('../dist/agent-run-observer.js');
    const command = {
      action: 'run-check',
      operationId: run.id,
      viewId: run.viewId,
      expectedHead: run.head,
      checkId: run.check.id,
      expectedDefinition: run.check.definition,
      expectedEnvironment: run.environment.fingerprint,
    };
    if (via !== 'finish') {
      await work.dispatch(command, work.store.revision());
      await work.dispatch(command, work.store.revision());
      await waitForAgentRun(work.store, run.id, 10_000);
    } else {
      const { FinishJournal } = await import('../dist/agent-finish-journal.js');
      const { agentFinish } = await import('../dist/agent-finish.js');
      const finish = {
        action: 'finish',
        operationId: randomUUID(),
        laneId: run.inputs[0].laneId,
        expectedHead: run.inputs[0].head,
        message: 'Synthetic dispatch recovery',
        checkId: run.check.id,
        expectedDefinition: run.check.definition,
        expectedEnvironment: run.environment.fingerprint,
        waitMs: 10_000,
      };
      const journal = new FinishJournal(work.store, finish, run.head);
      const attempt = journal.state.attempts[0];
      attempt.operations.run = run.id;
      attempt.view = { viewId: run.viewId, head: run.head, status: 'clean' };
      journal.state.result = { phase: 'check', status: 'interrupted', terminal: true };
      journal.save();
      const result = await agentFinish(work, finish, {
        checkpoint: async () => ({ result: { head: run.head } }),
        phase: command => work.dispatch(command, work.store.revision()),
        wait: id => waitForAgentRun(work.store, id, 10_000),
        sync: async () => assert.fail('no source sync needed'),
        review: async () => assert.fail('no acceptance requested'),
      });
      assert.equal(result.result.status, 'passed');
    }
    // A result receipt precedes ref cleanup. Keep this fixture and its fake Git
    // alive until the controller has published its final cleanup progress.
    const deadline = Date.now() + 10_000;
    while (
      !readFileSync(join(path, 'stdout.log'), 'utf8').includes(
        'Removed run-owned ref after recording result.',
      )
    ) {
      assert.ok(Date.now() < deadline, 'controller cleanup must complete');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatches, 0);
    assert.equal(work.store.select('runs', run.id).status, 'passed');
    assert.equal(work.store.load().runs.length, 1);
    assert.equal(
      read(join(path, 'github-actions.json')).dispatchRecoveryUsed,
      via === 'observation' ? true : undefined,
    );
    const { readdirSync } = await import('node:fs');
    const previous = readdirSync(path).find(file => file.startsWith('result.json.interrupted-'));
    assert.ok(previous, 'old interrupted receipt remains available');
    assert.equal(read(join(path, previous)).status, 'interrupted');
  });
}

for (const conclusion of ['success', 'failure', 'cancelled']) {
  test(`runner retains results and logs before deleting a terminal ${conclusion} branch`, async t => {
    const { work, run, path } = fixture(t);
    let api,
      deleted = 0;
    const proxy = {
      request: (...args) => api.request(...args),
      pages: (...args) => api.pages(...args),
      log: (...args) => api.log(...args),
      sleep: async () => {},
    };
    await launchGithubActionsRun(
      work.store,
      run,
      proxy,
      async (plan, journal, save) => {
        journal.commit = 'a'.repeat(40);
        journal.pushed = true;
        save();
        api = transport(plan, journal, { conclusion }).api;
      },
      async () => {
        deleted++;
        assert.equal(read(join(path, 'github-actions.json')).terminal, true);
        assert.equal(
          read(join(path, 'result.json')).status,
          conclusion === 'success' ? 'passed' : conclusion === 'failure' ? 'failed' : 'interrupted',
        );
        assert.match(readFileSync(join(path, 'shards/static.log'), 'utf8'), /synthetic smoke/);
      },
    );
    assert.equal(deleted, 1);
  });
}

test('HTTP 400 stays pending, then adopts the original execution and retains diagnostics', async t => {
  const { work, run, path } = fixture(t);
  let api,
    dispatches = 0,
    reads = 0;
  const proxy = {
    request: (...args) => api.request(...args),
    pages: (...args) => api.pages(...args),
    log: (...args) => api.log(...args),
    sleep: async () => {},
  };
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async (plan, journal, save) => {
      journal.commit = 'a'.repeat(40);
      journal.pushed = true;
      save();
      api = transport(plan, journal).api;
      const request = api.request,
        pages = api.pages;
      api.request = async (...args) => {
        if (args[0].endsWith('/dispatches')) {
          dispatches++;
          throw new ActionsApiError(400, {
            message: 'Invalid request body',
            documentation_url: 'https://docs.github.com/rest/actions/workflows',
          });
        }
        return request(...args);
      };
      api.pages = (...args) => (args[0].includes('/runs?') && ++reads < 16 ? [] : pages(...args));
    },
    async () => assert.fail('unresolved execution must keep its ref'),
  );
  const pending = read(join(path, 'result.json'));
  assert.equal(pending.status, 'interrupted');
  assert.equal(pending.error.code, 'GITHUB_ACTIONS_PENDING_INFRA');
  assert.match(pending.details, /pending-infra.*HTTP 400/);
  recoverRuns(work.store, { runs: [run] });
  assert.equal(run.error.code, 'GITHUB_ACTIONS_PENDING_INFRA');
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async () => {},
    async () => {},
  );
  const result = read(join(path, 'result.json'));
  assert.equal(result.status, 'passed');
  assert.equal(result.error, undefined);
  const journal = read(join(path, 'github-actions.json'));
  assert.equal(journal.dispatchRecoveryUsed, undefined);
  assert.equal(dispatches, 1);
  assert.equal(journal.apiFailures[0].message, 'Invalid request body');
  assert.equal(journal.dispatchAttempts[0].outcome, 'ambiguous');
  assert.match(readFileSync(join(path, 'stdout.log'), 'utf8'), /Invalid request body/);
});

test('non-dispatch API failures survive retry and optional timing/log fallback', async t => {
  const { work, run, path } = fixture(t);
  let api;
  const proxy = {
    request: (...args) => api.request(...args),
    pages: (...args) => api.pages(...args),
    log: (...args) => api.log(...args),
    sleep: async () => {},
  };
  await launchGithubActionsRun(
    work.store,
    run,
    proxy,
    async (plan, journal, save) => {
      journal.commit = 'a'.repeat(40);
      journal.pushed = true;
      save();
      api = transport(plan, journal).api;
      const request = api.request;
      api.request = async (...args) => {
        if (args[0].endsWith('/timing')) throw new ActionsApiError(503, { message: 'Timing unavailable' });
        return request(...args);
      };
      api.log = async () => {
        throw new ActionsApiError(404, {
          message: 'Logs unavailable',
          documentation_url: 'https://docs.github.com/rest/actions',
        });
      };
    },
    async () => {},
  );
  assert.equal(read(join(path, 'result.json')).status, 'passed');
  const failures = read(join(path, 'github-actions.json')).apiFailures;
  assert.equal(failures.filter(error => error.message === 'Timing unavailable').length, 6);
  assert.equal(failures.filter(error => error.message === 'Logs unavailable').length, 6);
  assert.match(readFileSync(join(path, 'stdout.log'), 'utf8'), /GitHub: Logs unavailable/);
});

for (const mode of [
  'terminal',
  'local-running',
  'remote-running',
  'wrong-head',
  'wrong-title',
  'unknown-dispatch',
  'reopened',
]) {
  test(`stale check-ref sweep requires local and remote terminal evidence: ${mode}`, async t => {
    const { sweepActionsRefs } = await import('../dist/github-actions-cleanup.js');
    const { work, run, path } = fixture(t);
    let api;
    const proxy = {
      request: (...args) => api.request(...args),
      pages: (...args) => api.pages(...args),
      log: (...args) => api.log(...args),
      sleep: async () => {},
    };
    await launchGithubActionsRun(
      work.store,
      run,
      proxy,
      async (plan, journal, save) => {
        journal.commit = 'a'.repeat(40);
        journal.pushed = true;
        save();
        api = transport(plan, journal).api;
      },
      async () => {},
    );
    recoverRuns(work.store, { runs: [run] });
    if (mode === 'local-running') run.status = 'running';
    const saveRun = () =>
      work.store.locked(() => {
        const tx = work.store.records();
        tx.replace('runs', tx.find('runs', run.id).position, run);
        work.store.commitRecords(tx);
      });
    saveRun();
    const journalPath = join(path, 'github-actions.json'),
      journal = read(journalPath);
    if (mode === 'unknown-dispatch') {
      delete journal.runId;
      journal.dispatchOutcome = 'ambiguous';
    }
    writeFileSync(journalPath, JSON.stringify(journal));
    let deleted = 0,
      reads = 0;
    await sweepActionsRefs(
      work.store,
      'synthetic/checks',
      {
        async request() {
          reads++;
          if (mode === 'reopened') {
            run.status = 'running';
            saveRun();
          }
          return {
            id: journal.runId,
            head_sha: mode === 'wrong-head' ? 'wrong' : journal.commit,
            display_title: mode === 'wrong-title' ? 'other' : `forge-check/${run.id}`,
            status: mode === 'remote-running' ? 'in_progress' : 'completed',
          };
        },
        sleep: async () => {},
      },
      () => {},
      async (_plan, selected, save) => {
        deleted++;
        selected.deleted = true;
        save();
      },
    );
    assert.equal(deleted, mode === 'terminal' ? 1 : 0);
    assert.equal(reads, ['local-running', 'unknown-dispatch'].includes(mode) ? 0 : 1);
    assert.equal(read(journalPath).deleted, mode === 'terminal' ? true : undefined);
  });
}

test('stale check-ref sweep reads bounded pages and rotates through retained history', async t => {
  const { sweepActionsRefs } = await import('../dist/github-actions-cleanup.js');
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-sweep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const offsets = [];
  const store = {
    directory: root,
    page(collection, offset, limit) {
      assert.equal(collection, 'runs');
      assert.equal(limit, 20);
      offsets.push(offset);
      return {
        total: 45,
        records: Array.from({ length: Math.min(20, 45 - offset) }, () => ({ status: 'running' })),
      };
    },
  };
  for (let attempt = 0; attempt < 4; attempt++)
    await sweepActionsRefs(
      store,
      'synthetic/checks',
      {},
      () => {},
      async () => assert.fail('no terminal ops'),
    );
  assert.deepEqual(offsets, [0, 20, 40, 0]);
});

test('ref cleanup survives reclaimed source exports using an empty disposable Git repository', async t => {
  const { plan, journal } = controllerFixture(t);
  plan.source = join(plan.output, 'reclaimed-source');
  let temporary,
    deleted = false;
  await deleteActionsRef(
    plan,
    journal,
    () => {},
    async (root, args) => {
      temporary = root;
      assert.notEqual(root, plan.source);
      assert.equal(existsSync(root), true);
      if (args[0] === 'init') {
        assert.deepEqual(args, ['init', '--bare', '--template=']);
        return '';
      }
      if (args[0] === 'ls-remote') return `${journal.commit}\trefs/heads/forge-check/${plan.runId}`;
      assert.equal(args[0], 'push');
      assert.ok(args.includes(`--force-with-lease=refs/heads/forge-check/${plan.runId}:${journal.commit}`));
      assert.equal(args.at(-1), `:refs/heads/forge-check/${plan.runId}`);
      deleted = true;
      return '';
    },
  );
  assert.equal(deleted, true);
  assert.equal(journal.deleted, true);
  assert.equal(existsSync(temporary), false);
});

test('lost shard rerun reply reopens the same run under its retained route after configuration drift', async t => {
  const { work, run, path } = fixture(t);
  let fake;
  await launchGithubActionsRun(
    work.store,
    run,
    {
      request: (...args) => fake.api.request(...args),
      pages: (...args) => fake.api.pages(...args),
      log: (...args) => fake.api.log(...args),
      sleep: async () => {},
    },
    async (plan, journal, save) => {
      journal.commit = 'a'.repeat(40);
      journal.pushed = true;
      save();
      fake = transport(plan, journal, { conclusion: 'startup_failure' });
      const request = fake.api.request;
      fake.api.request = async (...args) => {
        const value = await request(...args);
        if (args[0].endsWith('/rerun')) throw Error('synthetic lost rerun response');
        return value;
      };
    },
    async () => assert.fail('pending recovery must retain its ref'),
  );
  recoverRuns(work.store, { runs: [run] });
  assert.equal(run.status, 'interrupted');
  assert.equal(run.error.code, 'GITHUB_ACTIONS_PENDING_INFRA');
  const { strandedActionsRun } = await import('../dist/github-actions-recovery.js');
  assert.equal(strandedActionsRun(work.store, run), true);
  assert.equal(strandedActionsRun(work.store, { ...run, status: 'failed' }), false);
  assert.equal(strandedActionsRun(work.store, { ...run, cancelRequested: true }), false);
  work.store.locked(() => {
    const tx = work.store.records();
    tx.replace('runs', tx.find('runs', run.id).position, run);
    work.store.commitRecords(tx);
  });
  setPolicy(
    work.store,
    {
      action: 'set-policy',
      operationId: randomUUID(),
      checks: { runner: 'local', repo: 'synthetic/different', runsOn: 'ubuntu-24.04', shards: 8 },
    },
    localPerson(),
    work.store.revision(),
  );
  const plan = read(join(path, 'modal-plan.json'));
  const retained = read(join(path, 'github-actions.json'));
  const resumed = transport(plan, retained);
  const pages = resumed.api.pages;
  resumed.api.pages = async (...args) => (await pages(...args)).map(job => ({ ...job, id: 21 }));
  t.mock.method(actionsApi, 'request', (...args) => resumed.api.request(...args));
  t.mock.method(actionsApi, 'pages', (...args) => resumed.api.pages(...args));
  t.mock.method(actionsApi, 'log', (...args) => resumed.api.log(...args));
  t.mock.method(actionsApi, 'sleep', async () => {});
  const bin = join(path, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}\nif(process.argv.includes('ls-remote'))process.stdout.write(${JSON.stringify(`${retained.commit}\trefs/heads/forge-check/${run.id}`)});else if(!process.argv.includes('push')&&!process.argv.includes('init'))process.exit(1);\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  const command = {
    action: 'run-check',
    operationId: run.id,
    viewId: run.viewId,
    expectedHead: run.head,
    checkId: run.check.id,
    expectedDefinition: run.check.definition,
    expectedEnvironment: run.environment.fingerprint,
  };
  const { CheckQueue } = await import('../dist/check-queue.js');
  let released;
  const finished = new Promise(resolve => {
    released = resolve;
  });
  const release = CheckQueue.prototype.release;
  t.mock.method(CheckQueue.prototype, 'release', function () {
    const selected = read(join(this.path, 'ticket.json'));
    const result = release.call(this);
    if (selected.control && selected.runId === run.id) released();
    return result;
  });
  await work.dispatch(command, work.store.revision());
  await (await import('../dist/agent-run-observer.js')).waitForAgentRun(work.store, run.id, 10_000);
  await finished;
  assert.equal(work.store.select('runs', run.id).status, 'passed');
  assert.deepEqual(read(join(path, 'modal-plan.json')), plan);
  assert.equal(work.store.load().runs.length, 1);
  assert.equal(fake.calls.filter(call => call.endpoint.endsWith('/rerun')).length, 1);
  assert.equal(resumed.calls.filter(call => call.method === 'POST').length, 0);
  assert.ok(resumed.calls.every(call => call.endpoint.startsWith('repos/synthetic/checks/')));
  assert.equal(strandedActionsRun(work.store, work.store.select('runs', run.id)), false);
});

for (const mode of ['workflow-scope', 'ambiguous-exhausted']) {
  test(`push ${mode} publishes a terminal infrastructure receipt without dispatch or recovery`, async t => {
    const { work, run, path } = fixture(t);
    const { ensureActionsPush } = await import('../dist/github-actions-push.js');
    let clock = Date.now(),
      pushes = 0;
    await launchGithubActionsRun(
      work.store,
      run,
      {
        request: async () => assert.fail('failed push must not dispatch'),
        pages: async () => assert.fail('failed push must not discover executions'),
      },
      async (plan, journal, save) => {
        journal.commit = 'a'.repeat(40);
        journal.pushOutcome = 'not-sent';
        save();
        await ensureActionsPush(
          plan,
          journal,
          save,
          async (_, args) => {
            if (args[0] === 'ls-remote') return '';
            pushes++;
            if (mode === 'workflow-scope')
              throw new GitSyncError(
                'remote: refusing to allow an OAuth App to create or update workflow .github/workflows/test.yml without `workflow` scope',
                false,
              );
            throw new GitSyncError('RPC failed; early EOF', true);
          },
          async ms => {
            clock += ms;
          },
          undefined,
          () => clock,
        );
      },
      async () => assert.fail('failed push must not clean an unobserved ref'),
    );
    const receipt = read(join(path, 'result.json'));
    assert.equal(receipt.status, 'interrupted');
    assert.equal(receipt.exitCode, null);
    assert.equal(
      receipt.error.code,
      mode === 'workflow-scope' ? 'GITHUB_ACTIONS_PUSH_REJECTED' : 'GITHUB_ACTIONS_PUSH_EXHAUSTED',
    );
    assert.match(receipt.details, /terminal infrastructure failure, not a source verdict/);
    assert.equal(pushes, mode === 'workflow-scope' ? 1 : 5);
    if (mode === 'workflow-scope') assert.match(receipt.details, /token lacks workflow scope/);
    assert.equal(read(join(path, 'github-actions.json')).terminal, true);
    const { strandedActionsRun } = await import('../dist/github-actions-recovery.js');
    assert.equal(strandedActionsRun(work.store, { ...run, status: 'interrupted' }), false);
    recoverRuns(work.store, { runs: [run] });
    assert.equal(run.error.code, receipt.error.code);
  });
}
