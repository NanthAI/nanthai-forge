// SPDX-License-Identifier: Apache-2.0
// Item 687d1eda fix D: park, don't fail (switch FORGE_QUEUE_PARK_ON_MAIN_RED, off by default).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const mainAudit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
const park = await import(moduleUrl('../convex/projectHostedLandingPark.ts'));
const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const laneFinish = await import(moduleUrl('../convex/projectHostedLaneFinish.ts'));
const landingApi = await import(moduleUrl('../convex/projectHostedLanding.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const admissionWake = await import(moduleUrl('../convex/projectHostedLandingAdmissionWake.ts'));
const auditState = await import(moduleUrl('../convex/projectHostedMainAuditState.ts'));
const redrive = await import(moduleUrl('../convex/projectHostedLandingRedrive.ts'));
const gate = await import(moduleUrl('../convex/projectHostedGate.ts'));
const landingsRead = await import(moduleUrl('../convex/projectHostedLandings.ts'));
const laneHistory = await import(moduleUrl('../convex/projectHostedLaneHistory.ts'));
import { controllerMetadataFits } from './observer-projection-budget.mjs';
const SWITCH = 'FORGE_QUEUE_PARK_ON_MAIN_RED';
const prior = Object.fromEntries([...Object.keys(synthetic), SWITCH].map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.afterEach(() => delete process.env[SWITCH]);
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const RED = 'tests/main-red.test.mjs';
const RED2 = 'tests/main-red-2.test.mjs';
const at = '2026-11-19T12:00:00.000Z';

async function redMain(t, { tests = [RED], moreTests, count = 1 } = {}) {
  const f = await batchesFixture(t, { admissionCheck: true, batchMaxSize: null, count });
  f.setRed = red =>
    f.patch('projectHostedMainAudits', f.auditId, {
      red: red && { since: at, head: f.currentMain().head, runId: 'red-audit', tests, ...red },
    });
  const row = [...f.tables.projectHostedMainAudits.values()].find(r => r.projectId === f.projectId);
  f.auditId = row?._id ?? f.insert('projectHostedMainAudits', { projectId: f.projectId });
  f.setRed(moreTests ? { moreTests } : {});
  f.rows = () => [...f.tables.projectHostedLandingRequests.values()].filter(r => r.projectId === f.projectId);
  f.landingRow = () => f.rows()[0];
  f.green = async () => {
    f.setRed(undefined);
    await f.transaction('release', mainAudit.releaseHeld, { projectId: f.projectId });
    await f.drain();
  };
  return f;
}
/** A finished admission run that failed on `files`: test shard 0 failed, the static job (the
 * plan's last shard) reported `staticStatus`, then the run completed with `status`. */
async function failRun(
  f,
  runId,
  files = [RED],
  {
    staticStatus = 'passed',
    status = 'failed',
    firstError = file => `${file}: synthetic failure`,
    shards,
  } = {},
) {
  const run = await f.rawChecks.activate(runId);
  for (const [index, shardStatus] of shards ?? [
    [0, 'failed'],
    [1, staticStatus],
  ])
    await f.rawChecks.callback(f.rawChecks.shard(run, index, shardStatus));
  await f.rawChecks.callback(
    f.rawChecks.complete(run, status, {
      contractReports: Object.fromEntries(
        files.map(file => [file, { failed: true, durationMs: 1, firstError: firstError(file) }]),
      ),
    }),
  );
}
async function parkAll(f, files = [RED], chunk = Infinity) {
  // The fixture's drain has a tick budget: many entries park in chunks.
  for (
    let queued;
    (queued = f
      .runs()
      .filter(r => r.status === 'queued')
      .slice(0, chunk)).length;
  ) {
    for (const run of queued) await failRun(f, run.id, files);
    await f.drain();
  }
}
async function passQueued(f) {
  for (let round = 0; round < 20 && f.runs().some(r => r.status === 'queued'); round++) {
    for (const run of f.runs().filter(r => r.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.drain();
  }
}
const STALL_MS = 15 * 60_000;
const task = (f, id) => f.tables._scheduled_functions.get(id);
const pendingTasks = (f, name) =>
  [...f.tables._scheduled_functions.values()].filter(t => t.name === name && t.state.kind === 'pending');
/** Runs scheduled release pages (projectHostedMainAudit:releaseHeld) as the scheduler would. */
async function runReleases(f, name = 'releasePage') {
  for (let round = 0; round < 20; round++) {
    const due = pendingTasks(f, 'projectHostedMainAudit:releaseHeld');
    if (!due.length) return round;
    for (const t of due) {
      f.patch('_scheduled_functions', t._id, { state: { kind: 'success' } });
      await f.transaction(name, mainAudit.releaseHeld, t.args[0]);
    }
  }
  assert.fail('release pages did not finish');
}
/** A parked row turned into a publication hold (phase ready): the same hold, the other writer. */
function asPublicationHold(f, row) {
  const value = { ...JSON.parse(row.value), phase: 'ready' };
  f.patch('projectHostedLandingRequests', row._id, { phase: 'ready', value: JSON.stringify(value) });
}
const observationVersions = (f, submissionId) =>
  [...f.tables.projectHostedLandingObservations.values()]
    .filter(r => r.submissionId === submissionId)
    .map(r => r.version);

test('incident 687d1eda D: a landing failing only on main red tests parks, then re-lands once main is green', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  const parked = states(f)[0];
  assert.equal(parked.phase, 'queued', 'not terminal-failed: the change is not at fault');
  assert.equal(parked.error.code, 'MAIN_RED');
  assert.match(parked.error.message, /failed only on tests main fails too \(tests\/main-red\.test\.mjs\)/);
  const row = f.landingRow();
  assert.equal(row.hold, 'main-red');
  assert.equal(row.runnable, false);
  assert.equal(row.alarm ?? null, null, 'an event wait holds no stall alarm');
  assert.equal(row.batchable, false, 'a parked entry holds no cohort window place');
  assert.equal(f.runs().length, 1, 'no new check runs while main is red');
  // Main turns green: the audit reducer releases held landings.
  await f.green();
  assert.equal(f.landingRow().hold, undefined);
  await passQueued(f);
  assert.equal(states(f)[0].phase, 'landed', 'the parked landing re-lands on green');
  assert(f.runs().length >= 2, 'its check ran again on green main');
});

test('incident 687d1eda hold record: a parked landing leaves held, released and its re-landing receipt in landings and lane-history', async t => {
  // Analyst 2026-11-20: four reds since switch-on left no hold to read after the fact.
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  const held = f.landingRow().mainRedHolds;
  assert.equal(held?.length, 1, 'parking records the hold on the row it already writes');
  assert.equal(held[0].kind, 'parked');
  assert.ok(Date.parse(held[0].heldAt));
  assert.equal(held[0].releasedAt, undefined);
  await f.green();
  const released = f.landingRow().mainRedHolds;
  assert.equal(released.length, 1, 'release closes the same hold');
  assert.ok(Date.parse(released[0].releasedAt) >= Date.parse(released[0].heldAt));
  await passQueued(f);
  assert.equal(states(f)[0].phase, 'landed');
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(r => r.projectId === f.projectId).value,
  );
  assert.deepEqual(receipt.mainRedHolds, released, 'the receipt carries the record');
  const { landings } = JSON.parse(
    await f.transaction('landingsRead', landingsRead.read, { projectId: f.projectId, receiptId: receipt.id }),
  );
  assert.deepEqual(landings[0].mainRedHolds, released, 'landings shows held and released');
  assert.equal(landings[0].receiptId, receipt.id, 'on the re-landing receipt');
  assert.ok(Date.parse(landings[0].committedAt) >= Date.parse(released[0].releasedAt));
  const history = JSON.parse(
    await f.transaction('laneHistory', laneHistory.read, {
      projectId: f.projectId,
      laneId: f.entries[0].lane.laneId,
    }),
  );
  assert.equal(history.landing?.receiptId, receipt.id, 'lane-history names the re-landing');
  assert.deepEqual(history.landing.mainRedHolds, released, 'lane-history shows held and released');
});

test('687d1eda hold record: a landing never held carries no mainRedHolds anywhere', async t => {
  const f = await redMain(t);
  f.setRed(undefined);
  await passQueued(f);
  assert.equal(states(f)[0].phase, 'landed');
  assert.equal(f.landingRow().mainRedHolds, undefined);
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(r => r.projectId === f.projectId).value,
  );
  assert.equal('mainRedHolds' in receipt, false);
  const { landings } = JSON.parse(
    await f.transaction('landingsRead', landingsRead.read, { projectId: f.projectId, receiptId: receipt.id }),
  );
  assert.equal(landings[0].mainRedHolds, null);
});

test('687d1eda D review 1: parking writes one observation per version; observe pages across park and release', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  const { id: submissionId, operationId, version } = states(f)[0];
  const read = nextVersion =>
    f
      .transaction('parkObserve', observe.page, { projectId: f.projectId, operationId, nextVersion })
      .then(JSON.parse);
  const versions = observationVersions(f, submissionId);
  assert.equal(new Set(versions).size, versions.length, `one observation per version: ${versions}`);
  const page = await read(version);
  assert.equal(page.submission.error.code, 'MAIN_RED');
  await f.green();
  await passQueued(f);
  const all = observationVersions(f, submissionId);
  assert.equal(new Set(all).size, all.length, `one observation per version after release: ${all}`);
  const after = await read(version);
  assert(after.submission, 'observe still pages from the parked version after landing');
  assert.equal(states(f)[0].phase, 'landed');
});

test('687d1eda D review 8: release re-arms the stall alarm; parking schedules no queue driver wake', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  const drives = () =>
    [...f.tables._scheduled_functions.values()].filter(
      task => task.name === 'projectHostedLandingDriver:drive',
    ).length;
  await failRun(f, f.runs()[0].id);
  const before = drives();
  await f.drain();
  assert.equal(f.landingRow().hold, 'main-red');
  assert.equal(drives(), before, 'a parked entry is an event wait: no queue tick for it');
  f.setRed(undefined);
  await f.transaction('release', mainAudit.releaseHeld, { projectId: f.projectId });
  const released = f.landingRow();
  assert.equal(released.phase, 'queued');
  assert(released.alarm?.taskId, 'a released queued entry has its stall alarm again');
  assert(drives() > before, 'release wakes the queue once');
});

