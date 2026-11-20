// SPDX-License-Identifier: Apache-2.0
// Item 687d1eda: main red is not the Lane's failure, past the admission check (switch
// FORGE_QUEUE_PARK_EXACT_ON_MAIN_RED, off by default). A cohort's shared run or one entry's own
// exact check that fails only on main's red tests parks its entries, then re-lands them on green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { api } from './hosted-finish-fixture.mjs';
import { assertForkRacesNamed } from './fork-race-names.mjs';
const mainAudit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
const screen = await import(moduleUrl('../convex/projectFailureCause.ts'));
const attemptRead = await import(moduleUrl('../convex/projectHostedLandingAttemptRead.ts'));
const SWITCH = 'FORGE_QUEUE_PARK_EXACT_ON_MAIN_RED';
const ADMISSION = 'FORGE_QUEUE_PARK_ON_MAIN_RED';
const prior = Object.fromEntries(
  [...Object.keys(synthetic), SWITCH, ADMISSION].map(k => [k, process.env[k]]),
);
test.before(() => Object.assign(process.env, synthetic));
test.afterEach(() => {
  delete process.env[SWITCH];
  delete process.env[ADMISSION];
});
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const RED = 'tests/lane-review-browser.test.mjs';
const at = '2026-11-19T10:41:00.000Z';

async function fixture(t, options) {
  const f = await batchesFixture(t, options);
  const row = [...f.tables.projectHostedMainAudits.values()].find(r => r.projectId === f.projectId);
  f.auditId = row?._id ?? f.insert('projectHostedMainAudits', { projectId: f.projectId });
  /** `null` clears main's red. */
  f.setRed = (tests = [RED]) =>
    f.patch('projectHostedMainAudits', f.auditId, {
      red: tests ? { since: at, head: f.currentMain().head, runId: 'red-audit', tests } : undefined,
    });
  f.rows = () => [...f.tables.projectHostedLandingRequests.values()].filter(r => r.projectId === f.projectId);
  f.batches = () => [...f.tables.projectHostedLandingBatches.values()].map(r => JSON.parse(r.value));
  f.queued = () => f.runs().filter(r => r.status === 'queued');
  f.green = async () => {
    f.setRed(null);
    await f.transaction('release', mainAudit.releaseHeld, { projectId: f.projectId });
    await f.drain();
  };
  return f;
}
/** A finished run that failed on `files` in test job 0 while the static job (the last) passed. */
async function failRun(f, runId, files = [RED]) {
  const run = await f.rawChecks.activate(runId);
  await f.rawChecks.callback(f.rawChecks.shard(run, 0, 'failed'));
  await f.rawChecks.callback(f.rawChecks.shard(run, 1, 'passed'));
  await f.rawChecks.callback(
    f.rawChecks.complete(run, 'failed', {
      contractReports: Object.fromEntries(
        files.map(file => [file, { failed: true, durationMs: 1, firstError: `${file}: 398 > 390` }]),
      ),
    }),
  );
}
async function passAll(f) {
  for (let round = 0; round < 20 && f.queued().length; round++) {
    for (const run of f.queued()) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.drain();
  }
}
const parked = f =>
  f.rows().filter(r => r.hold === 'main-red' && r.phase === 'queued' && r.runnable === false);

test('incident 687d1eda: a cohort failing only on main red tests parks every member, no solo re-checks, and re-lands on green', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 4 });
  f.setRed();
  await f.drain();
  assert.equal(f.runs().length, 1, 'one shared check for the cohort');
  await failRun(f, f.runs()[0].id);
  await f.drain();
  // Before: the cohort split into halves and singles, each a full check on red main that failed
  // the same way, and every landing ended CHECK_FAILED (10 failures, 302 min wait on 11-19).
  assert.equal(f.runs().length, 1, 'no split or solo re-check runs while main is red');
  assert.equal(parked(f).length, 4, 'every member waits under the main-red hold');
  for (const state of states(f)) {
    assert.equal(state.phase, 'queued', 'not terminal-failed: the changes are not at fault');
    assert.equal(state.error.code, 'MAIN_RED');
    assert.match(state.error.message, /failed only on tests main fails too \(tests\/lane-review-browser/);
    assert.equal(state.batchId, undefined, 'a parked entry left its failed cohort');
  }
  for (const row of f.rows()) {
    assert.equal(row.alarm ?? null, null, 'an event wait holds no stall alarm (idle costs nothing)');
    assert.equal(row.batchable, false);
  }
  const cohort = f.batches().find(batch => batch.runId === f.runs()[0].id);
  assert.equal(cohort.phase, 'failed');
  assert.equal(cohort.transition.code, 'MAIN_RED');
  const queue = [...f.tables.projectHostedLandingQueues.values()].find(q => q.projectId === f.projectId);
  assert(
    !(queue.train ?? []).some(id => states(f).some(s => s.id === id)),
    'nothing stacks on a parked entry',
  );
  await f.green();
  assert.equal(parked(f).length, 0);
  await passAll(f);
  assert(
    states(f).every(state => state.phase === 'landed'),
    JSON.stringify(states(f).map(s => [s.phase, s.error])),
  );
  assert(f.runs().length >= 2, 'their check ran again on green main');
  const files = JSON.parse(f.c.objects.get(f.currentMain().head)).files.map(file => file.path);
  for (let i = 0; i < 4; i++) assert(files.includes(`member-${i}`), 'every change is on main');
});

