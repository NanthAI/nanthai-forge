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
import { actionsApi, observe } from '../dist/github-actions-api.js';
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
  assert.equal(journal.dispatching, true);
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

test('exhausted transient check-ref pushes interrupt with the retained-run message', async t => {
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
  assert.match(receipt.details, /GITHUB_SYNC_GIT_FAILED/);
  assert.match(receipt.details, /reconcile the retained run/);
  assert.match(receipt.details, /source export, dispatch intent and job identities are retained/);
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
