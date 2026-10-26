// SPDX-License-Identifier: Apache-2.0
// Actions controller under GitHub-side stress: rate limits, lagging job lists, OOM diagnosis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { controlActions } from '../dist/github-actions-controller.js';
import { actionsApi, mutate, observe } from '../dist/github-actions-api.js';
import { syncGit } from '../dist/github-sync-git.js';
import { ForgeError } from '../dist/errors.js';

const limited = () => new ForgeError('GITHUB_ACTIONS_RATE_LIMITED', 'synthetic rate limit');
function setup(t, groups = [['a']]) {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-resilience-'));
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
// jobs(poll) returns the job list for the nth jobs read; fail(endpoint, n) may throw per call.
function fakeApi(plan, journal, { jobs, logs = {}, conclusion = 'success', fail = () => {}, resetMs } = {}) {
  const calls = [],
    waits = [],
    counts = {};
  let jobPolls = 0;
  const api = {
    async request(endpoint, method = 'GET') {
      counts[endpoint] = (counts[endpoint] ?? 0) + 1;
      calls.push({ endpoint, method });
      fail(endpoint, counts[endpoint]);
      if (endpoint.includes('/branches/')) return { commit: { sha: journal.commit } };
      if (endpoint.endsWith('/dispatches') || endpoint.endsWith('/timing')) return {};
      return { id: 10, head_sha: journal.commit, status: 'completed', conclusion };
    },
    async pages(endpoint) {
      counts[endpoint] = (counts[endpoint] ?? 0) + 1;
      calls.push({ endpoint });
      fail(endpoint, counts[endpoint]);
      if (endpoint.includes('/runs?'))
        return [{ id: 10, head_sha: journal.commit, display_title: `forge-check/${plan.runId}` }];
      return jobs(++jobPolls);
    },
    async log(id) {
      calls.push({ endpoint: `repos/${journal.repo}/actions/jobs/${id}/logs`, log: id });
      if (logs[id] instanceof Error) throw logs[id];
      return logs[id] ?? 'ok\n';
    },
    async sleep(ms) {
      waits.push(ms);
    },
    ...(resetMs === undefined ? {} : { rateLimitResetMs: async () => resetMs }),
  };
  return { api, calls, waits };
}
const job = (id, name, status = 'completed', conclusion = status === 'completed' ? 'success' : null) => ({
  id,
  name,
  status,
  conclusion,
  run_attempt: 1,
});
const control = (plan, journal, api, progress = []) =>
  controlActions(
    plan,
    journal,
    () => {},
    api,
    () => false,
    line => progress.push(line),
  );

test('a completed run whose job list lags is observed again, not interrupted', async t => {
  const { plan, journal } = setup(t);
  // P1c burst-8 #2: the run said completed while the job list still showed a shard in progress.
  const { api, waits } = fakeApi(plan, journal, {
    jobs: poll => [
      job(1, 'forge-static'),
      poll < 4 ? job(2, 'forge-shard-0', 'in_progress') : job(2, 'forge-shard-0'),
    ],
  });
  const progress = [];
  const outcome = await control(plan, journal, api, progress);
  assert.equal(outcome.status, 'passed');
  assert.equal(outcome.exitCode, 0);
  assert.equal(waits.filter(ms => ms === 10_000).length, 3);
  assert.ok(progress.some(line => /job list to settle/.test(line)));
  assert.equal(journal.stuckJobs, undefined);
});

test('a job list that never settles is interrupted after a bounded wait', async t => {
  const { plan, journal } = setup(t);
  const { api, waits } = fakeApi(plan, journal, {
    jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'in_progress')],
  });
  const outcome = await control(plan, journal, api);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(waits.length, 30);
  assert.match(outcome.jobStatusSummary, /log missing or incomplete/);
});

const passingSummary =
  '# tests 785\n# suites 0\n# pass 785\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const marker = (file, results, complete = true) =>
  `__FORGE_TESTS__${JSON.stringify({ file, results, complete })}\n`;