test('687d1eda D review 2: a same-Lane re-submit while parked keeps the parked entry', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  // A same-Lane retry while parked: the hold is a live owner, nothing is superseded.
  const replaced = await f.transaction(
    'parkResubmit',
    {
      _handler: async ctx => {
        const { row } = await store.loadLanding(ctx, {
          projectId: f.projectId,
          submissionId: states(f)[0].id,
        });
        return laneFinish.replaceOwnerlessLanding(ctx, row);
      },
    },
    {},
  );
  assert.equal(replaced, false, 'the parked entry has a live owner (the main-red hold)');
  assert.equal(states(f)[0].phase, 'queued');
  assert.equal(f.landingRow().hold, 'main-red');
});

test('687d1eda D review 2: a withdrawn parked landing never lands', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  const result = JSON.parse(
    await f.call('parkCancel', landingApi.cancel, {
      projectId: f.projectId,
      request: JSON.stringify({
        operationId: randomUUID(),
        authorityEpoch: 1,
        submissionId: states(f)[0].id,
      }),
    }),
  );
  assert.equal(result.phase, 'terminal-failed');
  assert.equal(f.landingRow().hold, undefined, 'an ended entry keeps no hold');
  const runs = f.runs().length;
  await f.green();
  await passQueued(f);
  assert.equal(states(f)[0].phase, 'terminal-failed', 'green main does not revive a withdrawn landing');
  assert.equal(f.runs().length, runs, 'no check for a withdrawn landing');
  assert.equal(f.landingRow().runnable, false);
});

