// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobMetrics } from '../scripts/bench-t3code/github-arm.mjs';
import {
  collectRunners,
  parseRunnerLog,
  runnerCellRule,
  runnerFairness,
} from '../scripts/bench-t3code/runners.mjs';

const job = (jobId, overrides = {}) => ({
  jobId,
  startedAt: `2026-11-03T13:${String(jobId % 60).padStart(2, '0')}:00Z`,
  image: 'ubuntu-26.04',
  imageVersion: '20261021.618',
  runnerVersion: '2.338.2',
  actions: ['actions/checkout@v4@aaaa', 'actions/setup-node@v4@bbbb'],
  ...overrides,
});
const cells = (forge, github) => [
  { arm: 'forge', runner: { jobs: forge } },
  { arm: 'github', runner: { jobs: github } },
];
const compare = (forge, github, mode = 'concurrent') => runnerFairness(cells(forge, github), mode);

test('exact reported endpoint evidence: concurrent mixed pool allowed and disclosed; IDs do not order time', async () => {
  // Synthetic timestamps; IDs and image versions reproduce the reported evidence. These
  // two endpoints do not establish the uncollected historical jobs' version distribution.
  const early = job(125947297463, { startedAt: '2026-11-03T13:30:00Z' });
  const late = job(125957463543, { startedAt: '2026-11-03T14:30:00Z', imageVersion: '20261015.610' });
  const runner = await collectRunners([late, early], async id => [late, early].find(j => j.jobId === id));
  assert.equal(runner.first.jobId, early.jobId);
  assert.equal(runner.last.jobId, late.jobId);
  assert.deepEqual(
    runner.jobs.map(j => j.jobId),
    [early.jobId, late.jobId],
  );
  const result = compare(runner.jobs, [job(3)]);
  assert.deepEqual(result.voided, []);
  assert.equal(result.arms.forge.exclusiveShare, 0.5);
  assert.match(result.flags.join(), /mixed.*asymmetric/s);
});

for (const mode of ['concurrent', 'sequential'])
  test(`${mode}: identical single or mixed sets allowed`, () => {
    assert.deepEqual(compare([job(1)], [job(2)], mode).voided, []);
    const a = [job(1), job(2, { imageVersion: 'old' })];
    const b = [job(3, { imageVersion: 'old' }), job(4), job(5)];
    const result = compare(a, b, mode);
    assert.deepEqual(result.voided, []);
    assert.match(result.flags.join(), /mixed/);
  });

for (const mode of ['concurrent', 'sequential']) {
  test(`${mode}: minority-exclusive rollout versions pass with mixed and asymmetric disclosures`, () => {
    // Synthetic evidence with the recorded N=10 batch's 34/7 job distribution.
    const github = Array.from({ length: 34 }, (_, i) =>
      job(i, {
        imageVersion: i < 29 ? '20261025.179.1' : i < 33 ? '20261101.186.1' : '20261101.64.1',
      }),
    );
    const forge = Array.from({ length: 7 }, (_, i) => job(i, { imageVersion: '20261025.179.1' }));
    for (const [a, b] of [
      [forge, github],
      [github, forge],
    ]) {
      const result = compare(a, b, mode);
      assert.deepEqual(result.voided, []);
      assert.deepEqual(
        [result.arms.forge.exclusiveShare, result.arms.github.exclusiveShare],
        a === forge ? [0, 5 / 34] : [5 / 34, 0],
      );
      assert.match(result.flags.join(), /mixed.*asymmetric/s);
    }
  });

  test(`${mode}: majority exclusive in either arm or disjoint pools void`, () => {
    const majority = [job(1, { imageVersion: 'old' }), job(2, { imageVersion: 'old' }), job(3)];
    assert.match(compare(majority, [job(4)], mode).voided.join(), /forge: exclusive.*50%.*2\/3/);
    assert.match(compare([job(4)], majority, mode).voided.join(), /github: exclusive.*50%.*2\/3/);
    assert.equal(compare([job(1)], [job(2, { imageVersion: 'other' })], mode).voided.length, 2);
    // Sum multiple exclusive versions instead of letting each small bucket evade the rule.
    assert.match(
      compare(
        [job(1), job(2, { imageVersion: 'a' }), job(3, { imageVersion: 'b' })],
        [job(4)],
        mode,
      ).voided.join(),
      /2\/3/,
    );
  });

  test(`${mode}: exactly 50% exclusive in either arm passes with disclosures`, () => {
    const half = [job(1), job(2, { imageVersion: 'old' })];
    for (const [a, b] of [
      [half, [job(3)]],
      [[job(3)], half],
    ]) {
      const result = compare(a, b, mode);
      assert.deepEqual(result.voided, []);
      assert.equal(result.arms[a === half ? 'forge' : 'github'].exclusiveShare, 0.5);
      assert.match(result.flags.join(), /mixed.*asymmetric/s);
    }
  });
}

