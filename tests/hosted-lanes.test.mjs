// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { hostedLaneSelectionSchema } from '../dist/hosted-lane.js';
import * as laneHint from '../dist/hosted-lane.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
import { hostedRecordIndex, hostedRecordValue } from '../dist/hosted-records.js';
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const reads = await import(moduleUrl('../convex/projectHostedLanes.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const planning = await import(moduleUrl('../convex/projectHostedPlanning.ts'));
const head = 'a'.repeat(64),
  nextHead = 'b'.repeat(64);
const code = expected => error => (error.data?.code ?? error.code) === expected;
const metrics = [];
async function setup() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const main = {
    schema: 2,
    projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  const seedInput = { projectId, actor: 'owner', operationId: randomUUID(), selection: JSON.stringify(main) };
  await s.call('seed', channels.seed, seedInput);
  metrics.push(s.counts.at(-1));
  const input = (intent = { kind: 'new', outcome: 'Hosted start' }) => ({
    projectId,
    operationId: randomUUID(),
    authorityEpoch: 1,
    expectedMain: { head, receiptId: 'main-0' },
    intent,
  });
  const invoke = async (name, fn, args, actor) => {
    try {
      return await s.call(name, fn, args, actor);
    } finally {
      // A tighter per-function contract than provider limits. It must stay O(1),
      // except the single explicitly paged sibling result (100 compact headers).
      const count = s.counts.at(-1);
      assert(count.documents <= (name === 'siblings' ? 110 : 65), `${name}: bounded reads`);
      assert(count.ranges <= 65, `${name}: bounded ranges`);
      metrics.push(count);
    }
  };
  const begin = async (args = input(), actor) => JSON.parse(await invoke('start', start.start, args, actor));
  const move = (newHead, receiptId) => {
    const row = [...s.tables.projectHostedChannels.values()][0];
    s.patch('projectHostedChannels', row._id, {
      selection: canonicalPayload({
        ...main,
        head: newHead,
        sourceRevision: 1,
        receipt: { ...main.receipt, id: receiptId },
      }),
    });
  };
  return { ...s, projectId, main, seedInput, input, begin, invoke, move };
}

test('compound start atomically creates one Intent/Lane with no filesystem or full Work dependency', async () => {
  const s = await setup(),
    input = s.input(),
    first = await s.begin(input);
  assert.deepEqual(
    JSON.parse(await s.invoke('current-main', channels.current, { projectId: s.projectId })),
    s.main,
  );
  assert.equal(first.intentId, first.lane.intentId);
  assert.equal(first.lane.head, head);
  assert.equal(first.lane.base.receiptId, 'main-0');
  assert.equal(first.lane.sourceVersion, 0);
  assert.equal('path' in first.lane, false);
  hostedLaneSelectionSchema.parse(first.lane);
  const intent = JSON.parse(
    await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: first.intentId }),
  );
  assert.equal(intent.outcome, 'Hosted start');
  assert.equal(intent.creatorAccountId, 'owner');
  assert.equal(s.tables.projectHostedRecords.size, 2);
  assert.equal(s.tables.projectHostedOperations.size, 2);
  assert.deepEqual(await s.begin(input), first);
  for (const count of s.counts) {
    assert(
      !count.touched.some(t =>
        [
          'projectWorkEvents',
          'projectWorkHeads',
          'projectWorkRecords',
          'projectWorkGenerations',
          'projectBackups',
        ].includes(t),
      ),
    );
    assert(
      !count.written.some(t =>
        ['hostedProjects', 'projectHostedChannels', 'projectHostedSnapshotHeads'].includes(t),
      ) || count.name === 'seed',
    );
  }
});

test('lost start response reconciles original IDs/time after main, authority and Lane advance without rewinding', async () => {
  const s = await setup(),
    input = s.input(),
    first = await s.begin(input);
  const original = JSON.parse(
    await s.invoke('detail', reads.detail, { projectId: s.projectId, laneId: first.lane.laneId }),
  );
  await s.call('advance-lane', {
    _handler: ctx =>
      records.writeHostedRecord(ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: 0,
        record: { ...original, version: 1, sourceVersion: 1, head: nextHead },
      }),
  });
  s.move(nextHead, 'main-1');
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  assert.deepEqual(await s.begin(input), first);
  const selected = JSON.parse(
    await s.invoke('select', reads.select, { projectId: s.projectId, laneId: first.lane.laneId }),
  );
  assert.equal(selected.head, nextHead);
  // Liveness: head reports when the Lane record last changed, from the record already read.
  const read = await s.invoke('head', reads.head, { projectId: s.projectId, laneId: first.lane.laneId });
  assert.equal(read.lastActivityAt, original.at);
  assert.equal(read.head, nextHead);
  assert.equal(selected.sourceVersion, 1);
  assert.equal(selected.authority.epoch, 2);
  assert.equal(s.tables.projectHostedRecords.size, 3);
  assert.equal(s.tables.projectHostedOperations.size, 2);
});

test('concurrent duplicate operation UUID commits exactly one Intent and Lane under OCC', async () => {
  const s = await setup(),
    input = s.input();
  const [a, b] = await Promise.all([s.begin(input), s.begin(input)]);
  assert.deepEqual(a, b);
  assert.equal(s.tables.projectHostedRecords.size, 2);
  assert.equal(s.tables.projectHostedRecordHeads.size, 2);
  assert.equal(s.tables.projectHostedOperations.size, 2);
  assert(s.counts.some(c => c.retries === 1));
});

// Issue 29b2d1ca: each start charges one of 4 random shards of the account's daily start counter
// (convex/accountLimits.ts), so two concurrent starts shared a counter row 1 time in 4 and retried.
// Pin the shard pick: distinct shards prove start's own resources are disjoint (no retry at all);
// one shard proves the only clash is that counter row, retried once, with both starts counted.
const limiterShards = s =>
  [...s.tables.deviceAttempts.values()].filter(row => row.owner.startsWith('limit:start:'));
test('unrelated concurrent starts write distinct resources and need no global revision retry', async t => {
  const draws = [0, 0.5];
  const random = t.mock.method(Math, 'random', () => draws[random.mock.callCount() % 2]);
  const s = await setup();
  const [a, b] = await Promise.all([s.begin(), s.begin()]);
  assert.notEqual(a.intentId, b.intentId);
  assert.notEqual(a.lane.laneId, b.lane.laneId);
  assert.equal(s.tables.projectHostedRecords.size, 4);
  assert.equal(s.tables.projectHostedOperations.size, 3);
  assert.equal(random.mock.callCount(), 2, 'one shard pick per start, no other randomness');
  assert.deepEqual(
    limiterShards(s).map(row => row.count),
    [1, 1],
  );
  assert(s.counts.every(c => c.retries === 0));
});