test('a successful run with a stuck job passes using complete timestamped node summary evidence', async t => {
  const { plan, journal } = setup(t);
  const log = passingSummary.replace(/^/gm, '2026-10-22T14:44:47.0000000Z ');
  const { api, calls, waits } = fakeApi(plan, journal, {
    jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'in_progress')],
    logs: { 2: log },
  });
  const progress = [];
  const outcome = await control(plan, journal, api, progress);
  assert.equal(outcome.status, 'passed');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.failureSummary, '');
  assert.equal(waits.length, 30);
  assert.equal(calls.filter(call => call.log === 2).length, 1);
  assert.equal(readFileSync(join(plan.output, 'shards/0.log'), 'utf8'), log);
  assert.equal(journal.states[2], 'in_progress/');
  assert.equal(journal.stuckJobs[2].source, 'node-test-summary');
  assert.equal(journal.stuckJobs[2].passed, 785);
  assert.equal(journal.stuckJobs[2].failed, 0);
  assert.equal(journal.stuckJobs[2].runConclusion, 'success');
  assert.match(
    outcome.jobStatusSummary,
    /job status stuck on GitHub.*log shows 785 passed, 0 failed.*run concluded success/,
  );
  assert.ok(progress.includes(journal.stuckJobs[2].message));
  // Adoption reads retained output and does not duplicate or refetch it.
  api.log = async () => assert.fail('retained logs must be reused');
  assert.equal((await control(plan, journal, api)).status, 'passed');
  assert.equal(readFileSync(join(plan.output, 'shards/0.log'), 'utf8'), log);
});

test('complete result markers cover every selected file before recovering a stuck job', async t => {
  const { plan, journal } = setup(t, [['a', 'b']]);
  const { api } = fakeApi(plan, journal, {
    jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'in_progress')],
    logs: { 2: marker('a', [{ name: 'one', passed: true }]) + marker('b', [{ name: 'two', passed: true }]) },
  });
  assert.equal((await control(plan, journal, api)).status, 'passed');
  assert.equal(journal.stuckJobs[2].source, 'forge-test-markers');
  assert.equal(journal.stuckJobs[2].passed, 2);
});

test('failing logs or a failed run cannot be overridden by a stuck job status', async t => {
  const cases = [
    { log: passingSummary.replace('# fail 0', '# fail 1'), conclusion: 'success' },
    { log: `not ok 1 - failed assertion\n${passingSummary}`, conclusion: 'success' },
    { log: marker('a', [{ name: 'failed', passed: false }]), conclusion: 'success' },
    { log: `##[error]Process completed with exit code 1.\n${passingSummary}`, conclusion: 'success' },
    { log: passingSummary, conclusion: 'failure' },
  ];
  for (const { log, conclusion } of cases) {
    const { plan, journal } = setup(t);
    const { api } = fakeApi(plan, journal, {
      jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'in_progress')],
      logs: { 2: log },
      conclusion,
    });
    const outcome = await control(plan, journal, api);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.jobStatusSummary, /no passing evidence/);
  }
});

test('missing, truncated and incomplete log evidence always interrupts a stuck job', async t => {
  for (const log of [
    '',
    new Error('unavailable'),
    'ok 1 - only the start\n',
    '# tests 785\n# pass 785\n# fail 0\n',
    marker('a', [{ name: 'one', passed: true }], false) + passingSummary,
    marker('other', [{ name: 'one', passed: true }]) + passingSummary,
    '__FORGE_TESTS__{truncated\n' + passingSummary,
  ]) {
    const { plan, journal } = setup(t);
    const { api } = fakeApi(plan, journal, {
      jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'in_progress')],
      logs: { 2: log },
    });
    const outcome = await control(plan, journal, api);
    assert.equal(outcome.status, 'interrupted');
    assert.equal(outcome.exitCode, null);
    assert.equal(journal.stuckJobs[2].status, 'incomplete');
    assert.match(outcome.jobStatusSummary, /log missing or incomplete/);
  }
});

