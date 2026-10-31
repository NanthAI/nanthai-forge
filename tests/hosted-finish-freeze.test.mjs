// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveFixture, api } from './hosted-saves-fixture.mjs';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedLandingStateSchema } from '../dist/hosted-landing.js';

const order = await import(moduleUrl('../convex/projectHostedLandingOrder.ts'));
const wake = await import(moduleUrl('../convex/projectHostedLandingWake.ts'));
const code = value => error => (error.data?.code ?? error.code) === value;

/** A landing request row for the Lane, shaped like the 2026-10-30 cost-writer
 * incident: composed from the Lane's saved head, still pending when it is saved over. */
async function liveFinish(s, { phase = 'checking', composeStartedAt = '2026-10-30T08:00:00.000Z' } = {}) {
  const donor = await landingFixture(),
    queued = await donor.enqueue(),
    [row] = [...donor.tables.projectHostedLandingRequests.values()];
  const candidateId = randomUUID(),
    composeOperationId = randomUUID(),
    hash = s.baseline.sha256,
    pin = { sha256: hash, size: s.baseline.size };
  const manifest = count => ({ root: pin, pages: 1, count });
  s.insert('projectHostedComposeSelections', {
    projectId: s.projectId,
    actor: 'owner',
    operationId: composeOperationId,
    kind: 'inputs',
    key: s.laneId,
  });
  s.insert('projectHostedComposes', {
    projectId: s.projectId,
    actor: 'owner',
    operationId: composeOperationId,
    jobId: randomUUID(),
    value: JSON.stringify({
      request: {
        operationId: composeOperationId,
        intentId: randomUUID(),
        authorityEpoch: 1,
        expectedMain: { head: hash, receiptId: 'main-0' },
        inputs: manifest(1),
        dependencies: manifest(0),
        message: 'finish',
      },
      main: { object: pin, recipe: null },
      inputs: { next: null, pages: 1, count: 1 },
      dependencies: { next: null, pages: 1, count: 0 },
      candidateId,
      jobOperationId: randomUUID(),
      status: 'completed',
    }),
  });
  const terminal = phase === 'terminal-failed' || phase === 'landed';
  const state = {
    ...hostedLandingStateSchema.parse(JSON.parse(row.value)),
    phase,
    timing: { submittedAt: queued.at, composeStartedAt },
  };
  const { _id, _creationTime, ...fields } = row;
  void _id;
  void _creationTime;
  if (phase === 'composing') {
    // Before admission the goal lives only in the desired-state table.
    s.insert('projectHostedLandingDesired', {
      alarm: null,
      projectId: s.projectId,
      actor: 'owner',
      operationId: state.operationId,
      submissionId: state.id,
      composeOperationId,
      selectionKey: randomUUID(),
      request: '{}',
      value: JSON.stringify(state),
      wake: null,
    });
    return queued.id;
  }
  s.insert('projectHostedLandingRequests', {
    ...fields,
    alarm: null,
    projectId: s.projectId,
    candidateId,
    phase,
    runnable: false,
    value: JSON.stringify(
      terminal ? { ...state, error: { code: 'LANDING_CANCELLED', message: 'cancelled' } } : state,
    ),
  });
  return queued.id;
}
const save = (s, changes, overrides) => s.prepare(changes, overrides);

test('623efc0a replay: a changed checkpoint is refused while the Lane has a live finish, naming code and override', async () => {
  const s = await saveFixture();
  const submissionId = await liveFinish(s, { phase: 'checking' });
  await assert.rejects(
    save(s, [s.change('after finish')]),
    error =>
      code('LANE_FINISH_ACTIVE')(error) &&
      error.data.message.includes(submissionId) &&
      error.data.message.includes('supersedeFinish:true'),
  );
  // Refused before any operation exists: nothing to reconcile and no Lane write.
  assert.equal(s.tables.projectHostedSaves.size, 0);
  assert.equal(s.tables.projectHostedOperations?.size ?? 0, 0);
});

test('each live phase freezes the Lane; terminal finishes and finishes on an older head do not', async () => {
  for (const phase of ['composing', 'queued', 'checking', 'ready']) {
    const s = await saveFixture();
    await liveFinish(s, { phase });
    await assert.rejects(save(s, [s.change(phase)]), code('LANE_FINISH_ACTIVE'), phase);
  }
  for (const phase of ['terminal-failed', 'landed']) {
    const s = await saveFixture();
    await liveFinish(s, { phase });
    assert.equal((await save(s, [s.change(phase)])).result.state.status, 'staging', phase);
  }
  // Composed before the Lane's current head was written: already doomed, never blocks.
  const old = await saveFixture();
  await liveFinish(old, { composeStartedAt: '2025-01-01T00:00:00.000Z' });
  assert.equal((await save(old, [old.change('old')])).result.state.status, 'staging');
});

test('cost-builder replay: a queued finish marked wouldConflict no longer freezes the Lane, so sync and re-land replace it', async () => {
  const s = await saveFixture();
  await liveFinish(s, { phase: 'queued' });
  await assert.rejects(save(s, [s.change('sync main')]), code('LANE_FINISH_ACTIVE'));
  const row = [...s.tables.projectHostedLandingRequests.values()].find(r => r.projectId === s.projectId);
  s.patch('projectHostedLandingRequests', row._id, { wouldConflict: '{}' });
  assert.equal((await save(s, [s.change('sync main')])).result.state.status, 'staging');
});

