// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { replayDigest } from '../scripts/bench-t3code/replay-schedule.mjs';
import { sustainedVerdict } from '../scripts/bench-t3code/sustained-oracle.mjs';
import { fixtureFiles, releaseSustained, sustainedPlan } from '../scripts/bench-t3code/sustained-plan.mjs';
import { certifyingSustainedCheck, scoreSustained } from '../scripts/bench-t3code/sustained-score.mjs';
import { sustainedWorkflow } from '../scripts/bench-t3code/sustained-workflow.mjs';
import {
  sampleOrg,
  stopSustainedForge,
  watchSustained,
} from '../scripts/bench-t3code/sustained-capacity.mjs';
import { readSustainedPins, seedSustained } from '../scripts/bench-t3code/sustained-setup.mjs';

test('both arms get the same 40 releases with 10 solo reds and six overlapping green candidates', () => {
  const plan = sustainedPlan();
  assert.equal(replayDigest(plan), replayDigest(sustainedPlan()));
  assert.equal(plan.tasks.length, 40);
  assert.equal(plan.tasks.filter(task => task.soloRed).length, 10);
  assert.equal(plan.pairs.flatMap(pair => pair.members).length, 6);
  assert.ok(plan.tasks.every(task => task.releaseAtMs < plan.scoredMs));
  assert.equal(plan.shardCount, 2);
  assert.equal(plan.shardMs, 540_000);
  for (const pair of plan.pairs) {
    const edits = plan.tasks.filter(task => pair.members.includes(task.id)).map(task => task.edits[1]);
    assert.equal(edits[0].path, edits[1].path);
    const merged = fixtureFiles(plan, new Set(pair.members)).get(edits[0].path);
    assert.ok(pair.members.every(id => merged.includes(id + '=on\n')));
  }
});

test('sustained releases are paced and an abort preserves work observed before it', async () => {
  const plan = sustainedPlan({ smoke: true });
  const controller = new AbortController();
  const events = [];
  const startedAtMs = 1_000;
  let time = startedAtMs;
  const pending = [];
  const result = releaseSustained(
    plan,
    {
      prepare: task => task.id,
      submit: (task, prepared) => {
        assert.equal(task.id, prepared);
        return { outcome: 'accepted' };
      },
    },
    {
      now: () => time,
      signal: controller.signal,
      emit: event => events.push(event),
      sleep: wait => new Promise(resolve => pending.push({ wait, resolve })),
    },
  );
  for (let i = 0; i <= plan.tasks.length + 1; i++) await Promise.resolve();
  time += pending[0].wait;
  pending.shift().resolve();
  await Promise.resolve();
  controller.abort();
  pending.forEach(({ resolve }) => resolve());
  const trace = await result;
  assert.equal(trace.startedAtMs, startedAtMs);
  assert.deepEqual(
    events.filter(event => event.event === 'submit').map(event => event.startedAtMs - startedAtMs),
    plan.tasks.slice(0, 2).map(task => task.releaseAtMs),
  );
  assert.equal(
    trace.submissions.filter(entry => entry.outcome === 'not-submitted').length,
    plan.tasks.length - 2,
  );
});

test('main oracle distinguishes green overlaps, planted reds and mutated accepted bytes', () => {
  const plan = sustainedPlan();
  const [pair] = plan.pairs;
  const files = fixtureFiles(plan, new Set(pair.members));
  assert.equal(sustainedVerdict(plan, files).green, true);
  pair.jointRed = true;
  assert.deepEqual(sustainedVerdict(plan, files).jointReds, [pair.id]);
  const redFiles = fixtureFiles(plan, new Set(['s04']));
  assert.deepEqual(sustainedVerdict(plan, redFiles).soloReds, ['s04']);
  const [path] = redFiles.keys();
  redFiles.set(path, 'corrupt');
  assert.deepEqual(sustainedVerdict(plan, redFiles).mismatches, [path]);
});

