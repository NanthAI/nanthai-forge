// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lifecycleFixture, lanes, code } from './hosted-lane-lifecycle-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { gcNestedLanes } from '../dist/client-cache-gc.js';
import { laneHousekeeping } from '../dist/lane-prune.js';
import { listLanes, readLaneEntry, recordLane } from '../dist/lane-registry.js';

const pinApi = await import(moduleUrl('../convex/projectHostedLanePin.ts'));
const merged = await import(moduleUrl('../convex/projectHostedLifecycleMerged.ts'));
const pins = l => ({
  head: l.head,
  version: l.version,
  sourceVersion: l.sourceVersion,
  lifecycleVersion: l.lifecycleVersion,
});
const hour = 3_600_000;
const object = { object: { sha256: 'a'.repeat(64), size: 1 }, recipe: null };
let sequence = 0;
/** One accepted receipt (completeOnAccept off) whose single input page lists these Lanes at their pins. */
function seedReceipt(f, list) {
  const receiptId = randomUUID(),
    base = { projectId: f.projectId, receiptId };
  f.insert('projectHostedAcceptances', {
    ...base,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence: ++sequence,
    value: JSON.stringify({
      at: '2026-10-31T00:00:00.000Z',
      completion: { pages: 1, enabled: false, lanes: list.length },
    }),
  });
  f.insert('projectHostedAcceptancePlans', {
    ...base,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    actor: 'owner',
    inputsNext: null,
    dependenciesNext: null,
    inputPages: 1,
    dependencyPages: 0,
    lanes: list.length,
    root: 'r'.repeat(64),
    appliedPage: 0,
    appliedEntry: 0,
  });
  f.insert('projectHostedAcceptancePages', {
    ...base,
    kind: 'inputs',
    index: 0,
    digest: 'd'.repeat(64),
    root: 'r'.repeat(64),
    value: JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-compose-page',
      entries: list.map(lane => ({ laneId: lane.id, ...pins(lane), state: object })),
      next: null,
    }),
  });
}
const setPin = async (f, laneId, pinned, actor = 'owner') =>
  JSON.parse(
    await f.lifeCall(
      'setPin',
      pinApi.setPin,
      { projectId: f.projectId, authorityEpoch: 1, laneId, pinned },
      actor,
    ),
  );
const sweep = async f => {
  const completed = [];
  let next = { sequence: 0, page: 0 };
  for (;;) {
    const step = JSON.parse(
      await f.lifeCall('completeMerged', merged.completeMerged, {
        projectId: f.projectId,
        authorityEpoch: 1,
        ...next,
      }),
    );
    completed.push(...step.completed);
    next = step.next;
    if (step.done) return completed;
  }
};
const states = (f, ids) => f.lifeCall('states', lanes.states, { projectId: f.projectId, laneIds: ids });

test('pin is one owner-only field: idempotent, readable from the head row, clearable, any Lane state', async () => {
  const f = await lifecycleFixture();
  const lane = await f.addLane(),
    done = await f.addLane({ state: 'completed' });
  await assert.rejects(setPin(f, lane.id, true, 'stranger'));
  const first = await setPin(f, lane.id, true);
  assert.deepEqual(
    [first.pinned, first.changed, first.state, first.version],
    [true, true, 'active', lane.version + 1],
  );
  const records = f.tables.projectHostedRecords.size;
  const again = await setPin(f, lane.id, true);
  assert.deepEqual([again.changed, again.version], [false, lane.version + 1]);
  assert.equal(f.tables.projectHostedRecords.size, records, 'a repeat writes nothing');
  const head = [...f.tables.projectHostedRecordHeads.values()].find(row => row.key === lane.id);
  assert.equal(head.pinned, true, 'the head row carries the pin');
  const read = await f.read(lane.id);
  assert.equal(read.pinned, true);
  assert.equal(read.head, lane.head, 'pinning keeps the head');
  assert.equal(read.state, 'active');
  await setPin(f, done.id, true);
  const rows = await states(f, [lane.id, done.id, randomUUID()]);
  assert.deepEqual(
    rows.map(row => [row.state, row.pinned]),
    [
      ['active', true],
      ['completed', true],
      ['missing', undefined],
    ],
  );
  const cleared = await setPin(f, lane.id, false);
  assert.deepEqual([cleared.pinned, cleared.changed], [false, true]);
  assert.equal('pinned' in (await f.read(lane.id)), false, 'unpinned is the absent field');
  assert.equal(
    [...f.tables.projectHostedRecordHeads.values()].find(r => r.key === lane.id).pinned,
    undefined,
  );
  await assert.rejects(setPin(f, randomUUID(), true), code('NOT_FOUND'));
});