test('an unchanged checkpoint keeps the live finish and its proof', async () => {
  const s = await saveFixture();
  await liveFinish(s, { phase: 'ready' });
  const clean = await save(s, []);
  const result = await s.submit(clean);
  assert.equal(result.outcome.status, 'completed');
  assert.equal(result.outcome.result.unchanged, true);
  assert.equal(result.outcome.result.version, 0);
  assert.equal(result.outcome.result.supersededFinish, undefined);
});

test('supersedeFinish saves explicitly and the receipt names the finish it replaced', async () => {
  const s = await saveFixture();
  const submissionId = await liveFinish(s, { phase: 'checking' });
  const x = await save(s, [s.change('explicit')], { supersedeFinish: true });
  await s.stage(x);
  await s.submit(x);
  const terminal = await s.publish(await s.work(x));
  assert.equal(terminal.outcome.status, 'completed');
  assert.equal(terminal.outcome.result.sourceVersion, 1);
  assert.equal(terminal.outcome.result.supersededFinish, submissionId);
});

test('a finish that appears while a save is in flight refuses publication and retains the delta', async () => {
  const s = await saveFixture();
  const x = await save(s, [s.change('racing')]);
  await s.stage(x);
  await s.submit(x);
  const output = await s.work(x);
  const submissionId = await liveFinish(s, { phase: 'queued' });
  const terminal = await s.publish(output);
  assert.equal(terminal.outcome.status, 'failed');
  assert.equal(terminal.outcome.error.code, 'LANE_FINISH_ACTIVE');
  assert(terminal.outcome.error.message.includes(submissionId));
  const lane = [...s.tables.projectHostedRecordHeads.values()].find(
    r => r.kind === 'lane' && r.key === s.laneId,
  );
  assert.equal(lane.version, 0);
  assert.deepEqual(await s.publish(output), terminal);
});

test('refusal costs a bounded constant number of reads and an idle Lane costs none', async () => {
  const s = await saveFixture();
  await liveFinish(s, { phase: 'checking' });
  const before = s.counts.length;
  await assert.rejects(save(s, [s.change('budget')]), code('LANE_FINISH_ACTIVE'));
  const call = s.counts.slice(before).find(c => c.name === 'prepare');
  assert(call.documents <= 40, `prepare reads ${call.documents} documents`);
  assert.equal(call.writes, 0);
  const idle = s.scheduled.length;
  assert.equal(idle, 0);
});

// ---- READY-first ordering -------------------------------------------------

const channel = f => ({ projectId: f.projectId, channel: 'main' });
const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const markReady = (f, id, overrides = {}) => {
  const row = rows(f).find(r => r.submissionId === id);
  const state = JSON.parse(row.value);
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'ready',
    runnable: true,
    value: JSON.stringify({ ...state, phase: 'ready' }),
    ...overrides,
  });
};

test('READY accepts before an urgent queued entry, and urgent still leads when nothing is READY', async () => {
  const f = await landingFixture();
  const passed = await f.enqueue();
  await f.enqueue();
  const urgent = await f.enqueue(f.request({ priority: 'urgent', agent: false }));
  assert.equal(urgent.priority, 'urgent');
  const next = () => f.run('next', ctx => order.nextLandingRow(ctx, channel(f)), {});
  assert.equal((await next()).submissionId, urgent.id, 'nothing READY: urgent leads');
  markReady(f, passed.id);
  assert.equal((await next()).submissionId, passed.id, 'a READY proof never ages behind urgent');
  // Status reads the same order: the passed proof is ahead of the urgent entry.
  assert.equal((await f.status(urgent.id)).queuePosition, 2);
});

test('READY-first holds for the queue claim, the train selector and the status read', async () => {
  const f = await landingFixture();
  const passed = await f.enqueue();
  const urgent = await f.enqueue(f.request({ priority: 'urgent', agent: false }));
  markReady(f, passed.id);
  const queue = f.queue();
  const train = await f.run('train', ctx => wake.nextTrainLandingRow(ctx, queue), {});
  assert.equal(train.submissionId, passed.id);
  const lease = await f.execute(f.nextTask(), true);
  assert.equal(lease.submissionId, passed.id);
  assert.notEqual(lease.submissionId, urgent.id);
});

test('READY entries order urgent-first among themselves and skip held or review-waiting ones', async () => {
  const f = await landingFixture();
  const a = await f.enqueue(),
    b = await f.enqueue(f.request({ priority: 'urgent', agent: false })),
    c = await f.enqueue();
  for (const entry of [a, b, c]) markReady(f, entry.id);
  const next = () => f.run('next', ctx => order.nextReadyLandingRow(ctx, channel(f)), {});
  assert.equal((await next()).submissionId, b.id, 'urgent READY leads other READY');
  const held = rows(f).find(r => r.submissionId === b.id);
  f.patch('projectHostedLandingRequests', held._id, { hold: 'main-red', runnable: false });
  assert.equal((await next()).submissionId, a.id, 'a held READY entry cannot starve the queue');
  const waiting = rows(f).find(r => r.submissionId === a.id);
  const state = JSON.parse(waiting.value);
  state.observation = { ...state.observation, pendingReason: 'waiting-for-review' };
  f.patch('projectHostedLandingRequests', waiting._id, { value: JSON.stringify(state) });
  assert.equal((await next()).submissionId, c.id);
});

test('with no READY entry selection costs one extra indexed read and schedules nothing', async () => {
  const f = await landingFixture();
  await f.enqueue();
  const before = f.metrics.scheduled;
  const row = await f.run('next', ctx => order.nextLandingRow(ctx, channel(f)), {});
  assert(row);
  const call = f.counts.at(-1);
  assert(call.ranges <= 5, `ranges ${call.ranges}`);
  assert.equal(call.writes, 0);
  assert.equal(f.metrics.scheduled, before);
});