for (const arm of ['forge', 'github'])
  test(`${arm}: image name, runner major, action SHA drift void in middle jobs too`, () => {
    for (const [change, reason] of [
      [{ image: 'ubuntu-24.04' }, /OS image name/],
      [{ runnerVersion: '3.0.0' }, /runner major/],
      [{ actions: ['actions/checkout@v4@cccc'] }, /action SHA.*checkout/],
      [{ actions: ['actions/checkout@v5@cccc'] }, /action SHA.*checkout/],
    ]) {
      const changed = [job(1), job(2, change), job(3)];
      const result = runnerFairness(
        cells(arm === 'forge' ? changed : [job(4)], arm === 'github' ? changed : [job(4)]),
        'concurrent',
      );
      assert.match(result.voided.join(), reason);
    }
  });

test('runner minor/patch drift, different job action subsets/order and skipped jobs do not void', () => {
  const result = runnerCellRule([
    job(1),
    job(2, { runnerVersion: '2.339.0', actions: ['actions/checkout@v4@aaaa'] }),
    job(3, { actions: ['actions/setup-node@v4@bbbb', 'actions/checkout@v4@aaaa'] }),
    job(4, { conclusion: 'skipped', image: 'other', runnerVersion: '3.0.0', imageVersion: 'other' }),
  ]);
  assert.deepEqual(result.voided, []);
  assert.deepEqual(result.summary.runnerVersions, [
    { value: '2.338.2', jobs: 2 },
    { value: '2.339.0', jobs: 1 },
  ]);
  assert.equal(result.summary.skippedJobs, 1);
});

