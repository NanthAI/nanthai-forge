// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const view = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** 09e637f7 minimal slice: one bounded read answers who is in the queue, in
 * which phase, what failed last and how often each entry recomposed. */
test('queue view: one bounded read lists entries with Lane, Intent, phase, failing tests and recompose count', async t => {
  const f = await batchesFixture(t, { count: 3, batching: false, requestCheck: true });
  const read = async limit =>
    JSON.parse(
      await f.c.run('queueView', view.read, { projectId: f.projectId, ...(limit ? { limit } : {}) }),
    );
  // Drive until every entry has a check run, then fail the first one once.
  for (let i = 0; i < 400 && f.runs().length < 3; i++) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall'));
    if (!task) break;
    await f.execute(task);
  }
  // Item ecd6e610: while checks run, each checking entry carries its check's start (the run's reservation) and the
  // reply carries the project's usual check times, null here because no landing has settled yet.
  let running = await read();
  // The queue's next wake sees each reserved run and moves its landing to checking, stamping the reservation.
  for (let i = 0; i < 400 && !running.entries.some(entry => entry.phase === 'checking'); i++) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall'));
    if (!task) break;
    await f.execute(task);
    running = await read();
  }
  const checking = running.entries.filter(entry => entry.phase === 'checking');
  assert(checking.length >= 1, JSON.stringify(running.entries.map(entry => entry.phase)));
  const reserved = new Set(f.runs().map(run => run.at));
  for (const entry of checking) assert(reserved.has(entry.checkStartedAt), JSON.stringify(entry));
  assert.equal(running.usualCheck, null);
  const first = f.runs()[0];
  await f.fail(first.id, 'tests/member-0.test.mjs');
  const before = await read();
  assert.equal(before.listed, before.entries.length);
  assert(before.entries.length >= 1, JSON.stringify(before));
  for (const entry of before.entries) {
    assert.match(entry.submissionId, /^[0-9a-f-]{36}$/);
    assert(entry.laneId, 'each entry names its Lane');
    assert.equal(typeof entry.intentTitle === 'string' || entry.intentTitle === null, true);
    assert(['composing', 'queued', 'checking', 'ready', 'landed', 'terminal-failed'].includes(entry.phase));
    assert(Number.isInteger(entry.recomposeCount) && entry.recomposeCount >= 0);
    assert(Array.isArray(entry.lastFailingTests));
    // Item ecd6e610: only a checking entry carries its check's start, as an ISO time.
    if (entry.checkStartedAt !== undefined) {
      assert.equal(entry.phase, 'checking');
      assert.equal(new Date(entry.checkStartedAt).toISOString(), entry.checkStartedAt);
    }
  }
  // The usual check times come with a checking entry only (one more indexed read); none reported here yet.
  if (before.entries.some(entry => entry.checkStartedAt)) assert.equal(before.usualCheck, null);
  else assert.equal('usualCheck' in before, false);
  // Positions come back in dispatch order and the limit bounds the listing.
  const positions = before.entries.map(e => e.position ?? Infinity);
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  const one = await read(1);
  assert(one.entries.length <= 1);
  assert.equal(one.more, one.total > one.entries.length);
  // The view reads only; nothing is scheduled or written by it.
  const pending = f.pending().length;
  const snapshot = JSON.stringify(states(f));
  await read();
  assert.equal(f.pending().length, pending);
  assert.equal(JSON.stringify(states(f)), snapshot);
});

const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;
/** Core-claim incident 43b51a5e (2026-11-19): 9 passed entries parked behind an older submission
 * read "Landing: The check passed; it is being accepted into main" in the queue view for up to 80 min,
 * while observe said they waited for order. A Ready row with an order wait names the older one. */
test('queue view 43b51a5e: a passed entry parked behind an older one says it waits for it, never "being accepted"', async t => {
  const f = await batchesFixture(t, { count: 2, batching: false, requestCheck: true });
  const [older, newer] = f.entries.map(entry => entry.state);
  let seen = null;
  for (let tick = 0; tick < 400 && !seen; tick++) {
    if ([...f.tables.projectHostedLandingRequests.values()].some(row => row.orderWait))
      seen = JSON.parse(await f.c.run('queueView', view.read, { projectId: f.projectId }));
    for (const run of f.runs().filter(run => run.status === 'queued'))
      // The older check stays running until the newer one has passed and parked.
      if (runOwner(f, run) !== older.id) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall'));
    if (!task) break;
    if (!seen) await f.execute(task);
  }
  assert(seen, 'the newer passed entry parked behind the older one');
  const parked = seen.entries.find(entry => entry.submissionId === newer.id);
  assert.equal(parked.phase, 'ready');
  assert.equal(parked.landingState.state, 'waiting-for-order');
  assert.equal(parked.landingState.label, 'Waiting for an older landing');
  assert.doesNotMatch(parked.landingState.nextStep, /being accepted into main/);
  assert.match(parked.landingState.nextStep, new RegExp(`older submission ${older.id}`));
  const ahead = seen.entries.find(entry => entry.submissionId === older.id);
  assert.notEqual(ahead.landingState.state, 'waiting-for-order', 'the entry it waits for is not parked');
});
