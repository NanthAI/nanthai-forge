// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { planningWork } from '../dist/work-planning.js';
import { migrateIntentWork, intentMigrationReceiptFile } from '../dist/work-intent-migration.js';
import { convertWork15To16, convertWorkTo18 } from '../dist/work-intent-converter.js';
import { prepareNativeExchange } from '../dist/native-exchange.js';
import { hostedPushWork, intentState } from '../dist/work-intent-local.js';
import { planningCommandSchema } from '../dist/work-planning-types.js';
import { unifiedWorkSchema } from '../dist/work-unified-types.js';
import { recordReferences, buildWorkRecords } from '../dist/work-exchange-records.js';
import { buildExchangeRoot, readByteTree } from '../dist/native-exchange-tree.js';
import { parseWorkBytes } from '../dist/work-metadata.js';

const at = '2026-01-01T00:00:00Z',
  hash = 'a'.repeat(64),
  id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const planned = (n, extra = {}) => ({
  id: id(n),
  operationId: id(n + 1000),
  request: hash,
  version: 1,
  previousVersion: 0,
  kind: 'issue',
  title: `Planning ${n}`,
  body: 'Synthetic details',
  status: 'open',
  intentIds: [],
  at,
  provenance: 'user-declared-local',
  ...extra,
});