test('concurrent starts on one start-limiter shard retry only on that counter row', async t => {
  t.mock.method(Math, 'random', () => 0);
  const s = await setup();
  const [a, b] = await Promise.all([s.begin(), s.begin()]);
  assert.notEqual(a.lane.laneId, b.lane.laneId);
  assert.equal(s.tables.projectHostedRecords.size, 4);
  assert.deepEqual(
    limiterShards(s).map(row => row.count),
    [2],
  );
  const clashed = s.counts.filter(c => c.conflicts);
  assert.equal(clashed.length, 1);
  assert.deepEqual(clashed[0].conflicts, ['deviceAttempts']);
  assert.equal(Math.max(...s.counts.map(c => c.retries)), 1);
});

test('Intent-only creation and concurrent sibling starts preserve the Intent version', async () => {
  const s = await setup(),
    input = s.input();
  const planned = JSON.parse(await s.invoke('createIntent', start.createIntent, input));
  assert.equal(planned.lane, null);
  assert.equal(s.tables.projectHostedRecords.size, 1);
  assert.equal(
    JSON.parse(await s.invoke('createIntent', start.createIntent, input)).intentId,
    planned.intentId,
  );
  const [a, b] = await Promise.all([
    s.begin(s.input({ kind: 'existing', intentId: planned.intentId })),
    s.begin(s.input({ kind: 'existing', intentId: planned.intentId })),
  ]);
  assert.equal(a.intentId, b.intentId);
  assert.notEqual(a.lane.laneId, b.lane.laneId);
  assert.equal(s.tables.projectHostedRecords.size, 3);
  // A cascade's complete child-set CAS requires an Intent-scoped revision.
  // Concurrent siblings may retry that narrow guard while preserving both Lanes
  // and leaving the canonical Intent record/version unchanged.
  const guard = [...s.tables.projectHostedLifecycleGuards.values()].find(
    g => g.intentId === planned.intentId,
  );
  assert.equal(guard.revision, 2);
  assert.equal(guard.planId, null);
  assert.equal(
    [...s.tables.projectHostedRecordHeads.values()].find(
      h => h.kind === 'intent' && h.key === planned.intentId,
    ).version,
    0,
  );
  await assert.rejects(s.begin(input), code('WORK_OPERATION_CHANGED'));
});

test('changed payload or expected pins cannot reuse a completed UUID', async () => {
  const s = await setup(),
    input = s.input();
  await s.begin(input);
  for (const change of [
    { intent: { kind: 'new', outcome: 'Different work' } },
    { expectedMain: { head, receiptId: 'different-receipt' } },
    { authorityEpoch: 2 },
  ])
    await assert.rejects(s.begin({ ...input, ...change }), code('WORK_OPERATION_CHANGED'));
  assert.equal(s.tables.projectHostedRecords.size, 2);
});

test('stale head and ABA receipt expectations fail atomically; malformed UUIDs are structured errors', async () => {
  const s = await setup();
  for (const expectedMain of [
    { head: nextHead, receiptId: 'main-0' },
    { head, receiptId: 'other' },
  ])
    await assert.rejects(s.begin({ ...s.input(), expectedMain }), code('CHANNEL_CHANGED'));
  s.move(head, 'same-bytes-new-receipt');
  await assert.rejects(s.begin(), code('CHANNEL_CHANGED'));
  await assert.rejects(s.begin({ ...s.input(), operationId: 'invalid' }), code('BAD_ARGUMENT'));
  assert.equal(s.tables.projectHostedRecords.size, 0);
  assert.equal(s.tables.projectHostedOperations.size, 1);
});

