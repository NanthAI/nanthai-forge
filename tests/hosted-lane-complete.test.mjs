// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lifecycleFixture, code } from './hosted-lane-lifecycle-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const merged = await import(moduleUrl('../convex/projectHostedLifecycleMerged.ts'));
const pins = l => ({
  head: l.head,
  version: l.version,
  sourceVersion: l.sourceVersion,
  lifecycleVersion: l.lifecycleVersion,
});
const object = { object: { sha256: 'a'.repeat(64), size: 1 }, recipe: null };
let sequence = 0;
/** One accepted receipt whose single input page lists these Lanes at these exact pins. */
function seedReceipt(f, lanes, { enabled = false, pages = 1 } = {}) {
  const receiptId = randomUUID(),
    base = { projectId: f.projectId, receiptId };
  f.insert('projectHostedAcceptances', {
    ...base,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence: ++sequence,
    value: JSON.stringify({
      at: '2026-10-31T00:00:00.000Z',
      completion: { pages, enabled, lanes: lanes.length },
    }),
  });
  f.insert('projectHostedAcceptancePlans', {
    ...base,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    actor: 'owner',
    inputsNext: null,
    dependenciesNext: null,
    inputPages: pages,
    dependencyPages: 0,
    lanes: lanes.length,
    root: 'r'.repeat(64),
    appliedPage: 0,
    appliedEntry: 0,
  });
  for (let index = 0; index < pages; index++)
    f.insert('projectHostedAcceptancePages', {
      ...base,
      kind: 'inputs',
      index,
      digest: 'd'.repeat(64),
      root: 'r'.repeat(64),
      value: JSON.stringify({
        schema: 1,
        kind: 'forge-hosted-compose-page',
        entries: lanes.map(lane => ({ laneId: lane.id, ...pins(lane), state: object })),
        next: null,
      }),
    });
}
const sweep = async (f, actor = 'owner') => {
  const completed = [];
  let next = { sequence: 0, page: 0 },
    calls = 0;
  for (;;) {
    const step = JSON.parse(
      await f.lifeCall(
        'completeMerged',
        merged.completeMerged,
        { projectId: f.projectId, authorityEpoch: 1, ...next },
        actor,
      ),
    );
    calls++;
    completed.push(...step.completed);
    next = step.next;
    if (step.done) return { completed, calls };
  }
};

test('complete closes one active Lane, keeps its head, replays without change, and reopen restores it', async () => {
  const f = await lifecycleFixture();
  const r = f.request(null, { action: 'complete', reason: '' });
  const a = await f.begin(r);
  assert.equal(a.status, 'applied');
  assert.equal(a.action, 'complete');
  assert.equal(a.lane.state, 'completed');
  let lane = await f.read(f.laneId);
  assert.equal(lane.state, 'completed');
  assert.equal(lane.head, f.initial.head);
  assert.deepEqual(await f.begin(r), a, 'replay returns the first receipt');
  const events = (await f.history('lane', f.laneId)).page;
  assert.deepEqual(
    events.map(x => [x.from, x.to]),
    [['active', 'completed']],
  );
  await assert.rejects(
    f.begin(
      f.request({ kind: 'lane', laneId: lane.id, expected: pins(lane) }, { action: 'complete', reason: '' }),
    ),
    code('WORK_STALE'),
    'a completed Lane cannot be completed again by a new operation',
  );
  await f.begin(
    f.request({ kind: 'lane', laneId: lane.id, expected: pins(lane) }, { action: 'reopen', reason: '' }),
  );
  lane = await f.read(f.laneId);
  assert.equal(lane.state, 'active');
  assert.equal(lane.head, f.initial.head);
});

test('complete is a Lane action; an Intent target is refused', async () => {
  const f = await lifecycleFixture();
  await assert.rejects(
    f.begin(
      f.request(
        { kind: 'intent', intentId: f.intentId, version: 0, cascade: false },
        { action: 'complete', reason: '' },
      ),
    ),
    code('BAD_ARGUMENT'),
  );
});

test('complete-merged completes only Lanes whose exact landed head is still the Lane head', async () => {
  const f = await lifecycleFixture();
  const landed = await f.addLane(),
    editedAfter = await f.addLane(),
    alreadyDone = await f.addLane({ state: 'completed' }),
    selfCompleting = await f.addLane(),
    neverLanded = await f.addLane();
  seedReceipt(f, [landed, editedAfter, alreadyDone]);
  seedReceipt(f, [selfCompleting], { enabled: true });
  await f.changeLane(editedAfter.id, { head: 'e'.repeat(64), sourceVersion: 1 });
  const first = await sweep(f);
  assert.deepEqual(first.completed, [landed.id]);
  assert.equal((await f.read(landed.id)).state, 'completed');
  assert.equal((await f.read(landed.id)).head, landed.head, 'completion keeps the head');
  assert.equal((await f.read(editedAfter.id)).state, 'active');
  assert.equal((await f.read(selfCompleting.id)).state, 'active', 'enabled receipts complete on their own');
  assert.equal((await f.read(neverLanded.id)).state, 'active');
  assert.deepEqual((await sweep(f)).completed, [], 'a repeat changes nothing');
});

test('complete-merged is owner only and pages a dogfood-size sweep within the read budget', async () => {
  const f = await lifecycleFixture();
  const all = [];
  for (let i = 0; i < 150; i++) {
    const lane = await f.addLane();
    all.push(lane);
    seedReceipt(f, [lane]);
  }
  await assert.rejects(sweep(f, 'stranger'));
  const result = await sweep(f);
  assert.equal(result.completed.length, 150);
  assert.equal(new Set(result.completed).size, 150);
  // 150 receipts at 10 per call, plus the closing empty page.
  assert(result.calls <= 17, `calls ${result.calls}`);
  for (const lane of all.slice(0, 5)) assert.equal((await f.read(lane.id)).state, 'completed');
});