test('687d1eda D review 2: release drops a stale hold on an ended entry instead of reviving it', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  // An entry ended by an older writer that kept its hold.
  const row = f.landingRow();
  const ended = { ...JSON.parse(row.value), phase: 'terminal-failed' };
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'terminal-failed',
    value: JSON.stringify(ended),
  });
  await f.green();
  assert.equal(f.landingRow().hold, undefined);
  assert.equal(f.landingRow().runnable, false);
  assert.equal(f.landingRow().phase, 'terminal-failed');
});

test('687d1eda D: two parked landings are released together and both land; switch off while parked still releases', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t, { count: 2 });
  await parkAll(f);
  assert.deepEqual(
    f.rows().map(r => r.hold),
    ['main-red', 'main-red'],
  );
  delete process.env[SWITCH];
  await f.green();
  assert.deepEqual(
    f.rows().map(r => r.hold),
    [undefined, undefined],
  );
  await passQueued(f);
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
});

test('687d1eda D: main red again before release keeps entries parked; a released entry is checked, not re-parked', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  // A later failed audit of a new episode: still red, nothing is released.
  f.setRed({ since: '2026-11-19T12:30:00.000Z', runId: 'red-audit-2' });
  await f.transaction('releaseWhileRed', mainAudit.releaseHeld, { projectId: f.projectId });
  assert.equal(f.landingRow().hold, 'main-red');
  assert.equal(f.landingRow().runnable, false);
  await f.green();
  assert.equal(f.landingRow().hold, undefined);
  // Main goes red again right after release: the ordinary queue check decides, no park loop.
  f.setRed({});
  const queued = f.runs().filter(r => r.status === 'queued');
  assert.equal(queued.length, 1, 'one ordinary check after release');
  await failRun(f, queued[0].id);
  await f.drain();
  assert.notEqual(f.landingRow().hold, 'main-red', 'only an admission check parks');
  assert.equal(states(f)[0].phase, 'terminal-failed');
});

