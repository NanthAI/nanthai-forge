// SPDX-License-Identifier: Apache-2.0
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
  }
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