test('collect every job once, retain skipped/unreadable evidence, and count action jobs once', async () => {
  const calls = [];
  const records = [job(3), job(1), job(4, { conclusion: 'skipped' }), job(2)].map(
    ({ jobId, startedAt, conclusion }) => ({ jobId, startedAt, conclusion }),
  );
  const runner = await collectRunners(records, async id => {
    calls.push(id);
    if (id === 2) throw Error('log unavailable');
    return job(id, { actions: ['actions/checkout@v4@aaaa', 'actions/checkout@v4@aaaa'] });
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(runner.jobs.length, 4);
  assert.equal(runner.jobs.find(j => j.jobId === 2).error, 'log unavailable');
  assert.deepEqual(runner.summary.actions, [{ value: 'actions/checkout@v4@aaaa', jobs: 2 }]);
  assert.equal(runner.jobs.find(j => j.jobId === 2).imageVersion, null);
  assert.equal(runner.summary.missingEvidenceJobs, 1);
  assert.match(runner.flags.join(), /incomplete/);
  const unknown = runnerFairness([{ arm: 'forge', runner: { first: job(1), last: job(2) } }], 'concurrent');
  assert.equal(unknown.arms.forge.fullEvidence, false);
  assert.match(unknown.flags.join(), /unknown/);
});

test('parse all resolved actions beyond the former 20KB sampling cutoff', () => {
  const log =
    "Current runner version: '2.338.2'\nRunner Image Provisioner\nVersion: 2.0.123\nImage: ubuntu-26.04\nVersion: 20261021.618\n" +
    'x'.repeat(21000) +
    "\nDownload action repository 'actions/checkout@v4' (SHA:aaaa)\n";
  assert.deepEqual(parseRunnerLog(log), {
    image: 'ubuntu-26.04',
    imageVersion: '20261021.618',
    runnerVersion: '2.338.2',
    actions: ['actions/checkout@v4@aaaa'],
  });
});

test('job metrics pages every attempt and orders all evidence chronologically without changing billing', async () => {
  const raw = n => ({
    id: n,
    name: 'check',
    started_at: `2026-11-03T13:00:${String(n % 60).padStart(2, '0')}Z`,
    created_at: '2026-11-03T13:00:00Z',
    completed_at: '2026-11-03T13:02:00Z',
    status: 'completed',
    conclusion: 'success',
  });
  const calls = [];
  const metrics = await jobMetrics('test/repo', [{ id: 42, event: 'push', status: 'completed' }], {
    api: async path => {
      calls.push(path);
      return {
        jobs: path.endsWith('page=1')
          ? Array.from({ length: 100 }, (_, i) => raw(i + 1)).reverse()
          : [
              { ...raw(101), conclusion: 'skipped' },
              { ...raw(102), started_at: null, completed_at: null, status: 'queued', conclusion: null },
            ],
      };
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.includes('filter=all')));
  assert.equal(metrics.jobs, 100);
  assert.equal(metrics.jobRecords.length, 102);
  assert.equal(metrics.billedMinutes, 200);
  const starts = metrics.jobRecords.map(j => j.startedAt).filter(Boolean);
  assert.deepEqual(starts, [...starts].sort());
  assert.equal(metrics.firstJob, metrics.jobIds[0]);
  assert.equal(metrics.jobRecords.at(-1).startedAt, null);
  const executed = metrics.jobRecords.filter(j => j.conclusion !== 'skipped' && j.startedAt);
  assert.equal(metrics.lastJob, executed.at(-1).jobId);
});

test('summarize exposes per-arm distinct sets/counts and batch disclosure, including legacy missing coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-runner-summary-'));
  try {
    mkdirSync(join(root, 'runs'));
    mkdirSync(join(root, 'batches', 'pair'), { recursive: true });
    for (const [arm, jobs] of [
      ['forge', [job(1), job(2, { imageVersion: 'old' })]],
      ['github', [job(3)]],
    ]) {
      mkdirSync(join(root, 'runs', `${arm}-n5-r1-a1-test`));
      writeFileSync(
        join(root, 'runs', `${arm}-n5-r1-a1-test`, 'result.json'),
        JSON.stringify({ arm, cellId: arm, runner: { jobs } }),
      );
    }
    writeFileSync(
      join(root, 'batches', 'pair', 'batch.json'),
      JSON.stringify({
        batchId: 'pair',
        mode: 'concurrent',
        voided: [],
        cells: [
          { cellId: 'forge', arm: 'forge' },
          { cellId: 'github', arm: 'github' },
        ],
      }),
    );
    const output = JSON.parse(
      execFileSync(process.execPath, ['scripts/bench-t3code/summarize.mjs'], {
        env: { ...process.env, BENCH_ROOT: root },
        encoding: 'utf8',
      }),
    );
    assert.deepEqual(output.runnersByArm.forge.imageVersions, [
      { value: '20261021.618', jobs: 1 },
      { value: 'old', jobs: 1 },
    ]);
    assert.equal(output.runnersByArm.github.actions[0].jobs, 1);
    assert.match(output.runnerDisclosures[0].flags.join(), /mixed/);
    assert.deepEqual(output.runnerDisclosures[0].voided, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real-scale synthetic evidence uses exactly one log read per job at 600 and 1200 jobs', async () => {
  for (const size of [600, 1200]) {
    let calls = 0;
    const records = Array.from({ length: size }, (_, i) => ({ jobId: i, startedAt: '2026-11-03T13:00:00Z' }));
    const result = await collectRunners(records, async id => {
      calls++;
      return job(id);
    });
    assert.equal(calls, size);
    assert.equal(result.jobs.length, size);
    assert.equal(result.summary.images[0].jobs, size);
    assert.deepEqual(result.voided, []);
  }
});

test('queued jobs do not dilute exclusive shares and incomplete logs cannot borrow later Version lines', () => {
  const queued = job(4, {
    startedAt: null,
    image: null,
    imageVersion: null,
    runnerVersion: null,
    actions: null,
  });
  const result = compare(
    [job(1, { imageVersion: 'old' }), job(2, { imageVersion: 'old' }), job(3), queued],
    [job(5)],
  );
  assert.equal(result.arms.forge.runnerJobs, 3);
  assert.equal(result.arms.forge.unstartedJobs, 1);
  assert.equal(result.arms.forge.missingEvidenceJobs, 1);
  assert.match(result.voided.join(), /2\/3/);
  assert.equal(
    parseRunnerLog('Image: ubuntu-26.04\nIncluded Software: https://example.invalid\nVersion: unrelated')
      .imageVersion,
    null,
  );
});

test('chronological endpoints use timestamps even when job IDs increase in the opposite order', async () => {
  const early = job(900, { startedAt: '2026-11-03T13:00:00Z' });
  const late = job(100, { startedAt: '2026-11-03T14:00:00Z' });
  const runner = await collectRunners([late, early], async id => ({ jobId: id, imageVersion: 'same' }));
  assert.equal(runner.first.jobId, 900);
  assert.equal(runner.last.jobId, 100);
});
