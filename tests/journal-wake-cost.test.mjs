// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { journalMaintenanceFixture } from './journal-maintenance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

for (const dogfood of [false, true])
  test(`journal ${dogfood ? 'dogfood' : 'fresh'} deferred 60-wake mix archives 17 frontiers and skips 43 empty captures`, async t => {
    const w = await journalMaintenanceFixture(t);
    await w.drain();
    // A retained coordination history stays live. The dogfood-shaped case has
    // a much larger protected history; its cursor must not reread that history.
    for (let n = 0; n < (dogfood ? 1200 : 12); n++)
      await w.insert('projectCoordinationEvents', {
        projectId: w.f.projectId,
        actor: 'owner',
        operationId: randomUUID(),
        at: Date.now(),
        command: { kind: 'message', text: 'Retained message '.repeat(dogfood ? 60 : 1), context: {} },
      });
    w.f.advanceClock(15 * 86_400_000);
    await w.drain({ ...w.input, operationId: randomUUID(), phase: 4 });
    const start = w.io.length,
      rowCounts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24, 32, 40, 54];
    let actions = 0,
      productive = 0,
      empty = 0,
      archived = 0,
      sampledRss = 0,
      wallMs = 0;
    for (let n = 0; n < 60; n++) {
      // Spread productive batches across the window, including both endpoints.
      const batch = n % 3 === 0 && productive < rowCounts.length ? rowCounts[productive] : 0;
      for (let k = 0; k < batch; k++)
        await w.insert('projectCoordinationEvents', {
          projectId: w.f.projectId,
          actor: 'owner',
          operationId: randomUUID(),
          at: Date.now(),
          command: { kind: 'change', source: 'work' },
        });
      if (batch) {
        productive++;
        w.f.advanceClock(15 * 86_400_000);
      }
      const results = await w.drain({ projectId: w.f.projectId, operationId: randomUUID(), phase: 4 });
      actions += results.length;
      for (const result of results) {
        sampledRss = Math.max(sampledRss, result.metrics.sampledRss);
        wallMs += result.metrics.wallMs;
      }
      const count = results.reduce((sum, result) => sum + (result.archived ?? 0), 0);
      archived += count;
      if (!count) empty++;
      assert.equal(count, batch, 'every eligible row archives once, including overlapping old wakes');
    }
    const io = w.io.slice(start);
    const measured = {
      actions,
      mutations: io.length,
      readBytes: io.reduce((sum, row) => sum + row.readBytes, 0),
      writeBytes: io.reduce((sum, row) => sum + row.writeBytes, 0),
      readDocuments: io.reduce((sum, row) => sum + row.documents, 0),
      readRanges: io.reduce((sum, row) => sum + row.reads, 0),
      writes: io.reduce((sum, row) => sum + row.writes, 0),
      archived,
      productive,
      empty,
      retainedMessages: w.f.tables.projectCoordinationEvents.size,
      sampledRss,
      wallMs,
    };
    t.diagnostic(JSON.stringify(measured));
    assert.equal(measured.actions, 60, 'no added action, timer or retry in the observed mix');
    assert.equal(measured.mutations, 77, '43 empty frontiers never call publication');
    assert.equal(measured.readDocuments, 1534, 'no added per-row or supersession reads');
    assert(measured.readBytes <= (dogfood ? 420000 : 418000), 'empty publication read bytes stay removed');
    assert(measured.writes <= 668, 'empty frontiers create no capture lease or pending pointer');
    assert.equal(productive, 17);
    assert.equal(empty, 43);
    assert.equal(w.f.tables.projectCoordinationEvents.size, dogfood ? 1200 : 12);
    assert.equal(w.queue.length, 0, 'finite frontier leaves no periodic work');
  });