test('current contributor, Intent creator/assignee and reader authority apply before mutations and replays', async () => {
  const s = await setup(),
    input = s.input();
  const grant = s.insert('projectContributors', { projectId: s.projectId, contributor: 'contributor' });
  const first = await s.begin(input, 'contributor');
  assert.equal(first.lane.authority.epoch, 1);
  const other = s.insert('projectContributors', { projectId: s.projectId, contributor: 'other' });
  await assert.rejects(
    s.begin(s.input({ kind: 'existing', intentId: first.intentId }), 'other'),
    code('PROJECT_UNAVAILABLE'),
  );
  await s.begin(s.input({ kind: 'existing', intentId: first.intentId }), 'owner');
  await s.begin(s.input({ kind: 'existing', intentId: first.intentId }), 'contributor');
  s.tables.projectContributors.delete(grant);
  s.insert('projectReaders', { projectId: s.projectId, reader: 'contributor' });
  await assert.rejects(s.begin(input, 'contributor'), code('PROJECT_UNAVAILABLE'));
  const identity = { projectId: s.projectId, laneId: first.lane.laneId };
  assert.equal((await s.invoke('head', reads.head, identity, 'contributor')).head, head);
  s.tables.projectReaders.clear();
  for (const fn of [reads.head, reads.detail, reads.select])
    await assert.rejects(s.invoke('read', fn, identity, 'contributor'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    s.invoke('current-main', channels.current, { projectId: s.projectId }, 'contributor'),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(s.begin(s.input(), null), code('PROJECT_UNAVAILABLE'));
  s.tables.projectContributors.delete(other);
});

test('foreign-project Lanes/Intents and main seeds cannot cross project boundaries', async () => {
  const s = await setup(),
    first = await s.begin();
  const secondId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  for (const fn of [reads.head, reads.detail, reads.select])
    await assert.rejects(
      s.invoke('read', fn, { projectId: secondId, laneId: first.lane.laneId }),
      code('NOT_FOUND'),
    );
  await assert.rejects(
    s.begin({ ...s.input({ kind: 'existing', intentId: first.intentId }), projectId: secondId }),
    code('NOT_FOUND'),
  );
  await assert.rejects(
    s.call('seed', channels.seed, {
      projectId: secondId,
      actor: 'owner',
      operationId: randomUUID(),
      selection: JSON.stringify(s.main),
    }),
    code('SOURCE_UNAVAILABLE'),
  );
  s.insert('projectHostedChannels', {
    projectId: secondId,
    operationId: randomUUID(),
    name: 'main',
    selection: JSON.stringify(s.main),
  });
  await assert.rejects(s.begin({ ...s.input(), projectId: secondId }), code('SOURCE_UNAVAILABLE'));
});

test('native authority, stale authority and unseeded server main never fall back to full Work/history', async () => {
  const s = await setup();
  await assert.rejects(s.begin({ ...s.input(), authorityEpoch: 2 }), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'native-owner', epoch: 0 } });
  await assert.rejects(s.begin({ ...s.input(), authorityEpoch: 0 }), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server-shadow', epoch: 1 } });
  await assert.rejects(s.begin(), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  s.tables.projectHostedChannels.clear();
  await assert.rejects(s.begin(), code('SOURCE_UNAVAILABLE'));
  assert.equal(s.tables.projectHostedRecords.size, 0);
});

test('exact detail and source select retain source/version pins and reject stale selection', async () => {
  const s = await setup(),
    first = await s.begin(),
    identity = { projectId: s.projectId, laneId: first.lane.laneId };
  const original = JSON.parse(await s.invoke('detail', reads.detail, identity));
  const pins = { head, sourceVersion: 0, version: 0 };
  const selected = JSON.parse(await s.invoke('select', reads.select, { ...identity, expected: pins }));
  assert.deepEqual(selected, first.lane);
  await s.call('advance-lane', {
    _handler: ctx =>
      records.writeHostedRecord(ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: 0,
        record: { ...original, version: 1, sourceVersion: 1, head: nextHead },
      }),
  });
  assert.deepEqual(JSON.parse(await s.invoke('detail', reads.detail, { ...identity, version: 0 })), original);
  await assert.rejects(s.invoke('select', reads.select, { ...identity, expected: pins }), code('WORK_STALE'));
  assert.equal((await s.invoke('head', reads.head, identity)).version, 1);
  await assert.rejects(s.invoke('detail', reads.detail, { ...identity, version: 9 }), code('NOT_FOUND'));
});

test('10,050 sibling Lanes are paged while start read counts stay constant', async () => {
  const s = await setup(),
    first = await s.begin();
  const baseline = s.counts.at(-1);
  for (let i = 0; i < 10050; i++)
    s.insert('projectHostedRecordHeads', {
      projectId: s.projectId,
      kind: 'lane',
      key: randomUUID(),
      parent: first.intentId,
      status: 'active',
      version: 0,
      recordId: `fixture-record-${i}`,
    });
  await s.begin();
  assert.equal(s.counts.at(-1).documents, baseline.documents);
  assert.equal(s.counts.at(-1).ranges, baseline.ranges);
  await s.begin(s.input({ kind: 'existing', intentId: first.intentId }));
  let cursor = null,
    total = 0,
    pages = 0;
  do {
    const page = await s.invoke('siblings', reads.siblings, {
      projectId: s.projectId,
      intentId: first.intentId,
      cursor,
    });
    assert(page.page.length <= 100);
    total += page.page.length;
    pages++;
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  assert.equal(total, 10052);
  assert.equal(pages, 101);
});

test('trusted main seeding is insert-only, owner-authorized, and cannot rewind selected main', async () => {
  const s = await setup();
  const input = s.seedInput;
  await s.call('seed', channels.seed, input);
  await assert.rejects(
    s.call('seed', channels.seed, { ...input, actor: 'other' }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    s.call('seed', channels.seed, { ...input, selection: JSON.stringify({ ...s.main, head: nextHead }) }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal(s.tables.projectHostedChannels.size, 1);
  s.move(nextHead, 'main-later');
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await s.call('seed', channels.seed, input); // Lost original reply after later main/authority movement.
  assert.equal(JSON.parse([...s.tables.projectHostedChannels.values()][0].selection).head, nextHead);
});

// Issue b6ba9219: a start on an Issue others already work on lists their open Lanes (handle only).
test('a sibling start lists the other open Lanes newest first with public handles, only when asked', async () => {
  const s = await setup();
  s.insert('forgeAccounts', { owner: 'owner', handle: 'lead' });
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'assigned' });
  const first = await s.begin({ ...s.input(), openLanesVersion: 1 });
  assert.equal(first.openLanes, undefined, 'a new Intent has no other Lanes and reads none');
  const intent = JSON.parse(
    await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: first.intentId }),
  );
  await s.call('assign', {
    _handler: ctx =>
      records.writeHostedRecord(ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: 0,
        record: { ...intent, version: 1, assigneeAccountIds: ['assigned'] },
      }),
  });
  const sibling = s.input({ kind: 'existing', intentId: first.intentId });
  const legacy = await s.begin(sibling);
  assert.equal(legacy.openLanes, undefined, 'older strict clients never see the new field');
  const named = await s.begin({ ...sibling, openLanesVersion: 3 });
  assert.equal(named.laneTitle, intent.outcome);
  assert.equal(named.lane.laneId, legacy.lane.laneId, 'requesting a title replays the original Lane');
  assert.equal((await s.begin(sibling)).laneTitle, undefined, 'older strict clients never see the title');
  const asked = { ...s.input({ kind: 'existing', intentId: first.intentId }), openLanesVersion: 1 };
  const second = await s.begin(asked);
  assert.deepEqual(
    second.openLanes.map(lane => [lane.laneId, lane.owner, lane.yours]),
    [
      [legacy.lane.laneId, 'lead', true],
      [first.lane.laneId, 'lead', true],
    ],
  );
  assert.equal(second.openLanes[0].lastActivityAt, legacy.at);
  assert.deepEqual(await s.begin(asked), second, 'the replay returns the original list');
  const theirs = await s.begin(
    { ...s.input({ kind: 'existing', intentId: first.intentId }), openLanesVersion: 1 },
    'assigned',
  );
  assert.equal(theirs.openLanes.length, 3);
  assert(theirs.openLanes.every(lane => lane.owner === 'lead' && lane.yours === false));
  assert(!JSON.stringify(theirs.openLanes).includes('"owner":"owner"'), 'never an account id');
  // A finished Lane is not listed.
  const row = [...s.tables.projectHostedRecordHeads.values()].find(h => h.key === first.lane.laneId);
  s.patch('projectHostedRecordHeads', row._id, { status: 'completed' });
  const later = await s.begin({
    ...s.input({ kind: 'existing', intentId: first.intentId }),
    openLanesVersion: 1,
  });
  assert(!later.openLanes.some(lane => lane.laneId === first.lane.laneId));
  assert.equal(later.openLanes.length, 3);
});

