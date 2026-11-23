// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue a217b83e: name the landing that adds check time. A slow new test file adds seconds to every later
// check. A whole run's per-file timings are judged against the planner's timing history after removing the
// run's own hardware speed; only the change's new test files are named, net of test files it deletes or
// renames, above three standard deviations of timing noise. It never blocks. Edited files are never named
// (review F2: with 30 or 100 edited files some are always the run's random outliers). A whole-check shift
// (coverage on every shard, removed by d5de1c98) is not blamed on whichever landing's check first saw it:
// the hosted executor runs from main's control checkout, so that shift appears only after the change lands
// (replay on Item a217b83e).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { attributeCheckTime, checkTimeEvidence } from '../dist/check-time-added.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { moduleUrl } from './convex-module.mjs';
import { classifyCheckPath } from '../scripts/check-path-scopes.mjs';
const { recordHostedTestTimings } = await import(moduleUrl('../convex/projectHostedTestTimings.ts'));

const env = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Forge's own check recipe (src/standard-check.ts): the only one whose selector sends deletions to a full run. */
const forgeCheck = {
  name: 'forge',
  executable: 'node',
  args: ['scripts/forge-check.mjs'],
  environmentLabel: 'clean',
};
/** Deterministic noise in [-1, 1]. */
const jitter = i => Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 78.233) * 0.5;
/** 300 synthetic established test files of 1 to 120 s, as the history's EWMA milliseconds. */
const ms = Object.fromEntries(
  Array.from({ length: 300 }, (_, i) => [`tests/f${i}.test.mjs`, 1000 + ((i * 7919) % 120_000)]),
);
const at = (i = 0) => new Date(Date.UTC(2026, 10, 19, 0, 0, i)).toISOString();
const history = (extra = {}) => ({
  ...Object.fromEntries(
    Object.entries(ms).map(([file, d], i) => [file, { durationMs: d, updatedAt: at(i % 50) }]),
  ),
  ...extra,
});
const prior = history();
/** One whole run: every file at `speed` x its history with about +-8% noise, plus `extra` files. */
const run = (speed, seed, extra = {}, scale = () => 1, drop = []) => ({
  ...Object.fromEntries(
    Object.entries(ms)
      .filter(([file]) => !drop.includes(file))
      .map(([file, d], i) => [file, d * speed * scale(file, i) * (1 + 0.08 * jitter(i + seed))]),
  ),
  ...extra,
});

test('a slow new test file is named with the seconds it adds to every check, on any runner speed', () => {
  for (const [speed, paths] of [
    [1, ['src/feature.ts', 'tests/new-slow.test.mjs']],
    [1.08, ['src/feature.ts', 'tests/new-slow.test.mjs']],
    [1.4, ['tests/new-slow.test.mjs']],
  ]) {
    const sample = checkTimeEvidence(prior, run(speed, 1, { 'tests/new-slow.test.mjs': 90_000 * speed }));
    const time = attributeCheckTime(sample, paths);
    assert(time, `named on a ${speed}x runner`);
    assert(
      Math.abs(time.seconds - 90) <= 3,
      `about 90 s after removing the runner speed, got ${time.seconds}`,
    );
    assert.deepEqual(time.tests, [['tests/new-slow.test.mjs', time.seconds]]);
  }
});

test('a docs-only change is never flagged, even when its check ran on slow runners or beside a new file', () => {
  for (const speed of [1, 0.6, 1.9]) {
    const sample = checkTimeEvidence(prior, run(speed, 2, { 'tests/new-slow.test.mjs': 90_000 }));
    assert.equal(attributeCheckTime(sample, ['docs/agents/speed-budgets.md', 'README.md']), null);
  }
});

test('noise is not named: an ordinary code change on a normal run, and a small new test file', () => {
  const sample = checkTimeEvidence(prior, run(1.02, 3, { 'tests/tiny.test.mjs': 400 }));
  assert.equal(attributeCheckTime(sample, ['src/feature.ts']), null);
  assert.equal(attributeCheckTime(sample, ['src/feature.ts', 'tests/tiny.test.mjs']), null);
});