test('passing logs never replace a missing job or a non-successful run conclusion', async t => {
  for (const conclusion of ['neutral', null, 'cancelled']) {
    const { plan, journal } = setup(t);
    const { api } = fakeApi(plan, journal, {
      jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'in_progress')],
      logs: { 2: passingSummary },
      conclusion,
    });
    assert.equal((await control(plan, journal, api)).status, 'interrupted');
  }
  const { plan, journal } = setup(t);
  const { api } = fakeApi(plan, journal, {
    jobs: () => [job(1, 'forge-static')],
    logs: { 1: passingSummary },
  });
  const outcome = await control(plan, journal, api);
  assert.equal(outcome.status, 'interrupted');
  assert.match(outcome.jobStatusSummary, /missing jobs have no passing evidence/);
});

test('rate-limited reads wait for the reported reset and continue past the transport retry cap', async t => {
  const { plan, journal } = setup(t);
  journal.runId = 10;
  const { api, waits } = fakeApi(plan, journal, {
    jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0')],
    // Ten consecutive rate-limit rejections: more than observe's six transport attempts.
    fail: (endpoint, n) => {
      if (endpoint.endsWith('/runs/10') && n <= 10) throw limited();
    },
    resetMs: 120_000,
  });
  const progress = [];
  const outcome = await control(plan, journal, api, progress);
  assert.equal(outcome.status, 'passed');
  assert.deepEqual(
    waits.filter(ms => ms > 10_000),
    Array(10).fill(121_000),
  );
  assert.ok(progress.some(line => /rate limited; waiting 121 s/.test(line)));
});

test('rate-limit waits are at least a minute and at most an hour', async () => {
  for (const [resetMs, expected] of [
    [undefined, 60_000],
    [-5_000, 60_000],
    [10 * 3_600_000, 3_600_000],
  ]) {
    const waits = [];
    let attempt = 0;
    const api = { sleep: async ms => waits.push(ms), rateLimitResetMs: async () => resetMs };
    assert.equal(
      await observe(api, async () => {
        if (!attempt++) throw limited();
        return 'ok';
      }),
      'ok',
    );
    assert.deepEqual(waits, [expected]);
  }
});

test('a rate-limited dispatch is retried once the budget resets; other failures are not', async t => {
  const { plan, journal } = setup(t);
  const { api, calls } = fakeApi(plan, journal, {
    jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0')],
    fail: (endpoint, n) => {
      if (endpoint.endsWith('/dispatches') && n === 1) throw limited();
    },
  });
  assert.equal((await control(plan, journal, api)).status, 'passed');
  assert.equal(calls.filter(call => call.endpoint.endsWith('/dispatches')).length, 2);

  let writes = 0;
  await assert.rejects(
    mutate({ sleep: async () => {} }, async () => {
      writes++;
      throw new ForgeError('GITHUB_ACTIONS_API', 'unknown outcome');
    }),
    /unknown outcome/,
  );
  assert.equal(writes, 1);
});

test('test names mentioning SIGKILL are not an OOM diagnosis; only failed jobs report 137', async t => {
  const { plan, journal } = setup(t, [['a'], ['b']]);
  const { api } = fakeApi(plan, journal, {
    jobs: () => [
      job(1, 'forge-static'),
      job(2, 'forge-shard-0'),
      job(3, 'forge-shard-1', 'completed', 'failure'),
    ],
    logs: {
      2: 'ok 1 - sync resumes after SIGKILL at afterPlan\nok 2 - out of memory guard\n',
      3: 'not ok 3 - a flaky test\n##[error]Process completed with exit code 1.\n',
    },
  });
  const outcome = await control(plan, journal, api);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(journal.oom, []);

  for (const outcome of ['exit code 137', 'signal SIGKILL']) {
    const second = setup(t);
    const oom = fakeApi(second.plan, second.journal, {
      jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'completed', 'failure')],
      logs: { 2: `##[error]Process completed with ${outcome}.\n` },
    });
    const killed = await control(second.plan, second.journal, oom.api);
    assert.equal(killed.exitCode, 137);
    assert.deepEqual(second.journal.oom, [2]);
  }
});