// Item d9e1ac62 (real case: Item 1dd4e095, Lanes ac26ac6f and c908b679): a start lists which open Lane is the resolution
// of another, so the agent can be told which one is replaced. Only version 2 clients get the field, and the read
// costs nothing extra: it comes from the Lane records the sibling list already parses.
async function resolutionPair() {
  const s = await setup();
  s.insert('forgeAccounts', { owner: 'owner', handle: 'lead' });
  const origin = await s.begin({ ...s.input(), openLanesVersion: 1 });
  const sibling = () => s.input({ kind: 'existing', intentId: origin.intentId });
  const resolution = await s.begin(sibling());
  // Make the second Lane the resolution of the first, as a conflicted sync records it.
  await s.call('resolve', {
    _handler: async ctx => {
      const row = await records.readHostedRecord(ctx, {
        projectId: s.projectId,
        actor: 'owner',
        kind: 'lane',
        key: resolution.lane.laneId,
      });
      const lane = JSON.parse(row.value);
      await records.writeHostedRecord(ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: lane.version,
        record: {
          ...lane,
          version: lane.version + 1,
          resolution: {
            candidateId: null,
            conflicts: { sha256: 'c'.repeat(64), size: 1 },
            left: lane.head,
            right: lane.head,
            draftHead: lane.head,
            origin: { laneId: origin.lane.laneId, head: lane.head, sourceVersion: 0 },
            status: 'pending',
          },
        },
      });
    },
  });
  return { s, origin, resolution, sibling };
}
test('d9e1ac62: a version 2 start names the Lane each open resolution Lane resolves, at the same read cost', async () => {
  const one = await resolutionPair();
  const v1 = await one.s.begin({ ...one.sibling(), openLanesVersion: 1 });
  const v1Cost = one.s.counts.at(-1);
  assert.equal(v1.openLanes.length, 2);
  assert.ok(
    v1.openLanes.every(lane => !('resolves' in lane)),
    'a version 1 client never sees the field',
  );
  const { s, origin, resolution, sibling } = await resolutionPair();
  const v2 = await s.begin({ ...sibling(), openLanesVersion: 2 });
  const v2Cost = s.counts.at(-1);
  assert.deepEqual(
    v2.openLanes.map(lane => [lane.laneId, lane.resolves ?? null]),
    [
      [resolution.lane.laneId, origin.lane.laneId],
      [origin.lane.laneId, null],
    ],
  );
  assert.deepEqual(
    { documents: v2Cost.documents, ranges: v2Cost.ranges },
    { documents: v1Cost.documents, ranges: v1Cost.ranges },
    'the start reads no more for the field',
  );
  assert.deepEqual(laneHint.replacedOpenLanes(v2.openLanes), [
    {
      laneId: origin.lane.laneId,
      replacedBy: resolution.lane.laneId,
      note: `Lane ${origin.lane.laneId} continues in its resolution Lane ${resolution.lane.laneId}. Once its work is confirmed there, abandon it.`,
      next: `nforge agent ROOT abandon {"laneId":"${origin.lane.laneId}","reason":"Replaced by Lane ${resolution.lane.laneId}"}`,
    },
  ]);
  assert.deepEqual(laneHint.replacedOpenLanes(v1.openLanes), [], 'no hint without the field');
});

test('assigned contributors can start siblings; removing assignment revokes their completed retry', async () => {
  const s = await setup(),
    first = await s.begin();
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'assigned' });
  const intent = JSON.parse(
    await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: first.intentId }),
  );
  const assign = async (version, assigneeAccountIds) =>
    s.call('assign', {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: version - 1,
          record: { ...intent, version, assigneeAccountIds },
        }),
    });
  await assign(1, ['assigned']);
  const input = s.input({ kind: 'existing', intentId: first.intentId });
  await s.begin(input, 'assigned');
  await assign(2, []);
  await assert.rejects(s.begin(input, 'assigned'), code('PROJECT_UNAVAILABLE'));
});

test('CLI scope and credential revocation guards cover the new public writer and readers', async () => {
  const s = await setup(),
    first = await s.begin();
  const credentialId = randomUUID();
  const id = s.insert('cliCredentials', {
    name: 'Synthetic',
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    credentialId,
    owner: 'owner',
    revoked: false,
    expiresAt: Date.now() + 60000,
    scope: 'coordination',
  });
  const identity = { subject: 'owner', forgeCredential: credentialId };
  await assert.rejects(s.begin(s.input(), identity), code('AUTH_SCOPE_DENIED'));
  await assert.rejects(
    s.invoke('head', reads.head, { projectId: s.projectId, laneId: first.lane.laneId }, identity),
    code('AUTH_SCOPE_DENIED'),
  );
  s.patch('cliCredentials', id, { scope: 'cli' });
  const input = s.input();
  await s.begin(input, identity);
  s.patch('cliCredentials', id, { revoked: true });
  await assert.rejects(s.begin(input, identity), code('AUTH_REVOKED'));
  await assert.rejects(
    s.invoke('current-main', channels.current, { projectId: s.projectId }, identity),
    code('AUTH_REVOKED'),
  );
});

test.after(() => {
  const maxima = Object.fromEntries(
    ['ranges', 'documents', 'readBytes', 'writes', 'writeBytes'].map(k => [
      k,
      Math.max(...metrics.map(m => m[k])),
    ]),
  );
  console.log('H03 per-function maxima', JSON.stringify(maxima));
  for (const name of [...new Set(metrics.map(m => m.name))]) {
    const samples = metrics.filter(m => m.name === name);
    console.log(
      'H03 API reads',
      JSON.stringify({
        name,
        calls: samples.length,
        ranges: Math.max(...samples.map(m => m.ranges)),
        documents: Math.max(...samples.map(m => m.documents)),
        readBytes: Math.max(...samples.map(m => m.readBytes)),
      }),
    );
  }
});