test('687d1eda D review 5: parked entries give up reservations and the cohort window; later waiters still release', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t, { count: 17 });
  // One parked entry carried a landing reservation.
  const first = f.rows()[0];
  f.patch('projectHostedLandingRequests', first._id, { reservedUntil: Date.now() + 30 * 60_000 });
  await parkAll(f);
  assert.equal(f.rows().filter(r => r.hold === 'main-red').length, 17);
  assert.equal(f.rows()[0].reservedUntil, undefined, 'a parked entry holds no reservation');
  assert(
    f.rows().every(r => !r.batchable),
    'parked entries leave the admission window',
  );
  // A later admitted waiter (passed admission, held for peers) behind 17 parked entries.
  const waiter = f.rows()[16];
  f.patch('projectHostedLandingRequests', waiter._id, {
    hold: undefined,
    batchable: true,
    runnable: false,
    admission: { runId: randomUUID(), status: 'passed', endedAt: Date.now() },
  });
  await f.transaction(
    'admissionWaiters',
    { _handler: ctx => admissionWake.releaseAdmissionWaiters(ctx, f.projectId) },
    {},
  );
  assert.equal(f.rows()[16].runnable, true, 'the waiter past 16 parked entries is released');
});

test('687d1eda D review 4: static, incomplete, interrupted or cancelled runs never park', async t => {
  process.env[SWITCH] = '1';
  for (const [name, files, options] of [
    ['static job failed too', [RED, RED2], { staticStatus: 'failed' }],
    ['shard 1 never reported', [RED], { shards: [[0, 'failed']] }],
    ['shard cancelled', [RED], { staticStatus: 'cancelled' }],
    ['run interrupted', [RED], { status: 'interrupted' }],
  ]) {
    const f = await redMain(t, { tests: [RED, RED2] });
    await failRun(f, f.runs()[0].id, files, options);
    await f.drain();
    assert.notEqual(f.landingRow().hold, 'main-red', name);
    assert.notEqual(states(f)[0].error?.code, 'MAIN_RED', name);
  }
});

