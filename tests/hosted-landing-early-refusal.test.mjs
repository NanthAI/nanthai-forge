// SPDX-License-Identifier: Apache-2.0
// Early refusal (Issue 7fe54c7c; model `prequeue-early`): admitted changes whose
// Lane proofs a moved main has made stale recompose together, not one after the
// other at each turn (wave 3b, 2026-11-05: 558 -> 559 -> 560 -> 563 took 4.3
// minutes before their one cohort formed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const admission = await import(moduleUrl('../convex/projectHostedLandingAdmission.ts'));
const early = await import(moduleUrl('../convex/projectHostedLandingEarlyRefusal.ts'));
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-early-refusal',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const row = (f, id) => rows(f).find(r => r.submissionId === id);
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(r => JSON.parse(r.value));
const isLane = (f, run) =>
  f.entries.some(e =>
    [0, 1, 2].some(n => admission.admissionOperationId(e.state.id, n) === run.request.operationId),
  );
const queueRuns = f => f.runs().filter(run => !isLane(f, run));
// The same five-change wave on the serial path (early refusal disabled), measured
// on 2026-11-05: 221 transactions, 4,708 documents read, 1,682 written. Early
// refusal measured 215 / 4,585 / 1,619: each refused change still recomposes
// once, and the four serial wake-and-wait drives are gone.
const BASELINE = { transactions: 221, documentsRead: 4708, documentsWritten: 1682 };

/** `count` changes pass their Lane checks together; the first lands on its own run
 * and moves main, the rest are refused. Records when each refused change's
 * recomposition installs (its READY Lane proof gives way to a queued attempt; the
 * refusal itself starts that recomposition one backoff earlier). `stop(task, f,
 * ids)` ends the wave before that task runs. */
async function wave(t, { count = 5, batchMaxSize = null, stop = () => false } = {}) {
  const f = await batchesFixture(t, { count, batchMaxSize, admissionCheck: 'default' });
  const ids = f.entries.map(e => e.state.id);
  const t0 = Date.now();
  const refused = new Map();
  const counts = f.counts.length;
  for (let tick = 0; ; tick++) {
    assert(tick < 900, JSON.stringify(states(f).map(s => s.phase)));
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending()[0];
    if (!task || stop(task, f, ids)) break;
    const before = new Map(rows(f).map(r => [r.submissionId, r.phase]));
    await f.execute(task);
    for (const r of rows(f))
      if (before.get(r.submissionId) === 'ready' && r.phase === 'queued' && !refused.has(r.submissionId))
        refused.set(r.submissionId, Date.now() - t0);
  }
  const spent = f.counts.slice(counts);
  const budget = {
    transactions: spent.length,
    documentsRead: spent.reduce((n, c) => n + c.documents, 0),
    documentsWritten: spent.reduce((n, c) => n + c.writes, 0),
    readBytes: spent.reduce((n, c) => n + c.readBytes, 0),
    writeBytes: spent.reduce((n, c) => n + c.writeBytes, 0),
  };
  return { f, ids, t0, refused, budget };
}

test('stale Lane proofs behind a refusal recompose together into one cohort', async t => {
  const { f, ids, t0, refused, budget } = await wave(t);
  t.diagnostic(JSON.stringify({ refused: [...refused.values()], budget }));
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(queueRuns(f).length, 1, 'one combined check: no extra CI run');
  const [cohort, ...more] = batches(f);
  assert.equal(more.length, 0);
  assert.deepEqual(new Set(cohort.members.map(m => m.submissionId)), new Set(ids.slice(1)));
  // Serial refusals (each one only after the one ahead recomposed and held)
  // installed at 500, 1000, 1500, 2000 ms in this fixture; the cohort formed at
  // 2000 ms.
  const times = ids.slice(1).map(id => refused.get(id));
  assert(
    times.every(at => at !== undefined),
    'every later change was refused once',
  );
  assert.equal(Math.max(...times), Math.min(...times), 'refused in one pass, not one per recomposition');
  assert.equal(Date.parse(cohort.at) - t0, Math.max(...times), 'cohort formed as soon as all were refused');
  // No more Convex work than the serial path (BASELINE): not one more call.
  assert(budget.transactions <= BASELINE.transactions, JSON.stringify(budget));
  assert(budget.documentsWritten <= BASELINE.documentsWritten, JSON.stringify(budget));
  assert(budget.documentsRead <= BASELINE.documentsRead, JSON.stringify(budget));
  assert(
    rows(f).every(r => r.deciding === undefined && !r.orderWait),
    'no decision or wait left open',
  );
  assert.equal(f.pending().length, 0, 'idle after settling: no timers or polling');
});