test('explicit initial source is committed before hosted start; main receipt CAS and original replay remain intact', async () => {
  const s = await setup(),
    input = { ...s.input(), initialHead: nextHead };
  await assert.rejects(s.begin(input), code('SOURCE_UNAVAILABLE'));
  s.insert('projectObjects', {
    projectId: s.projectId,
    digest: nextHead,
    size: 100,
    removed: false,
    nonce: randomUUID(),
    location: 'r2',
    r2Committed: true,
    r2Key: `v1/p/${s.projectId}/o/${nextHead}`,
  });
  const result = await s.begin(input);
  assert.equal(result.lane.head, nextHead);
  assert.deepEqual(result.lane.base, input.expectedMain);
  s.move('c'.repeat(64), 'main-1');
  assert.deepEqual(await s.begin(input), result);
  await assert.rejects(s.begin({ ...input, initialHead: 'd'.repeat(64) }), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(s.begin({ ...input, operationId: randomUUID() }), code('CHANNEL_CHANGED'));
});

test('planned start gives the Intent the Issue id, adds sibling Lanes, continues a finished Intent, and reports Intent state per Issue', async () => {
  const s = await setup(),
    issue = randomUUID(),
    planned = { kind: 'planned', intentId: issue, outcome: 'Planned Issue', constraints: 'Acceptance' };
  const first = await s.begin(s.input(planned));
  assert.equal(first.intentId, issue);
  assert.equal(first.lane.intentId, issue);
  assert.deepEqual(await s.begin(s.input(planned)).then(r => r.intentId), issue);
  const intent = JSON.parse(
    await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: issue }),
  );
  assert.equal(intent.outcome, 'Planned Issue');
  assert.equal(intent.constraints, 'Acceptance');
  assert.equal(intent.creatorAccountId, 'owner');
  // Same Issue again: a sibling Lane on the same Intent, no second Intent record.
  const second = await s.begin(s.input(planned));
  assert.equal(second.intentId, issue);
  assert.notEqual(second.lane.laneId, first.lane.laneId);
  assert.equal([...s.tables.projectHostedRecords.values()].filter(row => row.kind === 'intent').length, 1);
  const states = await s.invoke('states', planning.intentStates, {
    projectId: s.projectId,
    ids: [issue, randomUUID()],
  });
  assert.deepEqual(JSON.parse(states), { [issue]: 'active' });
  // One head per started Issue and two empty ranges for a never-started/markerless root.
  assert(s.counts.at(-1).returnedDocuments <= 3 && s.counts.at(-1).writes === 0, 'head reads only');
  await s.call('states', planning.intentStates, {
    projectId: s.projectId,
    ids: Array.from({ length: 100 }, () => randomUUID()),
  });
  const absent = s.counts.at(-1);
  assert(absent.returnedDocuments <= 1 && absent.ranges <= 201 && absent.writes === 0, '100 absent Issues');
  await assert.rejects(
    s.invoke('states', planning.intentStates, {
      projectId: s.projectId,
      ids: Array.from({ length: 101 }, () => randomUUID()),
    }),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(
    s.invoke('states', planning.intentStates, { projectId: s.projectId, ids: [issue] }, 'stranger'),
    code('PROJECT_UNAVAILABLE'),
  );

  // A finished Intent never restarts: the Issue continues on a new Intent whose id derives from it (e4a71127).
  const finish = async id => {
    const current = JSON.parse(
      await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: id }),
    );
    await s.call('complete', {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: current.version,
          record: { ...current, version: current.version + 1, status: 'completed' },
        }),
    });
  };
  const intents = () => [
    ...new Set(
      [...s.tables.projectHostedRecords.values()].filter(row => row.kind === 'intent').map(row => row.key),
    ),
  ];
  await finish(issue);
  assert.deepEqual(
    JSON.parse(await s.invoke('states', planning.intentStates, { projectId: s.projectId, ids: [issue] })),
    { [issue]: 'completed' },
  );
  const followId = successorIntentId(issue);
  assert.notEqual(followId, issue);
  const followOp = s.input(planned);
  const follow = await s.begin(followOp);
  assert.equal(follow.intentId, followId);
  assert.equal(follow.lane.intentId, followId);
  assert.deepEqual(follow.openLanes ?? [], []);
  assert.equal(intents().length, 2, 'exactly one new Intent record');
  const followIntent = JSON.parse(
    await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: followId }),
  );
  assert.equal(followIntent.status, 'active');
  assert.equal(followIntent.outcome, 'Planned Issue');
  assert.equal(followIntent.constraints, 'Acceptance');
  // The earlier Intent stays completed history; the Issue now reports the follow-up's state.
  assert.equal(
    JSON.parse(await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: issue })).status,
    'completed',
  );
  assert.deepEqual(
    JSON.parse(await s.invoke('states', planning.intentStates, { projectId: s.projectId, ids: [issue] })),
    { [issue]: 'active' },
  );
  // Replaying the same operation returns the same result and adds no Intent or Lane.
  const lanes = () =>
    new Set(
      [...s.tables.projectHostedRecords.values()].filter(row => row.kind === 'lane').map(row => row.key),
    ).size;
  const before = lanes();
  assert.deepEqual(await s.begin(followOp), follow);
  assert.equal(intents().length, 2);
  assert.equal(lanes(), before);
  // A second builder starting the same Issue joins the follow-up Intent as a sibling Lane.
  const joined = await s.begin(s.input(planned));
  assert.equal(joined.intentId, followId);
  assert.notEqual(joined.lane.laneId, follow.lane.laneId);
  assert.equal(intents().length, 2, 'joining adds no Intent');
  // Finishing the follow-up continues the chain: a third Intent, again linked by id alone.
  await finish(followId);
  assert.deepEqual(
    JSON.parse(await s.invoke('states', planning.intentStates, { projectId: s.projectId, ids: [issue] })),
    { [issue]: 'completed' },
  );
  const third = await s.begin(s.input(planned));
  assert.equal(third.intentId, successorIntentId(followId));
  assert.equal(intents().length, 3);
  // An abandoned Intent continues the same way.
  const other = randomUUID();
  const abandonedStart = await s.begin(s.input({ ...planned, intentId: other }));
  const abandoned = JSON.parse(
    await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: other }),
  );
  await s.call('abandon', {
    _handler: ctx =>
      records.writeHostedRecord(ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: abandoned.version,
        record: { ...abandoned, version: abandoned.version + 1, status: 'abandoned' },
      }),
  });
  assert.equal(
    (await s.begin(s.input({ ...planned, intentId: other }))).intentId,
    successorIntentId(abandonedStart.intentId),
  );
  // Another account cannot attach Lanes to someone else's Intent by naming its Issue id.
  await assert.rejects(s.begin(s.input({ ...planned, intentId: first.intentId }), 'stranger'));
});