test('gh transport classifies rate-limit stderr without exposing it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-gh-limit-'));
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    join(root, 'gh'),
    `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[1]==='rate_limit'){process.stdout.write(String(Math.floor(Date.now()/1000)+90));process.exit(0)}process.stderr.write(a[1].includes('limited')?'gh: API rate limit already exceeded for user ID 1234. (HTTP 403)':'HTTP 404: secret-ish detail');process.exit(1);\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${previous}`;
  await assert.rejects(actionsApi.request('repos/x/limited'), error => {
    assert.equal(error.code, 'GITHUB_ACTIONS_RATE_LIMITED');
    assert.doesNotMatch(error.message, /1234/);
    return true;
  });
  await assert.rejects(actionsApi.request('repos/x/missing'), error => {
    assert.equal(error.code, 'GITHUB_ACTIONS_API');
    assert.doesNotMatch(error.message, /secret-ish/);
    return true;
  });
  const reset = await actionsApi.rateLimitResetMs();
  assert.ok(reset > 60_000 && reset <= 90_000);
});

test('git transport classifies push failures before truncating redacted diagnostics', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-failure-'));
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const cases = [
    ['! [remote rejected] a -> forge-check/run (failed)', true],
    ['! [remote rejected] a -> forge-check/run (internal server error)', true],
    ['fatal: unable to access synthetic: The requested URL returned error: 502', true],
    ['remote: HTTP 503 Service Unavailable', true],
    ['HTTP/2 500', true],
    ['error: RPC failed; curl 18 transfer closed', true],
    ['fatal: early EOF', true],
    ['Connection reset by peer', true],
    ['fatal: Connection timed out', true],
    ['Operation timed out', true],
    ['remote: rate limit exceeded (HTTP 403)', true],
    ['HTTP 429: Too Many Requests', true],
    ['RPC failed; HTTP 403: secondary rate limit exceeded', true],
    ['RPC failed; The requested URL returned error: 403', false],
    ['HTTP/2 403 Forbidden', false],
    ['RPC failed; HTTP/2 401', false],
    ['RPC failed; HTTP/2 404', false],
    ['remote: Permission denied; rate limit exceeded', false],
    ['fatal: Authentication failed', false],
    ['fatal: could not read Username', false],
    ['remote: Permission to synthetic/checks denied', false],
    ['remote: Write access to repository not granted.', false],
    ['remote: GH006: Protected branch update failed', false],
    ['! [remote rejected] a -> main (failed)\nremote: GH013: Repository rule violations found', false],
    ['! [rejected] main -> main (non-fast-forward)', false],
    ['! [rejected] main -> main (stale info)', false],
    ['remote: Repository not found.', false],
    ['RPC failed; HTTP 401 Authentication failed', false],
    ['an unknown git error', false],
    [`${'padding '.repeat(100)}! [remote rejected] a -> forge-check/run (failed)`, true],
    ['! [remote rejected] a -> run (failed)\nremote: Permission to synthetic/checks denied', false],
  ];
  writeFileSync(
    join(root, 'git'),
    `#!${process.execPath}\nprocess.stderr.write(process.argv.at(-1));process.exit(1);\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${previous}`;
  for (const [detail, transient] of cases) {
    await assert.rejects(syncGit(root, ['push', detail]), error => {
      assert.equal(error.code, 'GITHUB_SYNC_GIT_FAILED');
      assert.equal(error.transient, transient, detail);
      assert.ok(error.detail.length <= 604);
      assert.match(error.message, /Retry to reconcile the retained operation/);
      return true;
    });
  }
});

