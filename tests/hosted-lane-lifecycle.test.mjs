// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  lifecycleFixture,
  api,
  records,
  lanes,
  cascade,
  code,
  maxima,
} from './hosted-lane-lifecycle-fixture.mjs';
import { checksFixture } from './hosted-checks-fixture.mjs';
const pins = l => ({
  head: l.head,
  version: l.version,
  sourceVersion: l.sourceVersion,
  lifecycleVersion: l.lifecycleVersion,
});
test('abandon/reopen retain exact source, saves, actor/reason/history; replay never rewinds newer work', async () => {
  const f = await lifecycleFixture(),
    before = structuredClone(f.tables.projectObjects);
  const r = f.request(),
    a = await f.begin(r);
  assert.equal(a.status, 'applied');
  assert.equal(a.cancellation, 'not-requested');
  let l = await f.read(f.laneId);
  assert.equal(l.head, f.initial.head);
  assert.equal(l.state, 'abandoned');
  assert.equal(l.lifecycleVersion, 1);
  const reopen = f.request(
    { kind: 'lane', laneId: l.id, expected: pins(l) },
    { action: 'reopen', reason: '' },
  );
  await f.begin(reopen);
  l = await f.read(l.id);
  assert.equal(l.state, 'active');
  assert.equal(l.lifecycleVersion, 2);
  const newer = await f.changeLane(l.id, { head: 'd'.repeat(64), sourceVersion: 1 });
  assert.deepEqual(await f.begin(r), a);
  assert.deepEqual(await f.read(l.id), newer);
  assert.deepEqual(f.tables.projectObjects, before);
  const events = (await f.history('lane', l.id)).page;
  assert.equal(events.length, 2);
  assert.equal(events[0].reason, r.reason);
  assert.equal(events[0].actor, 'owner');
  assert.deepEqual(
    events.map(x => [x.from, x.to]),
    [
      ['active', 'abandoned'],
      ['abandoned', 'active'],
    ],
  );
  await assert.rejects(f.begin({ ...r, reason: 'changed' }), code('WORK_OPERATION_CHANGED'));
});
test('known dirty client requires the retained exact save-first child, whose completion wakes abandonment without a client', async () => {
  const f = await lifecycleFixture(),
    target = { kind: 'lane', laneId: f.laneId, expected: f.expected, dirty: true };
  await assert.rejects(f.begin(f.request(target)), code('LANE_DIRTY'));
  await assert.rejects(f.begin(f.request({ ...target, saveOperationId: randomUUID() })), code('NOT_FOUND'));
  const x = await f.prepare([f.change()]);
  await f.stage(x);
  await f.submit(x);
  const r = f.request({ ...target, saveOperationId: x.request.operationId });
  assert.equal((await f.begin(r)).status, 'pending');
  assert.equal(f.pending().length, 0, 'pending child installs no idle poller');
  const out = await f.work(x),
    terminal = await f.publish(out),
    result = terminal.outcome.result;
  await f.drain();
  const a = await f.begin(r);
  assert.equal(a.status, 'applied');
  assert.equal(a.saveOperationId, x.request.operationId);
  assert.equal(a.lane.head, result.head);
  assert.equal((await f.read(f.laneId)).state, 'abandoned');
  await assert.rejects(
    f.begin(
      f.request({
        ...target,
        expected: pins(await f.read(f.laneId)),
        saveOperationId: x.request.operationId,
      }),
    ),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal([...f.tables.projectHostedRecordHeads.values()].filter(r => r.kind === 'save').length, 1);
  assert(f.objects.has(result.head));
  assert(f.objects.has(f.baseline.sha256));
});
test('cascade visibility is all-or-nothing before projection; exact historical versions and sibling pages agree', async () => {
  const f = await lifecycleFixture();
  const children = [f.initial];
  for (let i = 0; i < 44; i++) children.push(await f.addLane());
  const closed = await f.addLane({ state: 'completed' }),
    unrelated = await f.addLane({ intentId: randomUUID() });
  const r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  assert.equal((await f.begin(r)).status, 'pending');
  for (let i = 0; i < 3; i++) {
    await f.advance(r);
    assert.equal((await f.read(f.laneId)).state, 'active');
    assert.equal((await f.history('lane', f.laneId)).page.length, 0);
  }
  const p = f.plan(r);
  assert(p.ready);
  assert.equal(p.staged, 45);
  const result = await f.lifeRun('lifecycleFinal', cascade.advanceLifecycle, p);
  assert.equal(result.status, 'applied');
  const final = f.counts.at(-1);
  assert(final.ranges < 35 && final.documents < 35);
  assert(
    !final.touched.some(t => ['projectHostedLifecycleEvents', 'projectHostedLifecyclePointers'].includes(t)),
    'no final child ledger reads',
  );
  for (const child of children) {
    const l = await f.read(child.id);
    assert.equal(l.state, 'abandoned');
    assert.equal(l.head, child.head);
    const old = await f.lifeRun('lifecycleVersion', records.readHostedRecord, {
      ...f.auth,
      kind: 'lane',
      key: l.id,
      version: 0,
    });
    assert.equal(JSON.parse(old.value).state, 'active');
    const saved = await f.lifeRun('lifecycleVersion', records.readHostedRecord, {
      ...f.auth,
      kind: 'lane',
      key: l.id,
      version: 1,
    });
    assert.equal(JSON.parse(saved.value).state, 'abandoned');
  }
  const siblings = await f.lifeCall('lifecycleSiblings', lanes.siblings, {
    projectId: f.projectId,
    intentId: f.intentId,
    cursor: null,
  });
  assert.equal(siblings.page.filter(l => l.state === 'abandoned').length, 45);
  assert.equal((await f.read(closed.id)).state, 'completed');
  assert.equal((await f.read(unrelated.id)).state, 'active');
  await f.drain();
  assert(f.plan(r).materialized);
  assert.equal(f.pending().length, 0);
  assert.equal((await f.begin(r)).status, 'applied');
  assert.equal(f.pending().length, 0);
});
test('a concurrent source save invalidates every staged child; saved bytes remain retained', async () => {
  const f = await lifecycleFixture();
  await f.addLane();
  const r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  await f.begin(r);
  await f.advance(r);
  const x = await f.prepare([f.change('save wins')]);
  await f.stage(x);
  await f.submit(x);
  const out = await f.work(x);
  const saved = await f.publish(out);
  assert.equal(saved.outcome.status, 'completed');
  assert.equal((await f.advance(r)).status, 'stale');
  assert.equal((await f.read(f.laneId)).state, 'active');
  assert.equal((await f.read(f.laneId)).head, out.head);
  assert.equal((await f.history('lane', f.laneId)).page.length, 0);
  assert.equal((await f.history('intent', f.intentId)).page.length, 0);
});
test('a save prepared before applied cascade is stale; reopen then save uses promoted lifecycle version', async () => {
  const f = await lifecycleFixture();
  const x = await f.prepare([f.change()]);
  await f.stage(x);
  await f.submit(x);
  const out = await f.work(x);
  const r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  await f.begin(r);
  await f.advance(r);
  await f.advance(r);
  assert.equal((await f.publish(out)).outcome.error.code, 'WORK_STALE');
  const old = await f.read(f.laneId);
  await f.begin(f.request({ kind: 'lane', laneId: old.id, expected: pins(old) }, { action: 'reopen' }));
  const opened = await f.read(old.id),
    next = await f.prepare([f.change('after reopen')], { expected: pins(opened) });
  await f.stage(next);
  await f.submit(next);
  const n = await f.work(next);
  assert.equal((await f.publish(n)).outcome.status, 'completed');
  assert.equal((await f.read(old.id)).state, 'active');
  await f.drain();
});
test('new siblings, lifecycle changes and simultaneous cascades invalidate a staged selection without partial state', async () => {
  for (const change of ['start', 'reopen', 'competing']) {
    const f = await lifecycleFixture(),
      r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
    await f.begin(r);
    await f.advance(r);
    if (change === 'start') await f.addLane();
    if (change === 'reopen') await f.begin(f.request(null, { action: 'reopen' }));
    if (change === 'competing') await f.begin(f.request(r.target));
    assert.equal((await f.advance(r)).status, 'stale');
    assert.equal((await f.read(f.laneId)).state, 'active');
  }
});
test('reopen Intent does not reopen independently abandoned or completed children', async () => {
  const f = await lifecycleFixture(),
    r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  await f.begin(r);
  await f.drain();
  await f.begin(
    f.request({ kind: 'intent', intentId: f.intentId, version: 1, cascade: false }, { action: 'reopen' }),
  );
  assert.equal((await f.read(f.laneId)).state, 'abandoned');
  assert.equal((await f.history('intent', f.intentId)).page.at(-1).to, 'active');
});
test('current write authority and epoch are checked per page/final; readers can read retained lifecycle events', async () => {
  const f = await lifecycleFixture(),
    grant = f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  const r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  await f.begin(r, 'contributor');
  f.tables.projectContributors.delete(grant);
  const p = f.plan(r);
  await assert.rejects(
    f.lifeRun('lifecycleRevoked', cascade.advanceLifecycle, p),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal((await f.read(f.laneId)).state, 'active');
  await assert.rejects(f.begin(f.request(), 'stranger'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(f.begin(f.request(), null), code('PROJECT_UNAVAILABLE'));
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(
    f.lifeRun('lifecycleEpoch', cascade.advanceLifecycle, p),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  const a = f.request();
  await f.begin(a);
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  assert.equal((await f.history('lane', f.laneId, null, 'reader')).page.length, 1);
  await assert.rejects(f.begin(f.request(), 'reader'), code('PROJECT_UNAVAILABLE'));
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  assert.equal((await f.begin(a)).status, 'applied');
});
test('scheduler failure rolls back preparation; stopped tasks resume original pages and no terminal idle work is scheduled', async () => {
  const f = await lifecycleFixture(),
    r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  f.schedulerFailure(true);
  await assert.rejects(f.begin(r), code('HOSTED_REQUEST_FAILED'));
  assert.equal(f.plan(r), undefined);
  f.schedulerFailure(false);
  await f.begin(r);
  await f.execute();
  const original = f.plan(r);
  f.schedulerFailure(true);
  await assert.rejects(f.advance(r), code('HOSTED_REQUEST_FAILED'));
  assert.equal(f.plan(r).status, 'pending');
  assert.equal((await f.read(f.laneId)).state, 'active');
  f.schedulerFailure(false);
  await f.begin(r);
  await f.drain();
  assert.equal(f.plan(r).receiptId, original.receiptId);
  assert.equal(f.plan(r).status, 'applied');
  assert.equal(f.pending().length, 0);
  await f.begin(r);
  await f.advance(r);
  assert.equal(f.pending().length, 0);
});
test('abandonment leaves a running check unchanged; cancellation is separately requested and provider-acknowledged', async () => {
  const f = await lifecycleFixture();
  const candidate = {
    kind: 'candidate',
    id: randomUUID(),
    intentId: f.intentId,
    version: 0,
    at: f.initial.at,
    base: f.initial.base,
    inputs: f.put('inputs'),
    dependencies: f.put('dependencies'),
    algorithm: 'synthetic',
    result: { status: 'clean', head: f.baseline.sha256 },
  };
  await f.run('seedCandidate', (ctx, input) => records.writeHostedRecord(ctx, input), {
    ...f.auth,
    record: candidate,
    expectedVersion: null,
  });
  f.insert('projectHostedStates', {
    projectId: f.projectId,
    head: f.baseline.sha256,
    size: f.baseline.size,
    input: 'a'.repeat(64),
    jobId: randomUUID(),
    output: 'b'.repeat(64),
  });
  const c = await checksFixture({
    store: { ...f, call: f.transaction },
    projectId: f.projectId,
    candidate,
    state: f.baseline,
  });
  const run = await c.enqueue(c.selection()),
    active = await c.activate(run.id);
  const before = structuredClone(f.tables.projectHostedCheckRuns);
  await f.begin(f.request());
  assert.deepEqual(f.tables.projectHostedCheckRuns, before);
  const cancelled = await c.cancel(run.id);
  assert(cancelled.cancelRequested);
  assert.equal(cancelled.endedAt, null);
  assert.equal(cancelled.status, active.status);
  await c.callback(c.complete(active, 'cancelled'));
  assert.equal((await c.status(run.id)).status, 'cancelled');
});
test.after(() => console.log('H16 fake maxima', JSON.stringify(maxima)));

test('real overlapping save/final transactions have one CAS winner and preserve both source histories', async () => {
  const f = await lifecycleFixture();
  const x = await f.prepare([f.change('concurrent bytes')]);
  await f.stage(x);
  await f.submit(x);
  const out = await f.work(x);
  const r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  await f.begin(r);
  await f.advance(r);
  const [cascadeResult, saveResult] = await Promise.all([f.advance(r), f.publish(out)]);
  const lane = await f.read(f.laneId);
  if (saveResult.outcome.status === 'completed') {
    assert.equal(cascadeResult.status, 'stale');
    assert.equal(lane.state, 'active');
    assert.equal(lane.head, out.head);
  } else {
    assert.equal(saveResult.outcome.error.code, 'WORK_STALE');
    assert.equal(cascadeResult.status, 'applied');
    assert.equal(lane.state, 'abandoned');
    assert.equal(lane.head, f.baseline.sha256);
  }
  assert(f.objects.has(out.head));
  assert(f.objects.has(f.baseline.sha256));
});

test('missing applied marker is an explicit availability error, never an older lifecycle fallback', async () => {
  const f = await lifecycleFixture(),
    r = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  await f.begin(r);
  await f.advance(r);
  await f.advance(r);
  assert.equal((await f.read(f.laneId)).state, 'abandoned');
  f.tables.projectHostedLifecyclePlans.delete(f.plan(r)._id);
  await assert.rejects(f.read(f.laneId), code('SOURCE_UNAVAILABLE'));
});