test('incident 846c635b: planned start reads and selects only the newest execution Intent before the creation boundary', async t => {
  const costs = [];
  for (const history of [4, 14, 17, 24]) {
    const s = await setup();
    s.patch('hostedProjects', s.projectId, { itemLaneMembership: 'verified-v2' });
    const issue = randomUUID();
    let id = issue;
    for (let i = 0; i < history; i++, id = successorIntentId(id)) {
      const { record, ref, value } = hostedRecordValue({
        kind: 'intent',
        id,
        version: 1,
        at: '2026-11-10T00:00:00.000Z',
        outcome: 'Retained Item work',
        constraints: '',
        creatorAccountId: 'owner',
        assigneeAccountIds: [],
        base: { head, receiptId: 'main-0' },
        status: 'completed',
      });
      const indexed = {
        projectId: s.projectId,
        kind: 'intent',
        key: id,
        version: record.version,
        ...hostedRecordIndex(record),
      };
      const bodyId = s.insert('projectHostedRecordBodies', { projectId: s.projectId, value });
      const recordId = s.insert('projectHostedRecords', {
        ...indexed,
        bodyId,
        digest: ref.digest,
        bytes: ref.bytes,
      });
      // The root may predate the marker. Follow-up starts have always kept the Item's id on their head.
      s.insert('projectHostedRecordHeads', {
        ...indexed,
        recordId,
        ...(i > 0 ? { planningItemId: issue } : {}),
      });
    }
    const input = s.input({ kind: 'planned', intentId: issue, outcome: 'More work on this Item' });
    const operations = s.tables.projectHostedOperations.size;
    if (history >= 17) {
      await assert.rejects(s.call('start', start.start, input), code('INTENT_CLOSED'));
      assert.equal(s.counts.at(-1).writes, 0);
      assert.equal(s.tables.projectHostedOperations.size, operations);
      assert.equal(s.tables.projectHostedRecordHeads.size, history);
    } else {
      const reply = JSON.parse(await s.call('start', start.start, input));
      assert.equal(reply.intentId, id);
      assert.equal(reply.lane.intentId, id);
      const { documents, ranges, readBytes } = s.counts.at(-1);
      costs.push({ documents, ranges, readBytes });
      t.diagnostic(JSON.stringify({ history, documents, ranges, readBytes }));
    }
  }
  assert.deepEqual(costs[0], costs[1], 'adding ten retained Intents must not add reads or ranges');
});

test('a purge committed during planned start fences its retry without retaining an Intent or Lane', async () => {
  const s = await setup();
  const issue = randomUUID();
  const payload = s.input({ kind: 'planned', intentId: issue, outcome: 'Do not leave a copy of this title' });
  const before = [
    s.tables.projectHostedRecordHeads.size,
    s.tables.projectHostedRecords.size,
    s.tables.projectHostedRecordBodies.size,
    s.tables.projectHostedOverlapLanes.size,
    s.tables.projectHostedOperations.size,
  ];
  let fenced = false;
  s.decorateContext(ctx => {
    const insert = ctx.db.insert;
    ctx.db.insert = async (table, row) => {
      if (!fenced && table === 'projectHostedRecordHeads' && row.kind === 'lane') {
        fenced = true;
        await s.call('purge-begin', {
          _handler: inner =>
            inner.db.patch(s.projectId, {
              itemPurges: [
                {
                  operationId: randomUUID(),
                  itemId: issue,
                  ids: [issue],
                  version: 1,
                  decisions: [],
                  rows: 1,
                  startedAt: Date.parse('2026-11-10T00:00:00.000Z'),
                },
              ],
            }),
        });
      }
      return insert(table, row);
    };
  });
  await assert.rejects(s.call('start', start.start, payload), code('INTENT_CLOSED'));
  assert.equal(fenced, true);
  await assert.rejects(s.call('start', start.start, payload), code('INTENT_CLOSED'));
  assert.deepEqual(
    [
      s.tables.projectHostedRecordHeads.size,
      s.tables.projectHostedRecords.size,
      s.tables.projectHostedRecordBodies.size,
      s.tables.projectHostedOverlapLanes.size,
      s.tables.projectHostedOperations.size,
    ],
    before,
  );
});

test('planned start joins a repaired markerless successor instead of recreating it', async () => {
  const s = await setup();
  const id = randomUUID();
  await s.begin(s.input({ kind: 'planned', intentId: id, outcome: 'Continue the legacy Item' }));
  const successor = successorIntentId(id);
  await s.call('seed', {
    _handler: async ctx => {
      const auth = { projectId: s.projectId, actor: 'owner', authorityEpoch: 1 };
      const row = await records.readHostedRecord(ctx, { ...auth, key: id, kind: 'intent' });
      const intent = JSON.parse(row.value);
      await records.writeHostedRecord(ctx, {
        ...auth,
        expectedVersion: 0,
        record: { ...intent, status: 'completed', version: 1 },
      });
      await records.writeHostedRecord(ctx, {
        ...auth,
        expectedVersion: null,
        record: { ...intent, id: successor },
      });
    },
  });
  const { run } = await import(moduleUrl('../convex/projectItemLaneBackfill.ts'));
  const old = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = 'https://benevolent-wildebeest-974.convex.cloud';
  try {
    let after = null;
    for (let i = 0; i < 3; i++) {
      const result = await s.call('fill', run, { projectId: s.projectId, after });
      after = result.next;
      if (after === null) break;
    }
    assert.equal(after, null);
  } finally {
    if (old === undefined) delete process.env.CONVEX_CLOUD_URL;
    else process.env.CONVEX_CLOUD_URL = old;
  }
  const reply = await s.begin(s.input({ kind: 'planned', intentId: id, outcome: 'Continue after repair' }));
  assert.equal(reply.intentId, successor);
  assert.equal(reply.lane.intentId, successor);
  assert.equal(
    [...s.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'intent').length,
    2,
  );
});

function purgingFixture(s, itemId) {
  s.patch('hostedProjects', s.projectId, {
    itemPurges: [
      { operationId: randomUUID(), itemId, ids: [itemId], version: 1, decisions: [], rows: 1, startedAt: 1 },
    ],
  });
}

test('an explicit existing-Intent start cannot join an Intent-born Item during its purge', async () => {
  const s = await setup();
  const first = await s.begin();
  purgingFixture(s, first.intentId);
  await assert.rejects(
    s.begin(s.input({ kind: 'existing', intentId: first.intentId })),
    code('INTENT_CLOSED'),
  );
  assert.equal(s.tables.projectHostedOverlapLanes.size, 1);
});