test('687d1eda D: a failure outside main red tests, an incomplete red list, or a failure naming this change still fails', async t => {
  process.env[SWITCH] = '1';
  for (const [name, options, file, firstError] of [
    ['other file', {}, 'tests/member-0.test.mjs'],
    ['clipped red list', { moreTests: 3 }, RED],
    ['red test names this change', {}, RED, f => `${f}: TypeError at member-0:3`],
  ]) {
    const f = await redMain(t, options);
    await failRun(f, f.runs()[0].id, [file], firstError ? { firstError } : {});
    await f.drain();
    const state = states(f)[0];
    assert.equal(state.phase, 'terminal-failed', name);
    assert.equal(state.error.code, 'CHECK_FAILED', name);
    assert.equal(f.landingRow().hold, undefined, name);
  }
});

test('687d1eda D review 3: the first error comes from the file summary on R2 runs', async t => {
  const f = await redMain(t);
  await failRun(f, f.runs()[0].id);
  await f.drain();
  const failed = f.runs()[0];
  const judge = (run, attempt) =>
    f.transaction(
      'redOnlyFailure',
      {
        _handler: async ctx => {
          const state = states(f)[0];
          const own = await store.loadLandingAttempt(ctx, {
            projectId: f.projectId,
            attemptId: state.attemptId,
          });
          return park.redOnlyFailure(ctx, f.projectId, attempt?.(own) ?? own, run);
        },
      },
      {},
    );
  // An R2-backed run keeps no contractReports on the run row: its excerpts are in testFiles.
  const r2 = (firstError, extra = {}) => {
    const run = { ...failed, ...extra };
    delete run.contractReports;
    run.testFiles = {
      counts: { total: 1, failed: 1, flaky: 0 },
      failed: [{ file: RED, report: { failed: true, durationMs: 1, firstError } }],
      flaky: [],
    };
    return run;
  };
  assert.deepEqual(
    await judge(r2(`${RED}: unrelated`)),
    { files: [RED], auditRunId: 'red-audit' },
    'a red-only failure parks with its audit link',
  );
  assert.equal(await judge(r2(`${RED}: TypeError at member-0:3`)), null, 'the excerpt names this change');
  assert.equal(await judge(r2(`${RED}: unrelated`, { poolPending: [RED2] })), null, 'unreported pool files');
});

test('687d1eda D review 6: a revoked submitter or a changed Candidate fails closed instead of throwing', async t => {
  const f = await redMain(t);
  await failRun(f, f.runs()[0].id);
  await f.drain();
  const failed = f.runs()[0];
  const judge = (run, attempt) =>
    f.transaction(
      'redOnlyFailure',
      {
        _handler: async ctx => {
          const state = states(f)[0];
          const own = await store.loadLandingAttempt(ctx, {
            projectId: f.projectId,
            attemptId: state.attemptId,
          });
          return park.redOnlyFailure(ctx, f.projectId, attempt?.(own) ?? own, run);
        },
      },
      {},
    );
  // An R2-backed run keeps no contractReports on the run row: its excerpts are in testFiles.
  const r2 = (firstError, extra = {}) => {
    const run = { ...failed, ...extra };
    delete run.contractReports;
    run.testFiles = {
      counts: { total: 1, failed: 1, flaky: 0 },
      failed: [{ file: RED, report: { failed: true, durationMs: 1, firstError } }],
      flaky: [],
    };
    return run;
  };
  assert.deepEqual(
    await judge(r2(`${RED}: unrelated`)),
    { files: [RED], auditRunId: 'red-audit' },
    'a red-only failure parks with its audit link',
  );
  assert.equal(
    await judge(r2(`${RED}: unrelated`), a => ({ ...a, actor: { ...a.actor, id: 'revoked-member' } })),
    null,
    'a submitter without access fails closed instead of throwing',
  );
  assert.equal(
    await judge(r2(`${RED}: unrelated`), a => ({
      ...a,
      candidate: { ...a.candidate, digest: 'f'.repeat(64) },
    })),
    null,
    'a changed Candidate record fails closed',
  );
});

