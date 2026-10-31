// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { checkFailureKind, cohortSizeFor, failureRate, halves } from '../dist/hosted-landing-admission.js';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(r => JSON.parse(r.value));
const files = (f, head) => JSON.parse(f.c.objects.get(head)).files.map(file => file.path);
// Settle every queued run: a run fails its own named test when its Candidate
// contains a bad member file (alone or with others), else it passes.
async function settle(f, bad = []) {
  for (let round = 0; round < 20 && f.runs().some(r => r.status === 'queued'); round++) {
    for (const run of f.runs().filter(r => r.status === 'queued')) {
      const culprit = bad.find(path => files(f, run.request.expectedHead).includes(path));
      if (culprit) await f.fail(run.id, `tests/${culprit}.test.mjs`);
      else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    await f.drain();
  }
}
const landed = f => states(f).filter(s => s.phase === 'landed').length;
const admitted = { admissionCheck: true, batchMaxSize: null };

test('cohort size follows the smoothed failure rate; failures without a failing test are platform', () => {
  assert.equal(failureRate(undefined, 'first'), 0.3);
  assert.equal(failureRate(undefined, 'admitted'), 0.05);
  assert(Math.abs(failureRate('1'.repeat(20), 'first') - 0.05) < 1e-9);
  assert(cohortSizeFor(0.3) >= 2 && cohortSizeFor(0.3) <= 3);
  assert.equal(cohortSizeFor(0.1), 4);
  assert.equal(cohortSizeFor(0.05), 5);
  assert.equal(cohortSizeFor(0.001), 8, 'cap 8');
  assert.equal(cohortSizeFor(0.5), 1, 'members check alone when most fail');
  const report = { 'tests/a.test.mjs': { failed: true } };
  assert.equal(checkFailureKind({ status: 'passed' }, { conflicts: [] }), 'passed');
  assert.equal(checkFailureKind({ status: 'failed', contractReports: report }, { conflicts: [] }), 'tests');
  assert.equal(
    checkFailureKind({ status: 'failed', testFiles: { failed: [{}] } }, { conflicts: [] }),
    'tests',
  );
  for (const status of ['failed', 'cancelled', 'timed_out', 'unavailable'])
    assert.equal(checkFailureKind({ status }, { conflicts: [] }), 'platform', status);
  assert.equal(checkFailureKind({ status: 'passed' }, { conflicts: [{}] }), 'tests');
  assert.deepEqual(halves([1, 2, 3, 4, 5]), [
    [1, 2, 3],
    [4, 5],
  ]);
});

test('E3 replay: the bad change fails alone at admission and three good ones land in one shared check', async t => {
  const f = await batchesFixture(t, admitted);
  const admissions = f.runs();
  assert.equal(admissions.length, 4, 'every arrival starts its own admission at once');
  assert(
    admissions.every(r => r.gate.mode === 'scoped'),
    'admission runs the selector affected set',
  );
  assert(states(f).every(s => s.phase === 'checking'));
  await settle(f, ['member-1']);
  const bad = states(f).find(s => s.id === f.entries[1].state.id);
  assert.equal(bad.phase, 'terminal-failed');
  assert.equal(bad.error.code, 'CHECK_FAILED');
  assert.match(bad.error.message, /admission check of this change alone failed.*tests\/member-1\.test\.mjs/);
  assert.equal(bad.batchId, undefined, 'ejected before any cohort existed');
  assert.equal(landed(f), 3);
  assert.equal(f.runs().length, 5, 'four admissions and ONE shared check');
  const shared = f.runs()[4];
  assert.equal(batches(f).length, 1);
  assert.equal(batches(f)[0].members.length, 3);
  assert.equal(batches(f)[0].admitted, true);
  assert(
    states(f).every(s => !s.batchSolo),
    'zero serial rounds',
  );
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert(receipts.every(r => r.check.runId === shared.id));
  assert.deepEqual(f.publications, [{ receipts: 3, mainMoves: 1, landed: 3 }]);
  assert(!files(f, f.currentMain().head).includes('member-1'));
  assert.equal(f.pending().length, 0, 'idle after settling: no timers or polling');
});

test('an admitted member waits for peers still admitting, then joins their cohort', async t => {
  const f = await batchesFixture(t, admitted);
  const [first, ...rest] = f.runs();
  f.advanceClock(60_000); // an admission run takes minutes
  await f.rawChecks.pass(await f.rawChecks.activate(first.id));
  await f.drain();
  assert.equal(landed(f), 0, 'it does not land alone while earlier peers are admitting');
  assert.equal(f.runs().length, 4, 'holding starts no run');
  for (const run of rest) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  await f.drain();
  assert.equal(f.runs().length, 5);
  assert.equal(batches(f)[0].members.length, 4);
  await settle(f);
  assert.equal(landed(f), 4);
  assert.equal(f.runs().length, 5);
});

test('a lone admitted member lands on its admission proof with no second run', async t => {
  const f = await batchesFixture(t, { ...admitted, count: 1 });
  await settle(f);
  assert.equal(landed(f), 1);
  assert.equal(f.runs().length, 1, 'the admission run is the acceptance evidence');
  const [receipt] = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert.equal(receipt.check.runId, f.runs()[0].id);
});

for (const admissionCheck of [false, true])
  test(`403 outage replay${admissionCheck ? ' after admission' : ''}: the same cohort retries and nobody goes solo`, async t => {
    const f = await batchesFixture(t, { admissionCheck, batchMaxSize: null, count: 3 });
    if (admissionCheck)
      for (const run of f.runs()) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.drain();
    const before = f.runs().length;
    const [batch] = batches(f);
    const outage = async () => {
      const run = f.runs().at(-1);
      // Actions completed (failure) without complete job evidence: no test failed.
      const activated = await f.rawChecks.activate(run.id);
      await f.rawChecks.callback(f.rawChecks.complete(activated, 'failed'));
      await f.drain();
    };
    await outage();
    assert.equal(f.runs().length, before + 1, 'one retry of the shared check');
    const retry = f.runs().at(-1);
    assert.equal(
      retry.request.candidateId,
      f.runs()[before - 1].request.candidateId,
      'same cohort Candidate',
    );
    assert(states(f).every(s => s.batchId === batch.id && !s.batchSolo && s.phase === 'checking'));
    await settle(f);
    assert.equal(landed(f), 3);
    assert(states(f).every(s => !s.batchSolo));
    assert.equal(batches(f).length, 1);
  });

test('a platform outage that outlasts the retries settles members without batchSolo', async t => {
  const f = await batchesFixture(t, { batchMaxSize: null, count: 2 });
  await f.drain();
  for (let i = 0; i < 3; i++) {
    const activated = await f.rawChecks.activate(f.runs().at(-1).id);
    await f.rawChecks.callback(f.rawChecks.complete(activated, 'cancelled'));
    await f.drain();
  }
  assert.equal(f.runs().length, 3);
  for (const state of states(f)) {
    assert.equal(state.phase, 'terminal-failed');
    assert.equal(state.error.code, 'CHECK_NOT_PASSED');
    assert.match(state.error.message, /without a failing test 3 times/);
    assert(!state.batchSolo, 'a resubmit re-derives eligibility');
  }
  assert.equal(batches(f)[0].phase, 'failed');
  assert.equal(f.pending().length, 0);
});

test('interaction replay: two admitted members fail together, split at once, and the second lands on main including the first', async t => {
  const f = await batchesFixture(t, { ...admitted, count: 2 });
  for (const run of f.runs()) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  await f.drain();
  assert.equal(f.runs().length, 3);
  await f.fail(f.runs()[2].id, 'tests/interaction.test.mjs');
  await f.drain();
  assert.equal(batches(f)[0].phase, 'split');
  assert.equal(landed(f), 1, 'the first half lands at once on its held admission proof');
  // Admission is never re-run; the first lander needs no run and only the
  // second rechecks, on the moved main.
  assert.equal(f.runs().length, 4);
  assert.deepEqual(
    ['member-0', 'member-1'].map(path => files(f, f.runs()[3].request.expectedHead).includes(path)),
    [true, true],
  );
  await settle(f);
  assert.equal(landed(f), 2);
  assert.equal(f.runs().length, 4);
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  const [one, two] = f.entries.map(e => receipts.find(r => r.submissionId === e.state.id));
  assert.equal(one.check.runId, f.runs()[0].id);
  assert.equal(two.previous.head, one.candidate.head, 'checked on main including the first');
  assert(files(f, two.candidate.head).includes('member-0'));
});

test('compose stall replay: a cohort that cannot compose splits into parallel halves, not serial solos', async t => {
  // 2026-10-30 22:12: one merge step of the six-member cohort compose failed on
  // every retry, the stall alarm sent the cohort to fallback and members checked
  // one at a time for about 11 minutes each.
  const f = await batchesFixture(t, { count: 4 });
  let lost = 0;
  for (let i = 0; i < 300 && f.pending().length; i++) {
    const task = f.pending()[0];
    if (
      batches(f).some(b => b.phase === 'composing' && !b.parentId) &&
      task.name.startsWith('projectConvexSource')
    ) {
      f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
      lost++;
      continue;
    }
    await f.execute(task);
    if (f.runs().length === 2) break;
  }
  assert(lost > 1, 'the cohort compose failed on every retry');
  const [parent, ...children] = batches(f);
  assert.equal(parent.phase, 'split');
  assert.deepEqual(
    children.map(b => [b.parentId, b.members.length]),
    [
      [parent.id, 2],
      [parent.id, 2],
    ],
  );
  await f.drain();
  assert.equal(f.runs().filter(r => r.status === 'queued').length, 2, 'both halves check at the same time');
  assert(states(f).every(s => !s.batchSolo));
  await settle(f);
  assert.equal(landed(f), 4);
  assert(states(f).every(s => !s.batchSolo));
});

// Convex calls and DB I/O per landing, before (admission off) and after.
async function cost(t, options, bad) {
  const f = await batchesFixture(t, options);
  if (options.admissionCheck) await settle(f, bad);
  else {
    await f.drain();
    await settle(f, bad);
  }
  const sum = key => f.counts.reduce((total, c) => total + c[key], 0);
  const n = landed(f);
  return {
    landed: n,
    runs: f.runs().length,
    auditWakes: f.auditWakes.length,
    calls: +(f.counts.length / n).toFixed(1),
    documents: Math.round(sum('documents') / n),
    readKiB: +(sum('readBytes') / n / 1024).toFixed(1),
    writeKiB: +(sum('writeBytes') / n / 1024).toFixed(1),
  };
}
test('cost per landing: E3 and a clean five-member cohort, admission off vs on', async t => {
  // Same cohort cap in every row, so only admission differs.
  const rows = {
    e3Off: await cost(t, { count: 4 }, ['member-1']),
    e3On: await cost(t, { count: 4, admissionCheck: true }, ['member-1']),
    cleanOff: await cost(t, { count: 5 }),
    cleanOn: await cost(t, { count: 5, admissionCheck: true }),
  };
  t.diagnostic(JSON.stringify(rows));
  assert.equal(rows.e3Off.landed, 3);
  assert.equal(rows.e3On.landed, 3);
  // Without admission the split isolates the named culprit: one shared check,
  // the clean cohort and the culprit alone. Admission avoids the shared failure.
  assert.equal(rows.e3Off.runs, 3);
  assert.equal(rows.e3On.runs, 5, 'four scoped admissions and one shared check');
  assert(rows.e3On.calls < rows.e3Off.calls);
  assert.equal(rows.cleanOff.runs, 1);
  // A clean cohort pays one admission per member, so the flag stays off by default.
  assert.equal(rows.cleanOn.runs, 6);
});