async function knownItemLane() {
  const s = await setup();
  const itemId = randomUUID();
  const backupId = 'fixture-backup';
  const generationId = s.insert('projectWorkGenerations', {
    projectId: s.projectId,
    backupId,
    format: 11,
    status: 'ready',
    initialRevision: 0,
    revision: 0,
    nextBatch: 0,
    metadata: '{"schema":24}',
  });
  s.patch('hostedProjects', s.projectId, {
    work: {
      backupId,
      generationId,
      operationId: randomUUID(),
      initialRevision: 0,
      revision: 0,
    },
  });
  s.insert('projectPlanningRecords', {
    projectId: s.projectId,
    generationId,
    collection: 'planningSearch',
    key: itemId,
    parent: '',
    position: 1,
    value: JSON.stringify({ id: itemId, kind: 'issue', status: 'open', title: 'Pending purge' }),
    planning: { text: 'Pending purge', kind: 'issue', status: 'open', open: true, initiativeId: '' },
  });
  const first = await s.begin(s.input({ kind: 'planned', intentId: itemId, outcome: 'Pending purge' }));
  const read = () =>
    s.invoke('lane', reads.detail, { projectId: s.projectId, laneId: first.lane.laneId }).then(JSON.parse);
  const write = (record, expectedVersion, reopened) =>
    s.call('lane-write', {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion,
          record,
          ...(reopened ? { reopened: true } : {}),
        }),
    });
  const membership = laneId =>
    [...s.tables.projectHostedRecordHeads.values()].find(head => head.key === laneId)?.planningItemId;
  return { s, itemId, lane: await read(), read, write, membership };
}

test('a new Resolution Lane inherits Item membership and cannot publish after the purge fence', async () => {
  const { s, itemId, lane, write, membership } = await knownItemLane();
  const resolution = {
    ...lane,
    id: randomUUID(),
    version: 0,
    resolution: {
      candidateId: null,
      conflicts: { sha256: 'c'.repeat(64), size: 1 },
      left: lane.head,
      right: lane.head,
      draftHead: lane.head,
      origin: { laneId: lane.id, head: lane.head, sourceVersion: lane.sourceVersion },
      status: 'pending',
    },
  };
  await write(resolution, null);
  assert.equal(membership(resolution.id), itemId);
  purgingFixture(s, itemId);
  await assert.rejects(write({ ...resolution, id: randomUUID() }, null), code('INTENT_CLOSED'));
  assert.equal(s.tables.projectHostedOverlapLanes.size, 2);
});

test('reopening stamps the Item on an older Lane but cannot reopen it during permanent purge', async () => {
  const { s, itemId, lane, read, write, membership } = await knownItemLane();
  const closed = { ...lane, version: 1, lifecycleVersion: 1, state: 'abandoned' };
  const reopened = { ...lane, version: 2, lifecycleVersion: 2 };
  await write(closed, 0);
  const head = [...s.tables.projectHostedRecordHeads.values()].find(head => head.key === lane.id);
  s.patch('projectHostedRecordHeads', head._id, { planningItemId: undefined });
  await write(reopened, 1, true);
  assert.equal(membership(lane.id), itemId);
  await write({ ...closed, version: 3, lifecycleVersion: 3 }, 2);
  purgingFixture(s, itemId);
  await assert.rejects(
    write({ ...reopened, version: 4, lifecycleVersion: 4 }, 3, true),
    code('INTENT_CLOSED'),
  );
  assert.equal((await read()).state, 'abandoned');
});

// Flip 5 (Issue 0695ab24): an Intent copied from the Work journal is owned by the journal until a Lane
// starts on it. That start pins it exactly as the old start created it: same id, active, the Lane's base
// and receipt, open to any project member. Until then Issue states never report its planning status.
test('a planned start pins an Intent copied from the journal: same id, active, receipt base; Issue states ignore it until then', async () => {
  const s = await setup(),
    issue = randomUUID(),
    planned = { kind: 'planned', intentId: issue, outcome: 'Planned Issue', constraints: '' };
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'member' });
  // A closed Issue's journal Intent is completed, with no base and its creator the owner.
  await s.call('copy', {
    _handler: ctx =>
      records.writeHostedRecord(ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: null,
        record: {
          kind: 'intent',
          id: issue,
          version: 0,
          at: '2026-11-10T00:00:00.000Z',
          outcome: 'Planned Issue',
          constraints: '',
          creatorAccountId: 'owner',
          assigneeAccountIds: [],
          status: 'completed',
          journal: { createdAt: '2026-11-10T00:00:00.000Z', title: 'Planned Issue' },
        },
      }),
  });
  const states = () =>
    s
      .invoke('states', planning.intentStates, { projectId: s.projectId, ids: [issue] })
      .then(value => JSON.parse(value));
  assert.deepEqual(await states(), {}, 'a planning status is not an execution state');
  const started = await s.begin(s.input(planned), 'member');
  assert.equal(started.intentId, issue, 'no successor: the journal status is planning history');
  const intent = JSON.parse(
    await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: issue }),
  );
  assert.deepEqual(
    [intent.version, intent.status, intent.base, intent.creatorAccountId, intent.assigneeAccountIds],
    [1, 'active', { head, receiptId: 'main-0' }, 'owner', ['member']],
  );
  assert.equal(intent.journal.title, 'Planned Issue', 'journal attributes are kept');
  assert.deepEqual(await states(), { [issue]: 'active' });
  // A pinned Intent is pinned once: a sibling start writes no further version.
  await s.begin(s.input(planned), 'member');
  assert.equal(
    [...s.tables.projectHostedRecords.values()].filter(row => row.kind === 'intent' && row.key === issue)
      .length,
    2,
  );
});

test('fails without: starting a planner-written Intent by its id marks it with its same-id Issue; an Intent with no Issue stays unmarked (fc1831eb)', async () => {
  const s = await setup(),
    issue = randomUUID(),
    alone = randomUUID();
  const copy = id =>
    s.call('copy', {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: null,
          record: {
            kind: 'intent',
            id,
            version: 0,
            at: '2026-11-10T00:00:00.000Z',
            outcome: 'Planned Issue',
            constraints: '',
            creatorAccountId: 'owner',
            assigneeAccountIds: [],
            status: 'active',
            journal: { createdAt: '2026-11-10T00:00:00.000Z', title: 'Planned Issue' },
          },
        }),
    });
  await copy(issue);
  await copy(alone);
  const intentHead = id =>
    [...s.tables.projectHostedRecordHeads.values()].find(row => row.kind === 'intent' && row.key === id);
  const { _id, _creationTime, ...template } = intentHead(issue);
  s.insert('projectHostedRecordHeads', { ...template, kind: 'issue' });
  assert.equal(intentHead(issue).planningItemId, undefined, 'the planner wrote no marker');
  await s.begin(s.input({ kind: 'existing', intentId: issue }), 'owner');
  await s.begin(s.input({ kind: 'existing', intentId: alone }), 'owner');
  assert.equal(intentHead(issue).planningItemId, issue, 'marked with its Issue, so its landing note posts');
  assert.equal(intentHead(alone).planningItemId, undefined, 'no Issue, no marker');
});

