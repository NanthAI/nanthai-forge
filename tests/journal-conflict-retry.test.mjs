// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { journalMaintenanceFixture } from './journal-maintenance-fixture.mjs';

function rewind(w, before) {
  for (const [name, rows] of Object.entries(before)) {
    w.f.tables[name].clear();
    for (const [id, row] of rows) w.f.tables[name].set(id, row);
  }
  w.objects.clear();
  for (const name of ['calls', 'requests', 'transcript', 'io', 'queue', 'delays']) w[name].length = 0;
}
for (const stage of ['Capture', 'Publish'])
  test(`journal ${stage.toLowerCase()} write conflict resumes the same page and completes the original segments`, async t => {
    const w = await journalMaintenanceFixture(t);
    const before = structuredClone(w.f.tables);
    const baseline = await w.drain();
    const expected = [...w.objects.keys()].sort();
    const calls = w.calls.length;
    const puts = w.requests.filter(method => method === 'PUT').length;
    const gets = w.requests.filter(method => method === 'GET').length;
    rewind(w, before);
    w.conflict(`projectJournal${stage}:page`);
    const results = await w.drain();
    assert.deepEqual([...w.objects.keys()].sort(), expected);
    assert.equal(w.requests.filter(method => method === 'PUT').length, puts);
    assert.equal(w.requests.filter(method => method === 'GET').length, gets + (stage === 'Publish' ? 1 : 0));
    assert.equal(w.calls.length, calls + (stage === 'Capture' ? 1 : 2));
    assert.equal(results.length, baseline.length + 1);
    assert.equal(w.queue.length, 0, 'finite retry chain leaves no idle work');
    assert(w.delays.some(delay => delay >= 250 && delay < 500));
    t.diagnostic(
      JSON.stringify({
        stage,
        baselineMutations: calls,
        mutations: w.calls.length,
        baselineActions: baseline.length,
        actions: results.length,
        puts,
        segments: expected.length,
      }),
    );
  });

test('concurrent project wakes in different phases defer through one pending capture before any control write', async t => {
  const w = await journalMaintenanceFixture(t);
  let captured, release;
  const ready = new Promise(resolve => {
    captured = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const invoke = w.ctx.runMutation;
  t.mock.method(w.ctx, 'runMutation', async (ref, args) => {
    const value = await invoke(ref, args);
    if (getFunctionName(ref) === 'projectJournalCapture:page' && args.operationId === w.input.operationId) {
      captured();
      await gate;
    }
    return value;
  });
  const first = w.pack();
  await ready;
  try {
    const second = await w.pack({ ...w.input, phase: 1, operationId: randomUUID() });
    assert.equal(second.deferred, 'claimed');
    assert.equal(w.io.filter(row => row.name === 'projectJournalCapture:page').at(-1).writes, 0);
    assert.equal(
      [...w.f.tables.projectJournalReceipts.values()].filter(
        row => row.operationId.startsWith('journal-control:') && JSON.parse(row.envelope).pending,
      ).length,
      1,
    );
  } finally {
    release();
    await first;
  }
  await w.drain();
  assert.equal(w.queue.length, 0, 'deferred work and the original frontier both finish');
  assert([...w.f.tables.projectJournalReceipts.values()].every(row => row.operationId !== 'journal-pending'));
});

test('structured hosted contention resumes without depending on provider error prose', async t => {
  const w = await journalMaintenanceFixture(t);
  const invoke = w.ctx.runMutation;
  let failed = false;
  t.mock.method(w.ctx, 'runMutation', async (ref, args) => {
    if (!failed) {
      failed = true;
      throw new ConvexError({ code: 'HOSTED_CONFLICT', message: 'Synthetic contention' });
    }
    return invoke(ref, args);
  });
  await w.drain();
  assert.equal(w.queue.length, 0);
  assert(w.objects.size > 0);
  assert.equal(w.delays.filter(delay => delay > 0).length, 1);
});

test('journal conflict retries stop after four scheduled resumptions without leaving idle work', async t => {
  const w = await journalMaintenanceFixture(t);
  w.conflict('projectJournalCapture:page', 5);
  await assert.rejects(w.drain(), /write conflict/);
  assert.equal(w.calls.length, 5);
  assert.equal(w.delays.length, 4);
  assert(w.delays.every((delay, n) => delay >= 250 * 2 ** n && delay < 250 * 2 ** n + 250));
  assert.equal(w.queue.length, 0);
  assert.equal(w.objects.size, 0);
  assert.equal(w.f.tables.projectJournalSegments.size, 0, 'all conflicted capture writes rolled back');
});

test('journal integrity failures are surfaced without scheduling a conflict retry', async t => {
  const w = await journalMaintenanceFixture(t);
  const failure = new Error('Synthetic archive integrity failure');
  t.mock.method(w.ctx, 'runMutation', async () => {
    throw failure;
  });
  await assert.rejects(w.pack(), error => error === failure);
  assert.equal(w.queue.length, 0);
});

test('simultaneous captures in distinct project phases commit only one pending claim under OCC', async t => {
  const w = await journalMaintenanceFixture(t);
  const { makeFunctionReference } = await import('convex/server');
  const ref = makeFunctionReference('projectJournalCapture:page');
  const replies = await Promise.all(
    [0, 1].map(phase =>
      w.ctx
        .runMutation(ref, { ...w.input, operationId: randomUUID(), phase, claim: randomUUID() })
        .then(JSON.parse),
    ),
  );
  assert.equal(replies.filter(reply => reply.texts).length, 1);
  assert.equal(replies.filter(reply => reply.deferred === 'claimed').length, 1);
  assert.equal(
    [...w.f.tables.projectJournalReceipts.values()].filter(row => row.operationId === 'journal-pending')
      .length,
    1,
  );
  assert(
    w.f.c.counts.some(row => row.name === 'journalWriterPage' && row.retries > 0),
    'absent project claim participates in OCC',
  );
});