test('F2: edited test files are never named: 0 of 200 seeded runs for 30 and for 100 edited files, with a contention tail', () => {
  // Lognormal-ish 10% per-file noise plus a 2% contention tail (1.5x to 3x on a run): the review's model.
  const tail = (file, i, seed) => {
    const u = (jitter(i * 7 + seed * 131) + 1) / 2;
    return u > 0.98 ? 1.5 + 1.5 * ((jitter(i + seed) + 1) / 2) : Math.exp(0.1 * jitter(i * 3 + seed * 17));
  };
  for (const edited of [30, 100]) {
    let named = 0;
    for (let seed = 0; seed < 200; seed++) {
      const paths = Object.keys(ms).slice(seed % 150, (seed % 150) + edited);
      const sample = checkTimeEvidence(
        prior,
        run(1, seed, {}, (file, i) => tail(file, i, seed)),
      );
      if (attributeCheckTime(sample, [...paths, 'src/feature.ts'])) named++;
    }
    assert.equal(named, 0, `${edited} edited files named ${named} of 200 times`);
  }
  // Even a real slowdown of an edited file is not named: per-file change is the successor's work.
  const slowed = checkTimeEvidence(
    prior,
    run(1, 6, {}, file => (file === 'tests/f7.test.mjs' ? 3 : 1)),
  );
  assert.equal(attributeCheckTime(slowed, ['tests/f7.test.mjs']), null);
});

test('incident d5de1c98: a whole-check slowdown or speedup is never blamed on the landing whose check saw it', () => {
  for (const speed of [1.9, 1 / 1.6]) {
    const sample = checkTimeEvidence(prior, run(speed, 4));
    assert.equal(attributeCheckTime(sample, ['scripts/test-files.mjs', 'src/feature.ts']), null);
  }
});