test('687d1eda D: with the switch off a red-only failure fails as before', async t => {
  const f = await redMain(t);
  await failRun(f, f.runs()[0].id);
  await f.drain();
  assert.equal(states(f)[0].phase, 'terminal-failed');
  assert.equal(states(f)[0].error.code, 'CHECK_FAILED');
  assert.equal(f.landingRow().hold, undefined);
});

test('687d1eda D round 2 finding 1: a release after a long park counts the stall from release, no false stall', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  // Main stays red past the stall (15 min) and drop (60 min) limits.
  f.advanceClock(70 * 60_000);
  f.setRed(undefined);
  await f.transaction('release', mainAudit.releaseHeld, { projectId: f.projectId });
  const row = f.landingRow();
  assert.equal(row.hold, undefined);
  assert(row.alarm?.taskId, 'released with a stall alarm');
  const alarm = task(f, row.alarm.taskId);
  assert(
    alarm.scheduledTime >= Date.now() + STALL_MS - 1_000,
    `alarm fires 15 min after release, not at once (in ${alarm.scheduledTime - Date.now()} ms)`,
  );
  assert.equal(states(f)[0].observation.stall, undefined);
  // The released entry is claimed and checked on green main before any alarm fires.
  await f.drain();
  await passQueued(f);
  assert.equal(states(f)[0].phase, 'landed');
  assert.equal(
    [...f.tables._scheduled_functions.values()].filter(t =>
      t.name.startsWith('projectHostedLandingStallAlert:'),
    ).length,
    0,
    'no stall alert for the released entry',
  );
});

test('687d1eda D round 2 finding 1: with the switch on a released publication hold gets its stall alarm; off, release is as on main', async t => {
  for (const on of [true, false]) {
    process.env[SWITCH] = '1';
    const f = await redMain(t);
    await parkAll(f);
    if (!on) delete process.env[SWITCH];
    asPublicationHold(f, f.landingRow());
    f.advanceClock(70 * 60_000);
    f.setRed(undefined);
    await f.transaction('release', mainAudit.releaseHeld, { projectId: f.projectId });
    const row = f.landingRow();
    assert.equal(row.hold, undefined);
    assert.equal(row.runnable, true);
    if (on) {
      assert(row.alarm?.taskId, 'switch on: a released publication hold has a stall alarm');
      assert(task(f, row.alarm.taskId).scheduledTime >= Date.now() + STALL_MS - 1_000);
    } else
      assert.equal(row.alarm ?? null, null, 'switch off: main keeps the publication hold release unchanged');
  }
});

// Item 10b0a94b review: a row parked at publication on red main no longer decides its own run, so
// it neither fills a check slot (forcing every recheck full) nor keeps peers' cohort holds until
// main recovers.
test('a publication hold on red main clears the parked row deciding stamp', async t => {
  const f = await redMain(t);
  const id = f.landingRow()._id;
  f.patch('projectHostedLandingRequests', id, { deciding: Date.parse('2026-01-01T12:00:00.000Z') });
  await f.transaction(
    'park',
    {
      _handler: async ctx => {
        const row = await ctx.db.get(id);
        await gate.holdMainRed(ctx, row, JSON.parse(row.value));
      },
    },
    {},
  );
  const row = f.tables.projectHostedLandingRequests.get(id);
  assert.equal(row.hold, 'main-red');
  // Before: the stamp stayed and the parked row counted as a deciding peer until release.
  assert.equal(row.deciding, undefined);
});