test('fast-mode s03 joins the one retained passed check pinned to its earlier head', () => {
  const run = (expectedHead, status = 'passed', mode = 'full') => ({
    status,
    request: { expectedHead },
    gate: { mode },
  });
  const runs = new Map([
    ['admission', run('earlier-head')],
    ['failed', run('another-head', 'failed')],
    ['audit', run('published-head', 'passed', 'audit')],
    ['other-pass', run('another-head')],
    ['exact', run('published-head')],
  ]);
  const receipt = {
    head: 'published-head',
    firstCheck: { landedOn: 'admission-run' },
    checkRunIds: ['admission', 'failed', 'audit'],
  };
  assert.equal(certifyingSustainedCheck(receipt, runs), 'admission');
  assert.equal(
    certifyingSustainedCheck({ ...receipt, checkRunIds: ['admission', 'unobserved'] }, runs),
    undefined,
  );
  assert.equal(certifyingSustainedCheck({ ...receipt, moreCheckRunIds: 1 }, runs), undefined);
  assert.equal(certifyingSustainedCheck({ ...receipt, checkRunIdsPartial: true }, runs), undefined);
  receipt.checkRunIds.push('other-pass');
  assert.equal(certifyingSustainedCheck(receipt, runs), undefined);
  receipt.checkRunIds.push('exact');
  assert.equal(certifyingSustainedCheck(receipt, runs), 'exact');
});

test('fast-mode s02 joins the only passed recheck when the earlier attempt was cancelled', () => {
  const receipt = { head: 'published-head', checkRunIds: ['cancelled', 'recheck'], firstCheck: null };
  const runs = new Map([
    ['cancelled', { status: 'cancelled', request: { expectedHead: 'first-head' } }],
    ['recheck', { status: 'passed', request: { expectedHead: 'rechecked-head' } }],
  ]);
  assert.equal(certifyingSustainedCheck(receipt, runs), 'recheck');
  for (const status of ['running', 'unknown']) {
    runs.set('cancelled', { status });
    assert.equal(certifyingSustainedCheck(receipt, runs), undefined);
  }
});

test('scorer uses exact published States and keeps planted reds apart from discarded runner minutes', () => {
  const plan = sustainedPlan({ smoke: true });
  const present = new Set();
  const checks = [];
  const jobs = [];
  const publications = [];
  const submissions = plan.tasks.map(task => {
    const runId = 'check-' + task.id;
    const jobId = 'job-' + task.id;
    const done = task.releaseAtMs + 60_000;
    checks.push({
      id: runId,
      disposition: task.soloRed ? 'expected-red' : 'accepted',
      status: task.soloRed ? 'failed' : 'passed',
      soloRedTasks: task.soloRed ? [task.id] : [],
      finishedAtMs: done,
      jobIds: [jobId],
    });
    jobs.push({ id: jobId, startedAtMs: task.releaseAtMs, endedAtMs: done });
    if (!task.soloRed) {
      present.add(task.id);
      publications.push({
        head: 'state-' + task.id,
        runId,
        atMs: done + 1_000,
        files: Object.fromEntries(fixtureFiles(plan, present)),
      });
    }
    return {
      taskId: task.id,
      startedAtMs: task.releaseAtMs,
      runId,
      outcome: task.soloRed ? 'check-failed' : 'accepted',
    };
  });
  checks.push({ id: 'replaced', disposition: 'discarded', jobIds: ['replaced-job'] });
  jobs.push({ id: 'replaced-job', startedAtMs: 0, endedAtMs: 60_001 });
  const trace = {
    arm: 'dogfood',
    planDigest: replayDigest(plan),
    startedAtMs: 0,
    observedThroughMs: 660_000,
    drained: true,
    publicationsComplete: true,
    submissions,
    checks,
    jobs,
    publications,
    holds: [],
    refusals: ['pair-1'],
  };
  const score = scoreSustained(plan, trace);
  assert.deepEqual(score.missing, []);
  assert.equal(score.expectedReds, 1);
  assert.equal(score.mainReds, 0);
  assert.equal(score.discardedMinutes, 2);
  assert.equal(score.runnerMinutes, 9);
  assert.equal(score.durableGreens, 6);
  assert.equal(score.checkToCommitP90Seconds, 1);
  assert.equal(score.decisions, null);
  const last = publications.at(-1);
  last.files = Object.fromEntries(fixtureFiles(plan, new Set([...present, 's04'])));
  const escaped = scoreSustained(plan, trace);
  assert.equal(escaped.mainReds, 1);
  assert.equal(escaped.falseCertifications, 1);
  assert.equal(escaped.durableGreens, 5);
  checks.find(check => check.id === 'check-s04').soloRedTasks = [];
  assert.equal(scoreSustained(plan, trace).unexpectedReds, 1);
});