test('F3: a renamed or split test file subtracts its old path; a split that adds time names the net', () => {
  const old = 'tests/f7.test.mjs',
    base = ms[old];
  // Rename: the old path is gone, the new path runs as long.
  const renamed = checkTimeEvidence(
    prior,
    run(1, 8, { 'tests/renamed.test.mjs': base }, () => 1, [old]),
  );
  assert.equal(attributeCheckTime(renamed, [old, 'tests/renamed.test.mjs']), null);
  // Split in two, same total time.
  const split = checkTimeEvidence(
    prior,
    run(1, 9, { 'tests/part-a.test.mjs': base / 2, 'tests/part-b.test.mjs': base / 2 }, () => 1, [old]),
  );
  assert.equal(attributeCheckTime(split, [old, 'tests/part-a.test.mjs', 'tests/part-b.test.mjs']), null);
  // Split that doubles the time: named at the net seconds, with the old path's time subtracted.
  const heavier = checkTimeEvidence(
    prior,
    run(1, 10, { 'tests/part-a.test.mjs': base + 60_000, 'tests/part-b.test.mjs': base }, () => 1, [old]),
  );
  const time = attributeCheckTime(heavier, [old, 'tests/part-a.test.mjs', 'tests/part-b.test.mjs']);
  assert(time && Math.abs(time.seconds - (base / 1000 + 60)) <= 6, `net, got ${time?.seconds}`);
  // A change that only deletes a test file is not named.
  const deleted = checkTimeEvidence(
    prior,
    run(1, 11, {}, () => 1, [old]),
  );
  assert.equal(attributeCheckTime(deleted, [old]), null);
  const line = landSummary({
    result: {
      submission: {
        phase: 'landed',
        acceptance: { receiptId: randomUUID(), head: 'a'.repeat(64), checkTime: time },
      },
    },
  }).join('\n');
  assert.match(
    line,
    /CHECK TIME: this landing adds about \d+ runner seconds to every check \(tests\/part-a.test.mjs \+\d+ s/,
  );
  assert.match(line, /It does not block/);
});

test("F4: a new file the history learned from the change's own earlier attempts still counts as new", () => {
  const file = 'tests/new-slow.test.mjs';
  for (const n of [1, 2, 3]) {
    const learned = history({ [file]: { durationMs: 90_000, updatedAt: at(60), n } });
    const time = attributeCheckTime(checkTimeEvidence(learned, run(1, 12, { [file]: 90_000 })), [file]);
    assert(time && Math.abs(time.seconds - 90) <= 3, `young after ${n} runs, got ${time?.seconds}`);
  }
  const established = history({ [file]: { durationMs: 90_000, updatedAt: at(60) } });
  assert.equal(
    attributeCheckTime(checkTimeEvidence(established, run(1, 12, { [file]: 90_000 })), [file]),
    null,
  );
});

test('without enough history a run names nothing; malformed records never fail acceptance', () => {
  assert.equal(checkTimeEvidence({}, run(1, 7)), null);
  assert.equal(attributeCheckTime({ factor: 'x' }, ['tests/f1.test.mjs']), null);
  assert.equal(attributeCheckTime(undefined, ['tests/f1.test.mjs']), null);
});

test('the result transaction stamps whole runs once from the history it already reads; retries keep the file new; scoped runs get none', async () => {
  const s = lanesFixture(),
    projectId = s.insert('hostedProjects', {
      owner: 'synthetic',
      key: randomUUID(),
      name: 'Synthetic check time',
      currentBackup: null,
      revision: 0,
    });
  const result = (durations, i, extra = {}) => ({
    id: randomUUID(),
    status: 'passed',
    endedAt: `2026-11-19T00:${String(i).padStart(2, '0')}:00Z`,
    contractReports: Object.fromEntries(
      Object.entries(durations).map(([file, d]) => [file, { durationMs: d }]),
    ),
    ...extra,
  });
  const record = r =>
    s.transaction('record', { _handler: ctx => recordHostedTestTimings(ctx, projectId, r) }, {});
  for (let i = 0; i < 12; i++) await record(result(run(1, 10 + i), i));
  const file = 'tests/new-slow.test.mjs';
  // Two failed or discarded attempts of the same change already fed the history.
  for (const i of [20, 21]) await record({ ...result(run(1, i, { [file]: 90_000 }), i), status: 'failed' });
  const accepted = result(run(1, 30, { [file]: 90_000 }), 40);
  await record(accepted);
  assert(accepted.checkTime, 'the run carries its evidence for acceptance');
  const time = attributeCheckTime(accepted.checkTime, [file]);
  assert(time && Math.abs(time.seconds - 90) <= 5, `named after two earlier attempts, got ${time?.seconds}`);
  delete accepted.checkTime;
  await record(accepted);
  assert.equal(accepted.checkTime, undefined, 'a replayed result is not judged twice');
  const scoped = result(run(1, 31, { 'tests/other.test.mjs': 90_000 }), 41, {
    plan: { scoped: { reason: 'shared impact', tests: 40 } },
  });
  await record(scoped);
  assert.equal(scoped.checkTime, undefined, 'a scoped recheck cannot see deletions: no evidence');
});

test('contract-selected runs name new test files too (22 of 60 replayed landings were blind); no unselected file reads as deleted', async () => {
  // A contract run skips about 200 files on purpose. Judged as a whole run, its 12 "gone" slots would fill
  // with files it only did not select; selected evidence records new files only.
  const skipped = Object.keys(ms).slice(100);
  const selectedRun = run(1, 50, { 'tests/new-slow.test.mjs': 90_000 }, () => 1, skipped);
  const asWhole = checkTimeEvidence(prior, selectedRun);
  assert.equal(
    asWhole.files.filter(([, , base]) => base !== null).length,
    12,
    'unselected files read as gone',
  );
  const selected = checkTimeEvidence(prior, selectedRun, false);
  assert(selected && selected.files.every(([, , base]) => base === null), 'no gone files on a selected run');
  const time = attributeCheckTime(selected, ['src/x.ts', 'tests/new-slow.test.mjs']);
  assert(time && Math.abs(time.seconds - 90) <= 5, `named, got ${time?.seconds}`);
  // Why no deleted file needs netting there: the selector sends a change that deletes or renames a path
  // to a full run (an unknown or deleted path selects everything), so it never lands on a contract run.
  const files = new Map([
    ['tests/kept.test.mjs', ''],
    ['src/a.ts', ''],
  ]);
  assert.equal(
    classifyCheckPath('tests/gone.test.mjs', files),
    null,
    'a deleted test path selects the full run',
  );
  assert.notEqual(classifyCheckPath('tests/kept.test.mjs', files), null);

  // The result transaction stamps a contract run, and still never a main-race scoped recheck.
  const s = lanesFixture(),
    projectId = s.insert('hostedProjects', {
      owner: 'synthetic',
      key: randomUUID(),
      name: 'Synthetic selected check time',
      currentBackup: null,
      revision: 0,
    });
  const result = (durations, i, extra = {}) => ({
    id: randomUUID(),
    status: 'passed',
    endedAt: `2026-11-19T01:${String(i).padStart(2, '0')}:00Z`,
    contractReports: Object.fromEntries(
      Object.entries(durations).map(([file, d]) => [file, { durationMs: d }]),
    ),
    ...extra,
  });
  const record = r =>
    s.transaction('record', { _handler: ctx => recordHostedTestTimings(ctx, projectId, r) }, {});
  for (let i = 0; i < 6; i++) await record(result(run(1, 60 + i), i));
  const contract = {
    mode: 'contract',
    tests: ['tests/f1.test.mjs'],
    contractVersion: 1,
    effective: 'contract',
  };
  const accepted = result(selectedRun, 10, { gate: contract, check: forgeCheck });
  await record(accepted);
  assert(accepted.checkTime, 'a contract-selected run carries evidence');
  assert(accepted.checkTime.files.every(([, , base]) => base === null));
  assert(attributeCheckTime(accepted.checkTime, ['tests/new-slow.test.mjs']));
  const recheck = result(
    run(1, 70, { 'tests/other.test.mjs': 90_000 }, () => 1, skipped),
    11,
    {
      gate: { mode: 'scoped', reason: `scoped-recheck:${'a'.repeat(64)}`, effective: 'contract' },
    },
  );
  await record(recheck);
  assert.equal(recheck.checkTime, undefined, 'a scoped recheck selects by shared impact: no evidence');
  const docs = result(
    run(1, 71, {}, () => 1, skipped),
    12,
    { gate: { mode: 'contract', effective: 'docs' } },
  );
  await record(docs);
  assert.equal(docs.checkTime, undefined, 'a docs run is never judged');
});

test("review d2d1a7e8: a BYO CI changed-paths command's contract run never reads a renamed 60 s test as added", async () => {
  // Only Forge's own recipe sends a deleted or renamed path to a full run. A configured command that declares
  // `selection: changed-paths` scopes its contract gate without that rule, so its renamed file looks new while
  // the old path, merely unselected, is never netted out.
  const old = 'tests/a_test.py',
    renamed = 'tests/b_test.py',
    paths = [old, renamed];
  const skipped = Object.keys(ms).slice(100);
  const durations = run(1, 80, { [renamed]: 60_000 }, () => 1, skipped);
  const history60 = history({ [old]: { durationMs: 60_000, updatedAt: at(1) } });
  // The trap the guard closes: judged as a selected run, the rename reads as about 60 s added.
  const trap = attributeCheckTime(checkTimeEvidence(history60, durations, false), paths);
  assert(trap && Math.abs(trap.seconds - 60) <= 5, `the rename reads as added, got ${trap?.seconds}`);

  const s = lanesFixture(),
    projectId = s.insert('hostedProjects', {
      owner: 'synthetic',
      key: randomUUID(),
      name: 'Synthetic configured check time',
      currentBackup: null,
      revision: 0,
    });
  const result = (durations, i, extra = {}) => ({
    id: randomUUID(),
    status: 'passed',
    endedAt: `2026-11-19T02:${String(i).padStart(2, '0')}:00Z`,
    contractReports: Object.fromEntries(
      Object.entries(durations).map(([file, d]) => [file, { durationMs: d }]),
    ),
    ...extra,
  });
  const record = r =>
    s.transaction('record', { _handler: ctx => recordHostedTestTimings(ctx, projectId, r) }, {});
  const byoci = {
    name: 'ci',
    executable: 'bash',
    args: ['ci/check.sh'],
    environmentLabel: 'clean',
    selection: { scope: 'changed-paths' },
  };
  for (let i = 0; i < 6; i++) await record(result(run(1, 90 + i, { [old]: 60_000 }), i, { check: byoci }));
  const gate = { mode: 'contract', tests: [renamed], contractVersion: 1, effective: 'contract' };
  const configured = result(durations, 10, { gate, check: byoci });
  await record(configured);
  assert.equal(configured.checkTime, undefined, "a configured command's selected run carries no evidence");
  assert.equal(attributeCheckTime(configured.checkTime, paths), null, 'its receipt never says "adds 60 s"');
  // Its whole runs still name new files: the selection rule matters only when files are skipped.
  const whole = result(run(1, 99, { [old]: 60_000, 'tests/c_test.py': 90_000 }), 11, { check: byoci });
  await record(whole);
  assert(attributeCheckTime(whole.checkTime, ['tests/c_test.py']), 'a whole BYO CI run is judged as before');
});

test('review d2d1a7e8: a selected run needs more established files before it judges, and nothing reads "adds 0 s"', () => {
  // A selected run's matched files are mostly the change's own impacted tests: too few say nothing.
  const files = Object.keys(ms).slice(0, 12);
  const few = Object.fromEntries(files.map(file => [file, ms[file]]));
  const withNew = { ...few, 'tests/new-slow.test.mjs': 90_000 };
  assert(checkTimeEvidence(prior, withNew, true), 'a whole run may judge on 12 established files');
  assert.equal(checkTimeEvidence(prior, withNew, false), null, 'a selected run on 12 files says nothing');
  const enough = Object.fromEntries(
    Object.keys(ms)
      .slice(0, 40)
      .map(file => [file, ms[file]]),
  );
  const time = attributeCheckTime(
    checkTimeEvidence(prior, { ...enough, 'tests/new-slow.test.mjs': 90_000 }, false),
    ['tests/new-slow.test.mjs'],
  );
  assert(time && Math.abs(time.seconds - 90) <= 5, `40 files are enough, got ${time?.seconds}`);
  // Exact timings make the spread 0, so the noise floor is 0: a 0.3 s new file would round to "adds 0 s".
  const tiny = checkTimeEvidence(prior, { ...enough, 'tests/new-tiny.test.mjs': 300 }, false);
  assert.equal(tiny.spread, 0);
  assert.equal(attributeCheckTime(tiny, ['tests/new-tiny.test.mjs']), null, 'never "adds 0 s"');
  const split = {
    factor: 0,
    spread: 0,
    typical: 30,
    files: [
      ['tests/new-tiny.test.mjs', 0.7, null],
      ['tests/old-tiny.test.mjs', -0.3, 0.3],
    ],
  };
  assert.equal(
    attributeCheckTime(split, ['tests/old-tiny.test.mjs', 'tests/new-tiny.test.mjs']),
    null,
    'a net under half a second is not named either',
  );
});

/** A runner whose whole run times the change's new test file: the evidence the timing write stamps. */
function stampEvidence(f, evidence) {
  f.rawChecks.pass = async r => {
    for (let i = 0; i < r.plan.shardCount; i++) await f.rawChecks.callback(f.rawChecks.shard(r, i, 'passed'));
    for (const [id, row] of f.tables.projectHostedCheckRuns) {
      const value = JSON.parse(row.value);
      if (value.id === r.id)
        f.patch('projectHostedCheckRuns', id, { value: JSON.stringify({ ...value, checkTime: evidence }) });
    }
    return f.rawChecks.callback(f.rawChecks.complete(r));
  };
}
const evidence = checkTimeEvidence(prior, run(1, 13, { 'tests/new-slow.test.mjs': 90_000 }));

test('F8c: acceptance writes checkTime to the receipt and the landing state; a batch puts it on its last receipt', async t => {
  const f = await finishFixture(t, { selectedFiles: [['tests/new-slow.test.mjs', 'synthetic\n']] });
  const policy = policyPreset('trusted');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policy,
      acceptance: { ...policy.acceptance, admissionCheck: false },
      agentDefaults: { stallAlerts: { enabled: false }, preflight: 'advise' },
    },
  });
  stampEvidence(f, evidence);
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const landed = (await f.current(state.id)).submission;
  assert.equal(landed.phase, 'landed');
  const [receipt] = [...f.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value));
  assert(receipt.checkTime && Math.abs(receipt.checkTime.seconds - 90) <= 3);
  assert.deepEqual(landed.acceptance.checkTime, receipt.checkTime);

  const b = await batchesFixture(t, {
    memberPaths: ['tests/new-slow.test.mjs', 'member-1', 'member-2', 'member-3'],
  });
  stampEvidence(b, evidence);
  await b.drain();
  await b.passChecks();
  await b.drain();
  const receipts = [...b.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value));
  assert.equal(receipts.length, 4);
  const marked = receipts.filter(r => r.checkTime);
  assert.equal(marked.length, 1, 'one receipt carries the stacked change');
  assert.equal(marked[0].checkTime.batch, true);
  // Batch members carry a share of the run, never a whole full check (F8a).
  for (const member of states(b).filter(s => s.phase === 'landed'))
    assert.equal(member.counts?.runnerFull, undefined);
});