test('complete-merged skips a pinned Lane and still completes its sibling', async () => {
  const f = await lifecycleFixture();
  const landed = await f.addLane(),
    pinned = await f.addLane({ pinned: true });
  seedReceipt(f, [landed, pinned]);
  assert.deepEqual(await sweep(f), [landed.id]);
  assert.equal((await f.read(pinned.id)).state, 'active');
  assert.equal((await f.read(landed.id)).state, 'completed');
});

test('explicit complete and abandon refuse a pinned Lane until it is unpinned; reopen still works', async () => {
  const f = await lifecycleFixture();
  const lane = await f.addLane();
  await setPin(f, lane.id, true);
  const target = async () => ({ kind: 'lane', laneId: lane.id, expected: pins(await f.read(lane.id)) });
  for (const action of ['complete', 'abandon'])
    await assert.rejects(
      f.begin(f.request(await target(), { action, reason: 'cleanup' })),
      code('LANE_PINNED'),
      action,
    );
  assert.equal((await f.read(lane.id)).state, 'active');
  await setPin(f, lane.id, false);
  assert.equal(
    (await f.begin(f.request(await target(), { action: 'complete', reason: '' }))).status,
    'applied',
  );
  await setPin(f, lane.id, true);
  assert.equal((await f.read(lane.id)).state, 'completed', 'pinning a completed Lane keeps it completed');
  const reopened = await f.begin(f.request(await target(), { action: 'reopen', reason: '' }));
  assert.equal(reopened.status, 'applied');
  const after = await f.read(lane.id);
  assert.deepEqual([after.state, after.pinned], ['active', true], 'reopen keeps the pin');
});

test('an Intent cascade abandons open child Lanes but never a pinned one', async () => {
  const f = await lifecycleFixture();
  const plain = await f.addLane({ intentId: f.intentId }),
    pinned = await f.addLane({ intentId: f.intentId, pinned: true });
  const intent = await f.lifeRun(
    'intentRead',
    (await import(moduleUrl('../convex/projectHostedRecords.ts'))).readHostedRecord,
    { ...f.auth, kind: 'intent', key: f.intentId },
  );
  const r = f.request(
    { kind: 'intent', intentId: f.intentId, version: JSON.parse(intent.value).version, cascade: true },
    { action: 'abandon', reason: 'Superseded' },
  );
  await f.begin(r);
  await f.drain();
  assert.equal((await f.read(plain.id)).state, 'abandoned');
  assert.equal((await f.read(pinned.id)).state, 'active', 'the pinned child stays open');
});

function fixtureRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-test-pin-'));
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory, 'state');
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
/** A finished-looking Lane checkout: marker + registry entry, old enough for prune. */
function checkout(directory, name, laneId, ageHours, now) {
  const root = join(directory, name);
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge', 'hosted-lane.json'),
    JSON.stringify({ url: 'https://x.invalid', selection: { laneId, projectId: 'project' } }),
  );
  const old = (now - ageHours * hour) / 1000;
  for (const path of [join(root, '.forge', 'hosted-lane.json'), join(root, '.forge'), root])
    utimesSync(path, old, old);
  recordLane(
    { laneId, root, url: 'https://x.invalid', projectId: 'project', lastActionAt: now - ageHours * hour },
    now,
  );
  return root;
}
const settings = { autoPruneHours: 3, idleLaneHours: 1 };

test('prune keeps a pinned Lane (active or finished) and still removes an unpinned finished one', async t => {
  const directory = fixtureRoot(t),
    now = Date.now();
  const [pinnedDone, pinnedActive, plainDone] = [randomUUID(), randomUUID(), randomUUID()];
  const roots = {
    pinnedDone: checkout(directory, 'pinned-done', pinnedDone, 30, now),
    pinnedActive: checkout(directory, 'pinned-active', pinnedActive, 30, now),
    plainDone: checkout(directory, 'plain-done', plainDone, 30, now),
  };
  const result = await laneHousekeeping({
    apply: true,
    now,
    settings,
    isDirty: () => false,
    readStates: async () =>
      new Map([
        [pinnedDone, { state: 'completed', pinned: true }],
        [pinnedActive, { state: 'active', pinned: true }],
        [plainDone, { state: 'completed', pinned: false }],
      ]),
  });
  assert.deepEqual(
    result.pruned.map(row => row.laneId),
    [plainDone],
  );
  assert(existsSync(roots.pinnedDone) && existsSync(roots.pinnedActive), 'pinned roots stay');
  assert(!existsSync(roots.plainDone));
  assert.deepEqual(result.kept.map(row => row.reason).sort(), ['pinned', 'pinned']);
  assert.equal(readLaneEntry(pinnedDone).pinned, true, 'the registry mirrors the server pin');
  assert.equal(result.idle.length, 0, 'a pinned Lane is not listed as idle work to land');
});