test('a cohort size limit stops early refusal at the limit', async t => {
  const { f, ids, refused } = await wave(t, { batchMaxSize: 3 });
  assert(states(f).every(s => s.phase === 'landed'));
  const times = ids.slice(1).map(id => refused.get(id));
  // Positions 1-3 fit one cohort of three and are refused in one pass; the fourth
  // refused change keeps its ordinary turn.
  assert.equal(times[0], times[2], JSON.stringify(times));
  assert(times[3] > times[2], JSON.stringify(times));
  assert(queueRuns(f).length <= 2, 'at most one check per cohort');
  assert.equal(f.pending().length, 0);
});

test('early refusal only while every older entry holding order is a stale Lane proof', async t => {
  // Stop when the third change first finds the second still ahead of it on a moved main.
  const { f, ids } = await wave(t, {
    stop: (task, f, ids) =>
      task.name === 'projectHostedFinishDriver:drive' &&
      task.args[0].submissionId === ids[3] &&
      states(f)[0].phase === 'landed' &&
      [1, 2, 3].every(n => row(f, ids[n]).phase === 'ready'),
  });
  // The order claim hands over the row it waits for (the second change here).
  const check = async () =>
    f.transaction(
      'early-refusal-probe',
      {
        _handler: async ctx => {
          const r = row(f, ids[3]);
          return early.refuseStaleLaneProofNow(ctx, {
            row: r,
            state: JSON.parse(r.value),
            waitingOn: row(f, ids[2]),
          });
        },
      },
      {},
    );
  const probeReads = () => f.counts.filter(c => c.name === 'early-refusal-probe').at(-1).documents;
  assert.deepEqual(await check(), { position: 3, limit: (await check()).limit });
  const patchRow = (id, patch) => f.patch('projectHostedLandingRequests', row(f, id)._id, patch);
  const original = { ...row(f, ids[2]) };
  const restore = () => patchRow(ids[2], original);

  patchRow(ids[2], { phase: 'checking' });
  assert.equal(await check(), null, 'an older entry with a check of its own can move main first');
  assert.equal(probeReads(), 0, 'waiting behind a checking entry reads nothing');
  restore();
  patchRow(ids[2], { priority: 'urgent' });
  assert.equal(await check(), null, 'an urgent entry ahead keeps the ordinary order');
  restore();
  patchRow(ids[2], { admission: { ...original.admission, reuse: undefined } });
  assert.equal(await check(), null, 'an older entry that has not tried its own run may still land on it');
  restore();
  patchRow(ids[2], { admission: { ...original.admission, hold: { since: 0, taskId: 'x' } } });
  assert.equal(await check(), null, 'a peer that held before this admission ended may form without it');
  restore();
  const queue = [...f.tables.projectHostedLandingQueues.values()][0];
  f.patch('projectHostedLandingQueues', queue._id, { train: [...(queue.train ?? []), ids[4]] });
  assert.equal(await check(), null, 'a retained group can move main first');
  f.patch('projectHostedLandingQueues', queue._id, { train: queue.train });
  const self = { ...row(f, ids[3]) };
  patchRow(ids[3], { batchSelection: undefined });
  assert.equal(await check(), null, 'only a change that can join a cohort');
  patchRow(ids[3], self);
  assert.notEqual(await check(), null, 'restored');
});