for (const missing of [false, true])
  test(`a retained replacement stays pending across discovery windows (${missing ? 'missing job' : 'old job'})`, async t => {
    const { plan, journal } = setup(t, [['a'], ['b']]);
    journal.runId = 10;
    let visible = false;
    const { api, calls } = fakeApi(plan, journal, {
      jobs: () => [
        job(1, 'forge-static'),
        job(2, 'forge-shard-0'),
        ...(visible
          ? [job(4, 'forge-shard-1')]
          : missing && journal.retrying.length
            ? []
            : [job(3, 'forge-shard-1', 'completed', 'startup_failure')]),
      ],
    });
    const pending = await control(plan, journal, api);
    assert.equal(pending.status, 'interrupted');
    assert.equal(pending.error.code, 'GITHUB_ACTIONS_PENDING_INFRA');
    assert.equal(journal.terminal, undefined);
    assert.deepEqual(journal.retrySources, { 1: 3 });
    visible = true;
    assert.equal((await control(plan, journal, api)).status, 'passed');
    assert.equal(calls.filter(call => call.endpoint.endsWith('/rerun')).length, 1);
    assert.deepEqual(journal.logged.sort(), [1, 2, 3, 4]);
    assert.equal(calls.filter(call => call.log === 2).length, 1);
    assert.equal(readFileSync(join(plan.output, 'shards/1.log'), 'utf8'), 'ok\n');
    assert.equal(readFileSync(join(plan.output, 'shards/1.attempt-2.log'), 'utf8'), 'ok\n');
  });

test('test failure and likely OOM keep failure evidence while only the lost sibling is replaced', async t => {
  const { plan, journal } = setup(t, [['a'], ['b']]);
  journal.runId = 10;
  const { api, calls } = fakeApi(plan, journal, {
    conclusion: 'failure',
    jobs: poll => [
      job(1, 'forge-static'),
      job(2, 'forge-shard-0', 'completed', 'failure'),
      poll === 1 ? job(3, 'forge-shard-1', 'completed', 'startup_failure') : job(4, 'forge-shard-1'),
    ],
    logs: { 2: 'not ok 1 - source failure\n##[error]Process completed with exit code 137.\n' },
  });
  const result = await control(plan, journal, api);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 137);
  assert.match(result.failureSummary, /exit 137\/SIGKILL \(likely OOM\)/);
  assert.deepEqual(journal.retrySources, { 1: 3 });
  assert.deepEqual(
    calls.filter(call => call.endpoint.endsWith('/rerun')).map(call => call.endpoint),
    ['repos/synthetic/checks/actions/jobs/3/rerun'],
  );
});

test('exit-1 shard summary names failing files without suggesting OOM', async t => {
  const { plan, journal } = setup(t, [['tests/failure.test.mjs', 'tests/green.test.mjs']]);
  journal.runId = 10;
  const { api } = fakeApi(plan, journal, {
    conclusion: 'failure',
    jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'completed', 'failure')],
    logs: {
      2: '# Failed test file: tests/failure.test.mjs\nKilled process 123 in a synthetic test\n##[error]Expected SIGKILL handling assertion failed\n##[error]Process completed with exit code 1.\n',
    },
  });
  const result = await control(plan, journal, api);
  assert.equal(result.exitCode, 1);
  assert.match(result.failureSummary, /failing tests: tests\/failure.test.mjs/);
  assert.doesNotMatch(result.failureSummary, /OOM|SIGKILL|tests\/green/);
});

test('cancelling while a replacement is undiscovered never reopens or reruns it', async t => {
  const { plan, journal } = setup(t);
  journal.runId = 10;
  journal.retrying = [0];
  journal.retrySources = { 0: 2 };
  const { api, calls } = fakeApi(plan, journal, {
    jobs: () => [job(1, 'forge-static'), job(2, 'forge-shard-0', 'completed', 'startup_failure')],
  });
  const result = await controlActions(
    plan,
    journal,
    () => {},
    api,
    () => true,
    () => {},
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error, undefined);
  assert.equal(calls.filter(call => call.endpoint.endsWith('/rerun')).length, 0);
});