test('prune keeps the last known pin when the server cannot be read, and clears a removed pin', async t => {
  const directory = fixtureRoot(t),
    now = Date.now();
  const [kept, released] = [randomUUID(), randomUUID()];
  const keptRoot = checkout(directory, 'kept', kept, 30, now);
  const releasedRoot = checkout(directory, 'released', released, 30, now);
  recordLane({ laneId: kept, pinned: true, lastActionAt: now - 30 * hour }, now);
  recordLane({ laneId: released, pinned: true, lastActionAt: now - 30 * hour }, now);
  const offline = await laneHousekeeping({
    apply: true,
    now,
    settings,
    isDirty: () => false,
    readStates: async () => {
      throw Error('offline');
    },
  });
  assert.deepEqual(offline.pruned, []);
  assert(existsSync(keptRoot) && existsSync(releasedRoot));
  const online = await laneHousekeeping({
    apply: true,
    now,
    settings,
    isDirty: () => false,
    readStates: async () =>
      new Map([
        [kept, { state: 'completed', pinned: true }],
        [released, { state: 'completed', pinned: false }],
      ]),
  });
  assert.deepEqual(
    online.pruned.map(row => row.laneId),
    [released],
  );
  assert(existsSync(keptRoot) && !existsSync(releasedRoot));
  assert.equal(readLaneEntry(kept).pinned, true);
});

test('client cache GC never evicts a pinned nested Lane copy', t => {
  const directory = fixtureRoot(t),
    now = Date.now();
  const root = join(directory, 'lane-root');
  const [pinned, plain] = [randomUUID(), randomUUID()];
  for (const id of [pinned, plain]) {
    const copy = join(`${root}.forge-client`, 'lanes', id);
    mkdirSync(join(copy, '.forge'), { recursive: true });
    writeFileSync(join(copy, 'file.txt'), 'x'.repeat(4096));
    const old = (now - 48 * hour) / 1000;
    for (const path of [join(copy, 'file.txt'), join(copy, '.forge'), copy]) utimesSync(path, old, old);
  }
  recordLane(
    {
      laneId: pinned,
      root: join(`${root}.forge-client`, 'lanes', pinned),
      url: 'https://x.invalid',
      projectId: 'project',
      pinned: true,
      lastActionAt: now - 48 * hour,
    },
    now,
  );
  const result = gcNestedLanes({
    root,
    now,
    settings: { clientCacheMaxGB: 0, clientCacheMaxAgeHours: 24 },
    isDirty: () => false,
  });
  assert.deepEqual(
    result.evicted.map(row => row.laneId),
    [plain],
  );
  assert.deepEqual(result.kept, [{ laneId: pinned, reason: 'pinned' }]);
  assert(existsSync(join(`${root}.forge-client`, 'lanes', pinned)));
  assert.equal(listLanes().find(entry => entry.laneId === pinned)?.pinned, true);
});

test('replay of 2026-10-31: a pinned Lane survives complete-merged followed by prune', async t => {
  const f = await lifecycleFixture();
  const directory = fixtureRoot(t),
    now = Date.now();
  const lead = await f.addLane(),
    finished = await f.addLane();
  await setPin(f, lead.id, true);
  const pinnedLead = await f.read(lead.id);
  // The sweep that completed the protected lead Lanes: both Lanes are in accepted receipts.
  seedReceipt(f, [pinnedLead, finished]);
  assert.deepEqual(await sweep(f), [finished.id], 'only the unpinned Lane is completed');
  // The lead later finished its own work and the owner completed it; the pin must still hold the root.
  await setPin(f, finished.id, false);
  const leadRoot = checkout(directory, 'lane-lead', lead.id, 30, now);
  const finishedRoot = checkout(directory, 'lane-finished', finished.id, 30, now);
  const readStates = async (_address, ids) => new Map((await states(f, ids)).map(row => [row.laneId, row]));
  const pruned = await laneHousekeeping({ apply: true, now, settings, isDirty: () => false, readStates });
  assert.deepEqual(
    pruned.pruned.map(row => row.laneId),
    [finished.id],
    'prune removes the finished unpinned Lane only',
  );
  assert((await f.read(lead.id)).state === 'active' && existsSync(leadRoot), 'the pinned lead Lane stays');
  assert(!existsSync(finishedRoot));
});