test('687d1eda D round 2 finding 2: more than 100 parked rows release outside the green mutation in bounded pages', async t => {
  process.env[SWITCH] = '1';
  const COUNT = 105;
  const f = await redMain(t, { count: COUNT });
  await parkAll(f, [RED], 25);
  assert.equal(f.rows().filter(r => r.hold === 'main-red').length, COUNT);
  f.setRed(undefined);
  // The mutation that turns main green (publication or audit) only schedules the release.
  const before = f.counts.length;
  await f.transaction('greenInline', { _handler: ctx => auditState.releaseMainHolds(ctx, f.projectId) }, {});
  const inline = f.counts.slice(before).filter(c => c.name === 'greenInline');
  assert.equal(f.rows().filter(r => r.hold === 'main-red').length, COUNT, 'nothing released inline');
  assert.equal(pendingTasks(f, 'projectHostedMainAudit:releaseHeld').length, 1, 'one scheduled release');
  for (const count of inline) assert(count.documents <= 3 && count.writes <= 1, JSON.stringify(count));
  const pages = await runReleases(f);
  assert(pages >= 5, `pages of 25: ${pages}`);
  assert.equal(f.rows().filter(r => r.hold === 'main-red').length, 0, 'every parked row released');
  const released = f.rows();
  assert(
    released.every(r => r.runnable && r.alarm?.taskId),
    'each released row is runnable with a stall alarm',
  );
  for (const count of f.counts.slice(before).filter(c => c.name === 'releasePage')) {
    assert(count.documents <= 400 && count.ranges <= 400, `bounded reads ${JSON.stringify(count)}`);
    assert(
      controllerMetadataFits(count, 2 * 1024 * 1024, 512 * 1024),
      `bounded bytes ${JSON.stringify({ documents: count.documents, writes: count.writes, readBytes: count.readBytes, writeBytes: count.writeBytes })}`,
    );
  }
  // Each released row costs one row patch, one observation and one alarm: no landing write.
  const attempts = f.counts.slice(before).filter(c => c.name === 'releasePage');
  assert(
    attempts.every(c => !c.touched.includes('projectHostedLandingAttempts')),
    'no attempt reads or writes',
  );
});

test('687d1eda D round 2 finding 3: only the standard check can park (a project command may run build next to tests)', async t => {
  const f = await redMain(t);
  await failRun(f, f.runs()[0].id);
  await f.drain();
  const failed = f.runs()[0];
  const judge = run =>
    f.transaction(
      'redOnlyFailure',
      {
        _handler: async ctx => {
          const own = await store.loadLandingAttempt(ctx, {
            projectId: f.projectId,
            attemptId: states(f)[0].attemptId,
          });
          return park.redOnlyFailure(ctx, f.projectId, own, run);
        },
      },
      {},
    );
  assert.deepEqual(
    await judge(failed),
    { files: [RED], auditRunId: 'red-audit' },
    'the standard check parks a red-only failure with its audit link',
  );
  assert.equal(
    await judge({ ...failed, check: { ...failed.check, executable: 'bash', args: ['ci/check.sh'] } }),
    null,
    'a sharded project command never parks',
  );
});

test("687d1eda D round 2 finding 4: this Intent's own contract tests, from the run or attempt, keep it from parking", async t => {
  const f = await redMain(t);
  await failRun(f, f.runs()[0].id);
  await f.drain();
  const failed = f.runs()[0];
  const intentId = f.c.intentId;
  const plan = (id, tests) => ({
    primaryIntentId: intentId,
    members: [
      { intentId: id, outcome: 'o', version: 1, tests: tests.map(path => ({ path, durationMs: 1 })) },
    ],
  });
  const judge = (run, attempt) =>
    f.transaction(
      'redOnlyFailure',
      {
        _handler: async ctx => {
          const own = await store.loadLandingAttempt(ctx, {
            projectId: f.projectId,
            attemptId: states(f)[0].attemptId,
          });
          return park.redOnlyFailure(ctx, f.projectId, attempt?.(own) ?? own, run);
        },
      },
      {},
    );
  assert.deepEqual(await judge(failed), { files: [RED], auditRunId: 'red-audit' });
  assert.equal(await judge({ ...failed, gate: { mode: 'contract', tests: [RED] } }), null, 'run.gate.tests');
  assert.equal(await judge({ ...failed, semanticPlan: plan(intentId, [RED]) }), null, 'run.semanticPlan');
  assert.equal(
    await judge(failed, a => ({ ...a, semanticPlan: plan(intentId, [RED]) })),
    null,
    'attempt.semanticPlan',
  );
  assert.deepEqual(
    await judge({ ...failed, semanticPlan: plan('00000000-0000-4000-8000-000000000000', [RED]) }),
    { files: [RED], auditRunId: 'red-audit' },
    "a peer Intent's contract test does not count as this one's",
  );
});

