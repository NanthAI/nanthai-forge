// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { hostedLaneSelectionSchema } from '../dist/hosted-lane.js';
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

test('unrelated concurrent starts write distinct resources and need no global revision retry', async () => {
  const s = await setup();
  const [a, b] = await Promise.all([s.begin(), s.begin()]);
  assert.notEqual(a.intentId, b.intentId);
  assert.notEqual(a.lane.laneId, b.lane.laneId);
  assert.equal(s.tables.projectHostedRecords.size, 4);
  assert.equal(s.tables.projectHostedOperations.size, 3);
  assert(s.counts.every(c => c.retries === 0));
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

test('planned start gives the Intent the Issue id, adds sibling Lanes, and reports Intent state per Issue', async () => {
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
  // One project read plus one indexed head read per Issue; never a body or a scan.
  assert(s.counts.at(-1).documents <= 3 && s.counts.at(-1).writes === 0, 'head reads only');
  await s.call('states', planning.intentStates, {
    projectId: s.projectId,
    ids: Array.from({ length: 100 }, () => randomUUID()),
  });
  assert(s.counts.at(-1).documents <= 101 && s.counts.at(-1).writes === 0, '100 Issues: 101 reads');
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

  // A finished Intent is not restarted; the Issue must be reopened.
  const original = JSON.parse(
    await s.invoke('intent', reads.intent, { projectId: s.projectId, intentId: issue }),
  );
  await s.call('complete', {
    _handler: ctx =>
      records.writeHostedRecord(ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: 0,
        record: { ...original, version: 1, status: 'completed' },
      }),
  });
  assert.deepEqual(
    JSON.parse(await s.invoke('states', planning.intentStates, { projectId: s.projectId, ids: [issue] })),
    { [issue]: 'completed' },
  );
  await assert.rejects(s.begin(s.input(planned)), code('INTENT_CLOSED'));
  // Another account cannot attach Lanes to someone else's Intent by naming its Issue id.
  await assert.rejects(s.begin(s.input({ ...planned, intentId: first.intentId }), 'stranger'));
});