test('c3c69c57: a cohort composed on a moved main that parks on main red names the race main-red', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 2 });
  // Main moves after submission: the cohort checks on the new main, its members' own attempts
  // keep the old one, so parking each back on its own attempt discards the shared run.
  f.moveMain();
  f.setRed();
  await f.drain();
  assert.equal(f.runs().length, 1, 'one shared check for the cohort');
  await failRun(f, f.runs()[0].id);
  await f.drain();
  assert.equal(parked(f).length, 2, 'every member waits under the main-red hold');
  // Before: the parked attempts carried no reason, so the metrics main-race row was unnamed.
  assertForkRacesNamed(f, 'main-red');
  await f.green();
  await passAll(f);
  assert(states(f).every(state => state.phase === 'landed'));
  assertForkRacesNamed(f, 'main-red');
});

test('687d1eda: with the queue-check switch off a red-only cohort failure still splits as on main', async t => {
  const f = await fixture(t, { count: 4 });
  f.setRed();
  await f.drain();
  await failRun(f, f.runs()[0].id);
  await f.drain();
  assert.equal(parked(f).length, 0);
  assert(f.runs().length > 1, 'the split re-checks on red main');
  assert(states(f).every(state => state.error?.code !== 'MAIN_RED'));
});

test('687d1eda: a failure a member explains, one outside main red, or one while main is green never parks', async t => {
  process.env[SWITCH] = '1';
  {
    // member-1 changed `member-1`: its test failing is its own, even while main fails it too.
    const f = await fixture(t, { count: 4 });
    f.setRed([RED, 'tests/member-1.test.mjs']);
    await f.drain();
    await failRun(f, f.runs()[0].id, [RED, 'tests/member-1.test.mjs']);
    await f.drain();
    assert.equal(parked(f).length, 0, 'a named member is attributed, not parked');
  }
  {
    const f = await fixture(t, { count: 4 });
    f.setRed();
    await f.drain();
    await failRun(f, f.runs()[0].id, [RED, 'tests/other.test.mjs']);
    await f.drain();
    assert.equal(parked(f).length, 0, 'a file main does not fail is not main red');
  }
  {
    const f = await fixture(t, { count: 4 });
    f.setRed(null);
    await f.drain();
    await failRun(f, f.runs()[0].id);
    await f.drain();
    assert.equal(parked(f).length, 0, 'main green: a failure is the change set’s');
  }
});

test('687d1eda: one deferred entry whose own exact check fails only on main red parks and re-lands on green', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 1 });
  f.setRed();
  await f.drain();
  assert.equal(f.runs().length, 1);
  await failRun(f, f.runs()[0].id);
  await f.drain();
  assert.equal(parked(f).length, 1);
  const [state] = states(f);
  assert.equal(state.error.code, 'MAIN_RED');
  assert.equal(f.queued().length, 0, 'nothing re-checks on red main');
  await f.green();
  await passAll(f);
  assert.equal(states(f)[0].phase, 'landed');
  assert.equal(f.runs().length, 2, 'one re-check on green main');
});