test('legacy no-op wakes skip capture leases, source reloads, publication and archive I/O', async t => {
  const w = await journalMaintenanceFixture(t);
  await w.drain();
  const start = w.io.length,
    objects = w.requests.length;
  const results = await w.drain({ projectId: w.f.projectId, operationId: `work:${randomUUID()}` });
  const io = w.io.slice(start);
  assert.equal(results.length, 5, 'legacy default phase still drains every source family');
  assert.equal(io.length, 5, 'one mutation per empty phase, without a full capture/publish pair');
  assert(io.every(row => row.name === 'projectJournalCapture:page'));
  assert(
    io.every(row => row.controlWrites <= 1),
    'no empty capture lease or pending project claim',
  );
  assert.equal(w.requests.length, objects, 'no GET or PUT for empty frontiers');
  assert(results.every(result => result.archived === 0 && result.segments === 0));
  const replay = w.io.length;
  await w.pack({ projectId: w.f.projectId, operationId: results[0].next.operationId });
  assert(w.io[replay].documents <= 2, 'a taken page replays before project, source and archive reads');
});

test('journal idle project schedules no pack, and a burst of writes leaves one pending pack per project (686ecdde Fix 2)', async t => {
  const w = await journalMaintenanceFixture(t);
  const wake = await import(moduleUrl('../convex/projectJournalWake.ts'));
  const pending = () =>
    [...w.f.tables._scheduled_functions.values()].filter(
      row => row.name === 'projectJournalRun:pack' && row.state.kind === 'pending',
    );
  // Run each scheduled drain at its time, as the scheduler would; return how many ran.
  const runScheduled = async () => {
    let runs = 0;
    for (; pending().length; runs++) {
      assert(runs < 10, 'finite frontier drains in a few scheduled packs');
      const [job] = pending().sort((a, b) => a.scheduledTime - b.scheduledTime);
      w.f.advanceClock(Math.max(0, job.scheduledTime - w.f.now()));
      await w.mutate(ctx => ctx.db.patch(job._id, { state: { kind: 'success' } }));
      await w.drain(job.args[0]);
    }
    return runs;
  };
  await w.drain();
  await runScheduled();
  // Nothing lands for 30 days: no pack is pending and an idle drain schedules none.
  w.f.advanceClock(30 * 86_400_000);
  assert.equal(pending().length, 0, 'an idle project has no scheduled journal pack');
  const scheduled = w.f.tables._scheduled_functions.size;
  const idle = await w.drain({ projectId: w.f.projectId, operationId: randomUUID() });
  assert(idle.every(result => result.archived === 0));
  assert.equal(w.f.tables._scheduled_functions.size, scheduled, 'an empty drain schedules nothing');
  assert.equal(w.queue.length, 0);

  // A burst of 20 writes, each with the wake its write path sends.
  const events = [];
  for (let n = 0; n < 20; n++) {
    events.push(
      await w.insert('projectCoordinationEvents', {
        projectId: w.f.projectId,
        actor: 'owner',
        operationId: randomUUID(),
        at: w.f.now(),
        command: { kind: 'change', source: 'work' },
      }),
    );
    await w.mutate(ctx =>
      wake.wakeJournal(
        ctx,
        { projectId: w.f.projectId, operationId: randomUUID(), phase: 4 },
        w.f.now() + 14 * 86_400_000 + 1,
      ),
    );
    await w.mutate(ctx =>
      wake.wakeJournal(
        ctx,
        { projectId: w.f.projectId, operationId: `work:${randomUUID()}` },
        w.f.now() + wake.journalGraceMs,
      ),
    );
    w.f.advanceClock(60_000);
  }
  assert.equal(pending().length, 1, '40 wakes leave one pending pack');
  const [later] = pending();
  // An earlier wake replaces the pending pack rather than adding one.
  await w.mutate(ctx =>
    wake.wakeJournal(
      ctx,
      { projectId: w.f.projectId, operationId: `recovery:${randomUUID()}`, phase: 1 },
      w.f.now(),
    ),
  );
  assert.equal(pending().length, 1);
  assert(pending()[0].scheduledTime <= w.f.now() + wake.journalDrainBucketMs);
  assert.equal(w.f.tables._scheduled_functions.get(later._id).state.kind, 'canceled');
  const runs = await runScheduled();
  assert(runs <= 4, `the burst drains in ${runs} scheduled packs, not one per write`);
  assert(
    events.every(id => !w.f.tables.projectCoordinationEvents.has(id)),
    'every aged event archives',
  );
  assert.equal(pending().length, 0, 'nothing stays scheduled after the frontier drains');
  t.diagnostic(JSON.stringify({ wakes: 41, scheduledPacks: runs }));
});