test('each planned start schedules one worker-owned status check; unplanned work and replays schedule none', async () => {
  const s = await setup();
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'member' });
  const moves = () => s.scheduled.filter(task => getFunctionName(task.fn) === 'projectPlanningStart:move');
  const planned = intentId => ({ kind: 'planned', intentId, outcome: 'Planned Issue', constraints: '' });
  const ownerItem = randomUUID();
  const ownerInput = s.input(planned(ownerItem));
  const ownerStart = await s.begin(ownerInput);
  assert.deepEqual(await s.begin(ownerInput), ownerStart);
  await s.begin(s.input({ kind: 'new', outcome: 'Unplanned work' }), 'member');
  assert.deepEqual(
    moves().map(task => task.args.itemId),
    [ownerItem],
  );
  const issue = randomUUID();
  const input = s.input(planned(issue));
  const started = await s.begin(input, 'member');
  assert.equal(started.intentId, issue);
  assert.deepEqual(
    moves().map(task => task.args),
    [
      {
        projectId: s.projectId,
        owner: 'owner',
        itemId: ownerItem,
        actor: 'owner',
        startOperationId: ownerInput.operationId,
      },
      {
        projectId: s.projectId,
        owner: 'owner',
        itemId: issue,
        actor: 'member',
        startOperationId: input.operationId,
      },
    ],
  );
  assert.deepEqual(await s.begin(input, 'member'), started, 'the replay returns the original start');
  assert.equal(moves().length, 2, 'and schedules nothing again');
});

test('incident 5c26c2ed: negotiated status names completed Lanes from the existing head read; legacy replies keep their shape', async () => {
  const s = await setup(),
    first = await s.begin(s.input());
  const original = JSON.parse(
    await s.invoke('detail', reads.detail, { projectId: s.projectId, laneId: first.lane.laneId }),
  );
  await s.invoke(
    'complete-state',
    {
      _handler: async ctx =>
        records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: original.version,
          record: {
            ...original,
            state: 'completed',
            version: original.version + 1,
            lifecycleVersion: original.lifecycleVersion + 1,
          },
        }),
    },
    {},
  );
  const input = { projectId: s.projectId, laneId: first.lane.laneId };
  const legacy = await s.invoke('legacy-head', reads.head, input);
  const negotiated = await s.invoke('negotiated-head', reads.head, { ...input, includeState: true });
  assert.equal('state' in legacy, false);
  assert.equal(negotiated.state, 'completed');
  assert.equal(negotiated.head, legacy.head);
  assert.equal(s.counts.at(-1).documents, s.counts.at(-2).documents, 'no additional document read');
});

// Model/app changes label new work, not a second execution of an already retained operation.
test('start retries after a model or app switch reconcile the same Lane', async () => {
  const s = await setup();
  const input = {
    ...s.input(),
    authorship: { kind: 'agent', declaration: 'unknown' },
    agentClient: 'fixture:model-one',
  };
  const first = await s.begin(input);
  const replay = await s.begin({
    ...input,
    authorship: { kind: 'agent', declaration: 'not-declared' },
    agentClient: 'another:model-two',
  });
  assert.deepEqual(replay, first);
  assert.equal([...s.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'lane').length, 1);
});

test('source stamp claims reject actor spoofing, person model/run claims and trailer injection', async () => {
  const { hostedStartSchema } = await import('../dist/hosted-lane.js');
  const { saveRequestSchema } = await import('../dist/hosted-save.js');
  const s = await setup(),
    input = s.input();
  const { projectId, ...request } = input;
  assert(
    !hostedStartSchema.safeParse({ ...request, authorship: { kind: 'agent', actor: 'forged' } }).success,
  );
  await assert.rejects(s.begin({ ...input, authorship: { kind: 'agent', actor: 'forged' } }));
  for (const patch of [
    { agentClient: 'fixture:model' },
    { agent: 'quiet-otter' },
    { authorship: { kind: 'person', declaration: 'unknown' } },
  ])
    assert(
      !hostedStartSchema.safeParse({ ...request, authorship: { kind: 'person' }, ...patch }).success,
      'a person cannot carry agent model/run fields',
    );
  const save = {
    operationId: randomUUID(),
    laneId: randomUUID(),
    authorityEpoch: 1,
    expected: { head, version: 0, sourceVersion: 0, lifecycleVersion: 0 },
    message: '',
    pages: null,
    pageCount: 0,
    changeCount: 0,
  };
  for (const patch of [{ agentClient: 'fixture:model' }, { agentRun: 'run-one' }])
    assert(!saveRequestSchema.safeParse({ ...save, authorship: { kind: 'person' }, ...patch }).success);
  assert(!saveRequestSchema.safeParse({ ...save, authorship: { kind: 'agent', actor: 'forged' } }).success);
  for (const bad of [
    ' model',
    'model ',
    'model\n',
    'model\nCo-Authored-By: fake <fake@example.invalid>',
    'model<fake>',
  ]) {
    assert(!hostedStartSchema.safeParse({ ...request, agentClient: `fixture:${bad}` }).success);
    assert(!saveRequestSchema.safeParse({ ...save, agentRun: bad }).success);
  }
});

test('new start writers retain declared, unknown and person stamps while legacy starts remain unstamped', async () => {
  for (const stamp of [
    { authorship: { kind: 'agent' }, agentClient: 'fixture:model-one', agent: 'quiet-otter' },
    { authorship: { kind: 'agent', declaration: 'unknown' }, agentClient: 'fixture', agent: 'quiet-otter' },
    { authorship: { kind: 'person' } },
    {},
  ]) {
    const s = await setup();
    const result = await s.begin({ ...s.input(), ...stamp });
    const selected = JSON.parse(
      await s.invoke('select', reads.select, { projectId: s.projectId, laneId: result.lane.laneId }),
    );
    assert.deepEqual(selected.authorship, stamp.authorship);
    assert.equal(selected.agentClient, stamp.agentClient);
    assert.equal(selected.agentRun, stamp.agent);
    assert.deepEqual(result.lane.authorship, selected.authorship);
    if (stamp.authorship) assert(!('actor' in selected.authorship));
  }
  const s = await setup();
  for (const authorship of [{ kind: 'agent' }, { kind: 'agent', declaration: 'not-declared' }])
    await assert.rejects(
      s.begin({ ...s.input(), authorship }),
      error =>
        (error.data?.code ?? error.code) === 'BAD_ARGUMENT' &&
        /model/.test(error.data?.message ?? error.message) &&
        /FORGE_AGENT_MODEL/.test(error.data?.message ?? error.message),
    );
});