test('687d1eda: a deferred entry whose check needed a platform retry still parks on main red', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 1 });
  f.setRed();
  await f.drain();
  // The runner was unavailable: one platform retry, a child attempt of the first check attempt.
  const first = await f.rawChecks.activate(f.runs()[0].id);
  await f.rawChecks.callback(f.rawChecks.complete(first, 'runner-unavailable'));
  await f.drain();
  const retries = f.queued();
  assert.equal(retries.length, 1, 'the platform retry runs');
  await failRun(f, retries[0].id);
  await f.drain();
  assert.equal(parked(f).length, 1, JSON.stringify(states(f).map(s => [s.phase, s.error?.code])));
  await f.green();
  await passAll(f);
  assert.equal(states(f)[0].phase, 'landed');
});

test('687d1eda: the deferred origin of a check is its nearest deferred parent, past platform retries only', async () => {
  const projectId = 'project';
  const ctx = {};
  const chain = attempts => {
    const pins = attemptRead.pinsFor(ctx);
    pins.clear();
    for (const attempt of attempts) pins.set(`${projectId}:${attempt.id}`, attempt);
    return attempts.at(-1);
  };
  const origin = async attempt => (await attemptRead.deferredOrigin(ctx, projectId, attempt))?.id ?? null;
  const check = { runId: 'run' };
  const deferred = (id, extra = {}) => ({
    id,
    parentAttemptId: null,
    deferredCheck: true,
    check: null,
    ...extra,
  });
  const checked = (id, parentAttemptId, extra = {}) => ({ id, parentAttemptId, check, ...extra });
  // Deferred, then its check, then two platform retries of that check.
  assert.equal(
    await origin(
      chain([
        deferred('d'),
        checked('c0', 'd'),
        checked('c1', 'c0', { platformRetries: 1 }),
        checked('c2', 'c1', { platformRetries: 2 }),
      ]),
    ),
    'd',
  );
  // A retry that main moved under: the stale-check re-queue re-deferred it and kept its count, and
  // the next check copied that count without being retried itself. Its parent is the origin.
  assert.equal(
    await origin(
      chain([
        deferred('d'),
        checked('c0', 'd'),
        checked('c1', 'c0', { platformRetries: 1 }),
        deferred('d2', { parentAttemptId: 'c1', platformRetries: 1 }),
        checked('c3', 'd2', { platformRetries: 1 }),
      ]),
    ),
    'd2',
  );
  // Never deferred: an exact check with no deferred parent, retried or not.
  assert.equal(await origin(chain([checked('e0', null)])), null);
  assert.equal(await origin(chain([checked('e0', null), checked('e1', 'e0', { platformRetries: 1 })])), null);
  // A check whose parent is a check of another kind (not a retry of it) stops there.
  assert.equal(await origin(chain([deferred('d'), checked('x', 'd'), checked('y', 'x')])), null);
});

test('687d1eda: an exact check its submission never deferred (no owner provenance) fails as before, never parks', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 1, requestCheck: true });
  f.setRed();
  await f.drain();
  await failRun(f, f.runs()[0].id);
  await f.drain();
  // Re-deferring it would hand it a batchable, deferred attempt its submission was never given.
  assert.equal(parked(f).length, 0);
  assert.equal(states(f)[0].phase, 'terminal-failed');
  assert.equal(states(f)[0].error.code, 'CHECK_FAILED');
});

test('687d1eda: a serial fallback member parked on main red leaves the line, which moves to the next member', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 2 });
  await f.drain();
  // The shared run failed before main's audit had marked the test red: the cohort splits into a
  // serial individual line, as in the incident.
  await failRun(f, f.runs()[0].id);
  await f.drain();
  assert.equal(parked(f).length, 0);
  f.setRed();
  const first = f.queued();
  assert.equal(first.length, 1, 'one member of the line checks at a time');
  await failRun(f, first[0].id);
  await f.drain();
  assert.equal(parked(f).length, 1, 'the first single parks');
  const next = f.queued();
  assert.equal(next.length, 1, 'the line moved on to the next member at once');
  await failRun(f, next[0].id);
  await f.drain();
  assert.equal(parked(f).length, 2);
  await f.green();
  await passAll(f);
  assert(
    states(f).every(state => state.phase === 'landed'),
    JSON.stringify(states(f).map(s => [s.phase, s.error])),
  );
});