test("687d1eda D round 2 finding 5: only parkLanding parks; another queued write of a held row keeps main's behaviour", async t => {
  // Main's path: a publication hold recomposed onto moved main (redrive + CHANNEL_CHANGED) is
  // written queued while its row still carries the hold. That write must not park it.
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  delete process.env[SWITCH];
  const { id } = states(f)[0];
  await f.transaction(
    'heldQueuedWrite',
    {
      _handler: async ctx => {
        const { row, state } = await store.loadLanding(ctx, { projectId: f.projectId, submissionId: id });
        await store.writeLanding(ctx, row, { ...state, version: state.version + 1, error: null }, true);
      },
    },
    {},
  );
  const written = f.landingRow();
  assert.equal(written.runnable, true, 'not parked: runnable as the caller asked');
  assert.equal(written.hold, 'main-red', 'the hold is left as main leaves it');
  assert(written.alarm?.taskId, 'it keeps an ordinary stall alarm');
});

test('687d1eda D round 2 finding 6: the stall note drops a stale hold on an ended entry', async t => {
  process.env[SWITCH] = '1';
  const f = await redMain(t);
  await parkAll(f);
  const row = f.landingRow();
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'terminal-failed',
    value: JSON.stringify({ ...JSON.parse(row.value), phase: 'terminal-failed' }),
  });
  const audit = [...f.tables.projectHostedMainAudits.values()].find(r => r.projectId === f.projectId);
  await f.transaction('stallHeld', mainAudit.stallHeld, {
    projectId: f.projectId,
    runId: 'red-audit',
    sequence: (audit.lastGreen?.sequence ?? -1) + 1,
    step: 'test',
    cursor: null,
  });
  assert.equal(f.landingRow().hold, undefined, 'an ended entry keeps no hold');
  assert.equal(f.landingRow().phase, 'terminal-failed');
});

test('687d1eda D review 3: a lost release page is re-driven by sweep and by a same-Lane re-submit once main is green', async t => {
  process.env[SWITCH] = '1';
  const releases = f => pendingTasks(f, 'projectHostedMainAudit:releaseHeld').length;
  const resubmit = f =>
    f.transaction(
      'parkResubmit',
      {
        _handler: async ctx => {
          const { row } = await store.loadLanding(ctx, {
            projectId: f.projectId,
            submissionId: states(f)[0].id,
          });
          return laneFinish.replaceOwnerlessLanding(ctx, row);
        },
      },
      {},
    );
  const sweep = async f => {
    await f.transaction('sweep', redrive.sweep, { cursor: null });
    // Only this fixture's project: a sweep continuation would visit nothing else.
    for (const t of pendingTasks(f, 'projectHostedLandingRedrive:sweep'))
      f.patch('_scheduled_functions', t._id, { state: { kind: 'canceled' } });
  };
  // Main turned green but its release page was lost (the task failed): red is clear, rows stay held.
  const f = await redMain(t, { count: 2 });
  await parkAll(f);
  await sweep(f);
  assert.equal(releases(f), 0, 'main still red: nothing to release');
  f.setRed(undefined);
  assert.deepEqual(
    f.rows().map(r => r.hold),
    ['main-red', 'main-red'],
  );
  await sweep(f);
  assert.equal(releases(f), 1, 'the sweep re-drives the release once per project');
  await runReleases(f);
  assert.deepEqual(
    f.rows().map(r => r.hold),
    [undefined, undefined],
  );
  await f.drain();
  await passQueued(f);
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  // A same-Lane re-submit on a stranded entry joins it and re-drives the release; it never hangs.
  const g = await redMain(t);
  await parkAll(g);
  g.setRed(undefined);
  assert.equal(await resubmit(g), false, 'the parked entry is kept');
  assert.equal(releases(g), 1, 're-submit re-drives the lost release');
  await runReleases(g);
  await g.drain();
  await passQueued(g);
  assert.equal(states(g)[0].phase, 'landed');
});