test('scratch runner workflow queues all jobs in bounded groups without replacing the control steps', () => {
  const workflow = readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8');
  const commit = '0'.repeat(40);
  const rendered = sustainedWorkflow(workflow, commit);
  assert.equal(rendered.match(/queue: max/g).length, 6);
  assert.equal(rendered.match(/repository: NanthAI\/nanthai-forge/g).length, 4);
  assert.equal(rendered.match(new RegExp(commit, 'g')).length, 4);
  assert.throws(() => sustainedWorkflow(workflow.replace('  hosted-pack:', '  other:'), commit), /layout/);
});

test('bench deployment pin follows the deployed dispatch ref even when the workflow branch is newer', async () => {
  const controlCommit = 'a'.repeat(40);
  const deploymentWorkflowCommit = 'b'.repeat(40);
  const runnerHead = 'c'.repeat(40);
  const control = readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8');
  const workflow = sustainedWorkflow(control, controlCommit);
  const deploy = {
    name: 'Deploy bench Convex',
    displayTitle: 'Deploy bench Convex at ' + controlCommit,
    status: 'completed',
    conclusion: 'success',
    databaseId: 123,
    headSha: deploymentWorkflowCommit,
  };
  const config = { repo: 'NanthAI/forge-sustained-fixture', controlCommit };
  const exec = async (_command, args) => {
    const path = args.at(-1);
    const result =
      args[0] === 'run'
        ? [deploy]
        : path.endsWith('branches/main')
          ? { commit: { sha: runnerHead } }
          : path.endsWith(controlCommit)
            ? { content: Buffer.from(control).toString('base64') }
            : { sha: 'pinned-workflow', content: Buffer.from(workflow).toString('base64') };
    return { stdout: JSON.stringify(result) };
  };
  assert.deepEqual(await readSustainedPins(config, exec), {
    deployRun: 123,
    deploymentWorkflowCommit,
    runnerHead,
    runnerWorkflow: 'pinned-workflow',
  });
  deploy.displayTitle = 'Deploy bench Convex at ' + deploymentWorkflowCommit;
  await assert.rejects(readSustainedPins(config, exec), /Latest bench deployment differs/);
});

test('candidate-side check names a planted red on exactly one shard', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-sustained-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = { ...sustainedPlan({ smoke: true }), shardMs: 0 };
  seedSustained(root, plan);
  const run = index =>
    spawnSync(process.execPath, ['bench-ci/check.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        FORGE_CHECK_PART: 'tests',
        FORGE_CHECK_SHARD_INDEX: String(index),
        FORGE_CHECK_SHARD_TOTAL: '2',
      },
    });
  assert.equal(run(1).status, 0);
  assert.equal(run(2).status, 0);
  mkdirSync(join(root, 'bench-workload/submissions'), { recursive: true });
  writeFileSync(join(root, 'bench-workload/submissions/s04.txt'), 's04=on\n');
  assert.equal(run(1).status, 0);
  const failed = run(2);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^BENCH_SOLO_RED s04$/m);
});