test("687d1eda: a parked fallback member released on green while the line still runs is no longer the line's", async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 2 });
  await f.drain();
  await failRun(f, f.runs()[0].id);
  await f.drain();
  const line = f.batches().find(batch => batch.phase === 'fallback');
  assert(line, 'the cohort became a serial individual line');
  f.setRed();
  const [first] = f.queued();
  await failRun(f, first.id);
  await f.drain();
  assert.equal(parked(f).length, 1);
  const [second] = f.queued();
  const parkedId = parked(f)[0].submissionId;
  // Main is repaired while the second member checks: the parked one queues on its own again.
  await f.green();
  assert.equal(parked(f).length, 0);
  await f.rawChecks.pass(await f.rawChecks.activate(second.id));
  await f.drain();
  // Before: the released entry still counted as the line's pending member, so the line never
  // closed and wrote its fallback diagnostic over the entry's own state.
  assert.equal(f.batches().find(batch => batch.id === line.id).phase, 'landed', 'the line closed');
  const released = states(f).find(state => state.id === parkedId);
  assert.notEqual(released.batchDiagnostic?.sharedRunId ?? null, line.runId, 'no stale line diagnostic');
  await passAll(f);
  assert(
    states(f).every(state => state.phase === 'landed'),
    JSON.stringify(states(f).map(s => [s.phase, s.error])),
  );
});

test('687d1eda: the lone single of an odd split parks too, and all three land on green', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 3 });
  await f.drain();
  // An odd cohort splits into a pair and a single checked alone (no fallback line).
  await failRun(f, f.runs()[0].id);
  await f.drain();
  f.setRed();
  for (let round = 0; round < 8 && f.queued().length; round++) {
    for (const run of f.queued()) await failRun(f, run.id);
    await f.drain();
  }
  assert.equal(parked(f).length, 3, JSON.stringify(states(f).map(s => [s.phase, s.error?.code])));
  await f.green();
  await passAll(f);
  assert(states(f).every(state => state.phase === 'landed'));
});

test('687d1eda: only a landing whose fresh land would park is told to land again now', async t => {
  process.env[SWITCH] = '1';
  process.env[ADMISSION] = '1';
  const advice = async f => {
    // The check failed before main's audit marked the test red; main is red when the agent asks.
    await failRun(f, f.runs()[0].id);
    await f.drain();
    assert.equal(states(f)[0].phase, 'terminal-failed');
    f.setRed();
    const status = JSON.parse(
      await f.tx('status', api.status, { projectId: f.projectId, submissionId: states(f)[0].id }),
    );
    return status.failureCause;
  };
  const deferred = await fixture(t, { count: 1 });
  await deferred.drain();
  const parks = await advice(deferred);
  assert.equal(parks.recovery, 'wait-for-main', JSON.stringify(parks));
  assert.match(parks.next, /run land --save again now/);
  // Never deferred (no owner provenance): a fresh land checks in full on red main and fails again.
  const direct = await fixture(t, { count: 1, requestCheck: true });
  await direct.drain();
  const fails = await advice(direct);
  assert.equal(fails.recovery, 'wait-for-main', JSON.stringify(fails));
  assert.doesNotMatch(fails.next, /again now/);
  assert.match(fails.next, /once main passes/);
});

test('687d1eda: the Lane check screen reads nothing more for a passed check with both park switches on', async t => {
  const f = await fixture(t, { count: 1 });
  await f.drain();
  await passAll(f);
  assert.equal(states(f)[0].phase, 'landed');
  const { laneId } = f.entries[0].lane;
  const reads = async name => {
    await f.tx(name, screen.forLane, { projectId: f.projectId, laneId });
    return f.counts.filter(count => count.name === name).map(count => count.documents);
  };
  const off = await reads('screen-off');
  process.env[SWITCH] = '1';
  process.env[ADMISSION] = '1';
  assert.deepEqual(await reads('screen-on'), off, 'the re-land advice reads only for a failed run');
});

test('687d1eda: split cohorts after a run that failed before main was marked red park on the same red test', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 4 });
  await f.drain();
  // As on 11-19: the first shared run fails before main's audit marks the test red, so the
  // cohort splits; each child's prior failure is that same test, a repeat offence only of main's.
  await failRun(f, f.runs()[0].id);
  await f.drain();
  f.setRed();
  for (let round = 0; round < 8 && f.queued().length; round++) {
    for (const run of f.queued()) await failRun(f, run.id);
    await f.drain();
  }
  assert.equal(parked(f).length, 4, JSON.stringify(states(f).map(s => [s.phase, s.error?.code])));
  const checks = f.runs().length;
  assert(checks <= 3, `the split children parked at once, without singles on red main (${checks} runs)`);
  await f.green();
  await passAll(f);
  assert(states(f).every(state => state.phase === 'landed'));
});