async function owner(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-intent-local-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.txt'), 'synthetic\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = new WorkStore(root),
    work = new WorkService(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Execution outcome' })).result;
  const pointer = () => readFileSync(join(store.directory, 'work.json'));
  const plan = command => planningWork(store, planningCommandSchema.parse(command), store.revision()).result;
  return { root, agent, store, work, lane, pointer, plan };
}
/** A schema-15 owner with one folded Issue, one unlinked Issue, one Initiative and a legacy ready fact. */
async function legacyOwner(t) {
  const f = await owner(t);
  const initiative = id(50),
    folded = id(51),
    unlinked = id(52);
  f.store.locked(() => {
    const data = f.store.load();
    data.schema = 15;
    data.intents[0].status = 'ready';
    data.intents[0].notes.push({ text: 'Synthetic note', kind: 'comment', at });
    data.planningItems.push(
      planned(50, { kind: 'initiative', title: 'Group', intentIds: [] }),
      planned(51, { intentIds: [f.lane.intentId], initiativeId: initiative }),
      planned(52, { initiativeId: initiative }),
    );
    data.planningComments.push({
      id: id(60),
      itemId: folded,
      request: hash,
      authorLabel: '',
      text: 'Synthetic comment',
      at,
      provenance: 'user-declared-local',
    });
    data.revision++;
    f.store.save(data);
  });
  return { ...f, initiative, folded, unlinked };
}

test('migration switches atomically and a crash before the switch leaves schema 15 intact', async t => {
  const f = await legacyOwner(t),
    before = f.pointer(),
    revision = f.store.revision();
  assert.throws(
    () =>
      migrateIntentWork(f.store, {
        beforeSwitch() {
          throw new Error('Crash before switch');
        },
      }),
    /Crash before switch/,
  );
  assert.deepEqual(f.pointer(), before);
  assert.equal(f.store.load().schema, 15);
  assert.equal(f.store.revision(), revision);
  const crashed = JSON.parse(readFileSync(join(f.store.directory, intentMigrationReceiptFile), 'utf8'));
  const result = migrateIntentWork(f.store);
  assert.equal(result.migrated, true);
  assert.equal(result.migrationId, crashed.migrationId);
  assert.equal(result.fromRevision, revision);
  const data = f.store.load();
  assert.equal(data.schema, 18);
  assert.equal(data.revision, revision + 1);
  assert.equal(unifiedWorkSchema.safeParse(data).success, true);
});

test('retry after the switch is idempotent and writes nothing', async t => {
  const f = await legacyOwner(t);
  const first = migrateIntentWork(f.store),
    pointer = f.pointer(),
    receipt = readFileSync(join(f.store.directory, intentMigrationReceiptFile));
  const again = migrateIntentWork(f.store);
  assert.equal(again.migrated, false);
  assert.equal(again.migrationId, first.migrationId);
  assert.deepEqual(again.receipt, first.receipt);
  assert.deepEqual(f.pointer(), pointer);
  assert.deepEqual(readFileSync(join(f.store.directory, intentMigrationReceiptFile)), receipt);
  // The explicit work command reaches the same receipt.
  const viaCommand = await f.work.dispatch({ action: 'migrate-intents' }, f.store.revision());
  assert.equal(viaCommand.result.migrationId, first.migrationId);
});

test('receipt counts match the stored Work and the pure converter', async t => {
  const f = await legacyOwner(t),
    original = f.store.load();
  const expected = convertWorkTo18(original).intentMergeReceipt;
  const { receipt } = migrateIntentWork(f.store),
    data = f.store.load();
  assert.deepEqual(receipt, expected);
  assert.deepEqual(receipt.counts.before, {
    intents: 1,
    issues: 2,
    initiatives: 1,
    versions: 3,
    comments: 1,
    notes: 1,
  });
  assert.equal(receipt.counts.foldedPairs, 1);
  assert.equal(data.intents.length, receipt.counts.before.intents + receipt.counts.before.issues - 1);
  assert.equal(data.intentAliases.length, 1);
  assert.equal(data.planningItems.length, 3);
  // Legacy copies are paged records, never inline in the commit pointer.
  assert.equal(JSON.parse(f.pointer()).fields.legacyIntentMerge, undefined);
  assert.equal(JSON.parse(f.store.snapshotBytes()).legacyIntentMerge.planningItems.length, 3);
  assert.equal(data.lanes[0].intentId, f.lane.intentId);
  assert.ok(data.intents.some(intent => intent.id === data.lanes[0].intentId));
});

test('lifecycle: ready becomes active, ready requests stay history, and status derives from Lanes', async t => {
  const f = await legacyOwner(t);
  migrateIntentWork(f.store);
  let intent = f.store.load().intents.find(item => item.id === f.lane.intentId);
  assert.equal(intent.status, 'active');
  assert.equal(intentState(intent.status, 1), 'In motion');
  await f.work.dispatch(
    { action: 'intent-status', intentId: f.lane.intentId, status: 'ready' },
    f.store.revision(),
  );
  intent = f.store.load().intents.find(item => item.id === f.lane.intentId);
  assert.equal(intent.status, 'active');
  assert.deepEqual(
    intent.lifecycle.map(entry => [entry.from, entry.to]),
    [['active', 'ready']],
  );
  const issue = f.store.load().intents.find(item => item.id === f.unlinked);
  assert.equal(issue.base, undefined);
  assert.equal(intentState(issue.status, 0), 'Planned');
  assert.equal(intentState('completed', 2), 'Done');
  assert.equal(intentState('abandoned', 0), 'Done');
  assert.equal(intentState('proposed', 0), 'Proposed');
});

test('notes added after migration receive stable conversation identities', async t => {
  const f = await legacyOwner(t);
  migrateIntentWork(f.store);
  await f.work.dispatch(
    { action: 'note', intentId: f.lane.intentId, kind: 'decision', text: 'Second note' },
    f.store.revision(),
  );
  const intent = f.store.load().intents.find(item => item.id === f.lane.intentId);
  const notes = intent.conversation.filter(entry => entry.kind === 'note');
  assert.deepEqual(
    notes.map(entry => entry.index),
    [0, 1],
  );
  assert.equal(new Set(intent.conversation.map(entry => entry.id)).size, intent.conversation.length);
  assert.ok(intent.conversation.some(entry => entry.kind === 'planning-comment' && entry.id === id(60)));
});

test('alias resolution: legacy Issue IDs update and discuss the folded Intent in one version chain', async t => {
  const f = await legacyOwner(t);
  migrateIntentWork(f.store);
  const put = {
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: f.folded,
    expectedVersion: 1,
    kind: 'issue',
    title: 'Renamed outcome',
    body: 'New description',
    status: 'in-progress',
    intentIds: [],
  };
  const version = f.plan(put);
  assert.equal(version.id, f.folded);
  assert.equal(version.version, 2);
  // Writing through the Intent ID continues the same chain.
  f.plan({ ...put, operationId: randomUUID(), itemId: f.lane.intentId, expectedVersion: 2, title: 'Third' });
  const comment = f.plan({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: f.folded,
    text: 'Via alias',
  });
  const data = f.store.load(),
    intent = data.intents.find(item => item.id === f.lane.intentId);
  assert.equal(
    data.intents.some(item => item.id === f.folded),
    false,
  );
  assert.equal(intent.title, 'Third');
  assert.equal(intent.outcome, 'Third');
  assert.equal(intent.description, 'New description');
  assert.equal(intent.version, 3);
  assert.equal(intent.status, 'active', 'execution status owns a started Intent');
  assert.deepEqual(
    intent.historyRefs.map(ref => ref.version),
    [1, 2, 3],
  );
  assert.ok(intent.conversation.some(entry => entry.id === comment.id));
  assert.throws(() => f.plan({ ...put, operationId: randomUUID(), expectedVersion: 1 }), {
    code: 'PLANNING_CHANGED',
  });
  // Retrying the original operation returns its retained version without writing.
  const revision = f.store.revision();
  assert.deepEqual(f.plan(put), version);
  assert.equal(f.store.revision(), revision);
});

test('new Issues become planned Intents with memberships and capture a pin at their first Lane', async t => {
  const f = await legacyOwner(t);
  migrateIntentWork(f.store);
  const itemId = randomUUID();
  f.plan({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    kind: 'issue',
    title: 'Planned work',
    initiativeId: f.initiative,
    intentIds: [f.folded],
  });
  let data = f.store.load(),
    intent = data.intents.find(item => item.id === itemId);
  assert.equal(intent.base, undefined);
  assert.equal(intent.status, 'active');
  assert.deepEqual(intent.relatedIntentIds, [f.lane.intentId], 'the alias resolves to its Intent');
  assert.ok(data.intents.find(item => item.id === f.lane.intentId).relatedIntentIds.includes(itemId));
  const group = data.initiatives.find(item => item.id === f.initiative);
  const mine = intent.memberships.find(item => item.initiativeId === f.initiative);
  assert.equal(mine.order, group.nextMembershipOrder - 1);
  await assert.rejects(
    f.work.dispatch({ action: 'lane', intentId: itemId, name: 'No pin' }, f.store.revision()),
    { code: 'INTENT_NOT_STARTED' },
  );
  const lane = (await f.agent.dispatch({ action: 'start', intentId: itemId, outcome: 'Planned work' }))
    .result;
  data = f.store.load();
  intent = data.intents.find(item => item.id === itemId);
  assert.equal(lane.intentId, itemId);
  assert.equal(intent.base, data.lanes.find(item => item.id === lane.laneId).base);
  // Removing the Initiative clears this Issue's placement.
  f.plan({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    expectedVersion: 1,
    kind: 'issue',
    title: 'Planned work',
    status: 'closed',
    intentIds: [],
  });
  intent = f.store.load().intents.find(item => item.id === itemId);
  assert.equal(intent.memberships.length, 0);
  assert.equal(intent.status, 'active', 'a started Intent keeps its execution status');
});

test('closing an unstarted Issue completes its planned Intent', async t => {
  const f = await legacyOwner(t);
  migrateIntentWork(f.store);
  f.plan({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: f.unlinked,
    expectedVersion: 1,
    kind: 'issue',
    title: 'Planning 52',
    status: 'closed',
    initiativeId: f.initiative,
  });
  const intent = f.store.load().intents.find(item => item.id === f.unlinked);
  assert.equal(intent.status, 'completed');
  assert.equal(intentState(intent.status, 0), 'Done');
  assert.equal(intent.memberships.length, 1, 'an unchanged placement is retained');
});

test('Initiative direct links become memberships and Initiatives stay grouping records', async t => {
  const f = await legacyOwner(t);
  migrateIntentWork(f.store);
  f.plan({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: f.initiative,
    expectedVersion: 1,
    kind: 'initiative',
    title: 'Renamed group',
    intentIds: [f.unlinked],
  });
  const data = f.store.load();
  assert.equal(data.initiatives.length, 1);
  assert.equal(data.initiatives[0].title, 'Renamed group');
  assert.equal(
    data.intents.some(item => item.id === f.initiative),
    false,
  );
  const direct = data.intents
    .find(item => item.id === f.unlinked)
    .memberships.filter(item => item.sourceId === f.initiative);
  assert.equal(direct.length, 1);
  assert.throws(
    () =>
      f.plan({
        action: 'put-planning-item',
        operationId: randomUUID(),
        itemId: f.initiative,
        expectedVersion: 2,
        kind: 'issue',
        title: 'Wrong kind',
      }),
    { code: 'BAD_ARGUMENT' },
  );
});

test('hosted push preserves unified fields and unpinned Intents', async t => {
  const f = await legacyOwner(t);
  migrateIntentWork(f.store);
  const data = f.store.load();
  const pushed = hostedPushWork(data);
  assert.equal(pushed.schema, 18);
  assert.equal(unifiedWorkSchema.safeParse(pushed).success, true);
  assert.deepEqual(pushed, data);
  const prepared = await prepareNativeExchange(
    f.store,
    data.revision,
    randomUUID(),
    true,
    undefined,
    undefined,
    {
      recordMetadata: true,
    },
  );
  assert.deepEqual(JSON.parse(readFileSync(join(prepared.directory, 'work.json'), 'utf8')), data);
  assert.ok(pushed.intents.some(intent => intent.id === f.unlinked && intent.base === undefined));
});

test('planned Intents round-trip record-enabled push preparation after migration and real planning writes', async t => {
  const f = await legacyOwner(t);
  migrateIntentWork(f.store);
  const itemId = randomUUID();
  f.plan({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    kind: 'issue',
    title: 'Synthetic planned work',
  });
  const data = f.store.load();
  for (const id of [f.unlinked, itemId]) {
    const intent = data.intents.find(item => item.id === id);
    assert.equal(intent.base, undefined);
    assert.deepEqual(recordReferences('intents', intent, data.schema), []);
    assert.deepEqual(recordReferences('intents', intent, 16), [], 'historical unified format stays readable');
    assert.throws(
      () => recordReferences('intents', intent, 15),
      error =>
        error.code === 'INVALID_WORK_BACKUP' &&
        error.message.includes(`intents/${id}`) &&
        error.message.includes('["base"]'),
    );
  }
  const intent = data.intents.find(item => item.id === itemId);
  intent.opaque = { laneId: randomUUID() };
  intent.memberships.push({
    initiativeId: f.initiative,
    sourceId: f.initiative,
    order: 0,
    opaque: { laneId: randomUUID() },
  });
  assert.deepEqual(recordReferences('intents', intent, 18), [], 'extensions never supply reference pins');
  assert.throws(
    () => recordReferences('intents', { ...intent, base: 12, description: 'PRIVATE_SENTINEL' }, 18),
    error =>
      error.code === 'INVALID_WORK_BACKUP' &&
      error.message.includes(`intents/${itemId}`) &&
      error.message.includes('["base"]') &&
      !error.message.includes('PRIVATE_SENTINEL'),
  );
  assert.equal(
    buildWorkRecords(data),
    undefined,
    'unified collections retain the complete compatibility path',
  );
  const bytes = Buffer.from(JSON.stringify(data, null, 2));
  const encoded = buildExchangeRoot(Buffer.from('{}'), bytes, { records: true });
  assert.equal(encoded.root.schema, 1);
  const restored = await readByteTree(encoded.root.work, async pins =>
    pins.map(pin => encoded.objects.get(pin.sha256)),
  );
  assert.deepEqual(restored, bytes);
  assert.deepEqual(
    parseWorkBytes(restored).intents,
    data.intents,
    'the shared hosted validator preserves extensions and unpinned Intents',
  );
});

test('real-shape fixture migrates through the store with Lane and View references intact', async t => {
  const f = await owner(t),
    counts = JSON.parse(
      readFileSync(new URL('./fixtures/intent-merge-owner-counts.json', import.meta.url), 'utf8'),
    );
  f.store.locked(() => {
    const data = f.store.load();
    data.schema = 15;
    data.intents = counts.intentShape.map(item => ({
      id: id(item.id),
      outcome: `Outcome ${item.id}`,
      constraints: '',
      base: hash,
      status: item.status,
      notes: Array.from({ length: item.notes }, () => ({ text: 'Synthetic note', kind: 'comment', at })),
      createdAt: at,
    }));
    data.lanes = counts.laneIntentOrdinals.map((target, index) => ({
      ...data.lanes[0],
      id: id(20000 + index),
      intentId: id(target),
    }));
    data.views = counts.viewIntentOrdinals.map((target, index) => ({
      id: id(30000 + index),
      intentId: id(target),
      base: hash,
      inputs: [],
      status: 'clean',
      head: hash,
      details: '',
      at,
    }));
    data.planningItems = counts.planningShape.map(item =>
      planned(item.id, {
        ...item,
        id: id(item.id),
        intentIds: item.intentIds.map(id),
        ...(item.initiativeId ? { initiativeId: id(item.initiativeId) } : {}),
      }),
    );
    data.planningComments = counts.commentTargets.map((target, index) => ({
      id: id(9000 + index),
      itemId: id(target),
      request: hash,
      authorLabel: '',
      text: 'Synthetic comment',
      at,
      provenance: 'user-declared-local',
    }));
    data.revision++;
    f.store.save(data);
  });
  const { receipt } = migrateIntentWork(f.store),
    data = f.store.load(),
    ids = new Set(data.intents.map(item => item.id));
  assert.equal(data.lanes.length, counts.lanes);
  assert.equal(data.views.length, counts.views);
  assert.ok(data.lanes.every(lane => ids.has(lane.intentId)));
  assert.ok(data.views.every(view => ids.has(view.intentId)));
  assert.equal(receipt.counts.before.intents, counts.intents);
  assert.equal(receipt.counts.before.versions, counts.planningVersions);
  assert.equal(receipt.counts.before.notes, counts.notes);
  assert.equal(
    data.intents.length,
    counts.intents + receipt.counts.before.issues - receipt.counts.foldedPairs,
  );
  assert.equal(data.planningComments.length, counts.planningComments);
  assert.equal(unifiedWorkSchema.safeParse(hostedPushWork(data)).success, true);
});

test('historical format16 migrates to18 without folding again or rewriting its receipt', async t => {
  const f = await legacyOwner(t);
  f.store.locked(() => {
    const data = convertWork15To16(f.store.load());
    data.initiatives[0].nextMembershipOrder = 100;
    f.store.save(data);
  });
  const before = f.store.load();
  assert.equal(before.schema, 16);
  migrateIntentWork(f.store);
  const after = f.store.load();
  assert.equal(after.schema, 18);
  assert.deepEqual(after.intents, before.intents);
  assert.equal(after.initiatives[0].nextMembershipOrder, 100);
  assert.deepEqual(after.intentMergeReceipt, before.intentMergeReceipt);
  assert.deepEqual(after.legacyIntentMerge, before.legacyIntentMerge);
  const pointer = f.pointer();
  assert.equal(migrateIntentWork(f.store).migrated, false);
  assert.deepEqual(f.pointer(), pointer);
});

test('recovered format18 retains its conversion receipt without inventing local migration facts', async t => {
  const f = await legacyOwner(t);
  const unified = convertWorkTo18(f.store.load());
  f.store.save(unified);
  const before = f.pointer();
  const result = migrateIntentWork(f.store);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.receipt, unified.intentMergeReceipt);
  assert.equal(result.fromRevision, undefined);
  assert.deepEqual(f.pointer(), before);
});