test('org slot sampling reconciles a GitHub count and row race before using the sample', async () => {
  let raced = false;
  const json = value => ({ stdout: JSON.stringify(value) });
  const snapshot = await sampleOrg(async (_command, args) => {
    const path = args.at(-1);
    if (path.includes('orgs/')) return json([[{ full_name: 'NanthAI/scratch' }]]);
    if (path.includes('status=in_progress')) {
      if (!raced) {
        raced = true;
        return json([{ total_count: 1, workflow_runs: [] }]);
      }
      return json([{ total_count: 1, workflow_runs: [{ id: 1 }] }]);
    }
    assert.match(path, /runs\/1\/jobs/);
    return json({ total_count: 2, jobs: [{ status: 'in_progress' }, { status: 'queued' }] });
  });
  assert.equal(snapshot.activeJobs, 1);
});

test('a stale filtered count falls back to current Actions rows', async () => {
  const json = value => ({ stdout: JSON.stringify(value) });
  const snapshot = await sampleOrg(async (_command, args) => {
    const path = args.at(-1);
    if (path.includes('orgs/')) return json([[{ full_name: 'NanthAI/scratch' }]]);
    if (path.includes('status=in_progress')) return json([{ total_count: 2, workflow_runs: [{ id: 1 }] }]);
    if (path.endsWith('/runs?per_page=100'))
      return json({
        workflow_runs: [
          { id: 1, status: 'completed' },
          { id: 2, status: 'in_progress' },
        ],
      });
    assert.match(path, /runs\/2\/jobs/);
    return json({ total_count: 1, jobs: [{ status: 'in_progress' }] });
  });
  assert.equal(snapshot.activeJobs, 1);
});

test('abort waits for preparing work and reuses the cancellation identity until the queue drains', async () => {
  const queues = [
    { total: 0, preparing: 1, entries: [] },
    { total: 1, preparing: 0, entries: [{ submissionId: 'late' }] },
    { total: 1, preparing: 0, entries: [{ submissionId: 'late' }] },
    { total: 0, preparing: 0, entries: [] },
  ];
  const cancelled = [];
  const events = [];
  await stopSustainedForge({
    read: () => queues.shift(),
    cancel: async (submissionId, operationId) => {
      cancelled.push({ submissionId, operationId });
      return { code: cancelled.length === 1 ? null : 0 };
    },
    emit: event => events.push(event),
    sleep: async () => {},
  });
  assert.equal(cancelled.length, 2);
  assert.deepEqual(cancelled[0], cancelled[1]);
  assert.equal(events.at(-1).event, 'forge-drained');
});

test('capacity monitor aborts when a dogfood job exceeded its runner wait before the sample', async () => {
  const atMs = 1_000_000;
  let stopped;
  const json = value => ({ stdout: JSON.stringify(value) });
  await watchSustained({
    repo: 'NanthAI/forge-sustained-fixture',
    priorMinutes: 0,
    signal: new AbortController().signal,
    now: () => atMs,
    abort: reason => {
      stopped = reason;
    },
    emit: () => {},
    exec: async (_command, args) => {
      const path = args.at(-1);
      if (path.includes('/forge-sustained-fixture/')) return json([{ workflow_runs: [] }]);
      if (path.includes('status=in_progress'))
        return json([{ total_count: 1, workflow_runs: [{ id: 1, status: 'in_progress' }] }]);
      if (path.includes('status=queued')) return json([{ total_count: 0, workflow_runs: [] }]);
      return json({
        total_count: 1,
        jobs: [
          {
            status: 'in_progress',
            created_at: new Date(atMs - 601_000).toISOString(),
            started_at: new Date(atMs).toISOString(),
          },
        ],
      });
    },
  });
  assert.match(stopped, /Dogfood check waited more than 10 minutes/);
});
