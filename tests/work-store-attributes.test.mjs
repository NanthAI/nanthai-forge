// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { indexedRecord, intentHeader } from '../dist/work-hosted-index.js';
import { assembleIndexValue } from '../dist/work-index-value.js';
import { workStoreRecord } from '../dist/work-store-records.js';
import { WorkStore } from '../dist/work-store.js';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const store = await import(moduleUrl('../convex/projectWorkStore.ts'));
const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const { hostedRecordBody, recordHead } = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const intent = (id = randomUUID(), base = 'a'.repeat(64)) => ({
  id,
  base,
  outcome: 'Imported attributes',
  constraints: '',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  notes: [],
  payload: { imported: true },
  payloadKey: 'source attribute',
  payloadParts: 19,
  extension: { nested: ['preserved', { unicode: 'λ🌍' }] },
});

test('canonical Intent copy retains imported attributes whose names also occur in projection headers', () => {
  const original = intent();
  const entries = indexedRecord('intents', original.id, '', 0, original, intentHeader(original));
  const header = JSON.parse(entries[0].value);
  assert.notEqual(header.payloadKey, original.payloadKey);
  const hydrated = assembleIndexValue('intents', header, entries.slice(1));
  const canonical = workStoreRecord('intents', hydrated, { owner: 'owner', version: 0 });
  for (const key of ['payload', 'payloadKey', 'payloadParts', 'extension'])
    assert.deepEqual(canonical.journal[key], original[key], key);
  assert(!Object.hasOwn(canonical.journal, 'notes'), 'notes keep their separate retained records');
});

test('an Intent created in Work retains its independent origin when written to the hosted record store', async t => {
  const s = await setup(t);
  const base = (await s.read()).sourceHead;
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const intentId = randomUUID();
  await s.send({ action: 'intent', operationId: intentId, outcome: 'Independent Work Intent', base });
  const origin = async () => (await recordHead(s.ctx, s.projectId, 'intent', intentId))?.planningItemId;
  assert.equal(await origin(), '');
  await s.send({ action: 'intent-status', intentId, status: 'ready' });
  assert.equal(await origin(), '', 'a later update preserves the independent origin');
});

test('an Intent written in the projection that creates its Item is born bound to it, any other is not', async t => {
  const s = await setup(t);
  const base = (await s.read()).sourceHead;
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const item = s.item({ title: 'Planned' });
  await s.send(item);
  const born = await recordHead(s.ctx, s.projectId, 'intent', item.itemId);
  assert.equal(
    born?.planningItemId,
    item.itemId,
    'a planned Item’s own Intent is bound when the Item is created',
  );
  const stored = (id, bound) =>
    store.storeIntent(s.ctx, s.projectId, 'owner', intent(id, base), true, undefined, { bound });
  await stored(item.itemId, true);
  const stranger = randomUUID();
  await stored(stranger, false);
  const marker = id => recordHead(s.ctx, s.projectId, 'intent', id).then(head => head?.planningItemId);
  assert.equal(await marker(item.itemId), item.itemId);
  assert.equal(await marker(stranger), undefined, 'no Item of that id: nothing to bind');
});

test('legacy copy and status mutations preserve imported attributes before data projections can retire', async t => {
  const id = randomUUID();
  let original;
  const s = await setup(t, true, root => {
    const local = new WorkStore(root),
      data = local.load();
    original = intent(id, data.nativeHead);
    data.intents.push(original, intent());
    data.intents[1].base = data.nativeHead;
    data.revision++;
    local.save(data);
  });
  const initialRows = [...s.tables.projectWorkDataRecords.values()];
  console.log(
    JSON.stringify({
      initialLegacyDataRows: initialRows.length,
      collections: Object.fromEntries(
        [...new Set(initialRows.map(r => r.collection))].map(collection => [
          collection,
          initialRows.filter(r => r.collection === collection).length,
        ]),
      ),
    }),
  );
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const copy = () =>
    store.copy._handler(s.ctx, { projectId: s.projectId, collection: 'intents', cursor: null });
  const copied = JSON.parse(await copy());
  assert.equal(copied.copied, 0);
  assert.equal(copied.same, 2, 'the imported records already match their original Work bytes');
  assert.equal((await recordHead(s.ctx, s.projectId, 'intent', id)).planningItemId, undefined);
  const body = async () => {
    const head = [...s.tables.projectHostedRecordHeads.values()].find(
      row => row.kind === 'intent' && row.key === id,
    );
    return JSON.parse(await hostedRecordBody(s.ctx, s.tables.projectHostedRecords.get(head.recordId)));
  };
  const check = async () => {
    const record = await body();
    for (const key of ['payload', 'payloadKey', 'payloadParts', 'extension'])
      assert.deepEqual(record.journal[key], original[key], key);
    return record;
  };
  await check();
  // A retained canonical copy alone is not yet the selected-attribute reader.
  // Losing the old chunks must fail before an event is published, never turn a
  // valid source extension into an empty attribute set.
  const missing = initialRows.filter(row => row.collection === 'intents:payload');
  for (const row of missing) s.tables.projectWorkDataRecords.delete(row._id);
  const events = s.tables.projectWorkEvents.size;
  await assert.rejects(
    commands.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: randomUUID(),
      command: JSON.stringify({ action: 'intent-status', intentId: id, status: 'completed' }),
    }),
    error => (error.code ?? error.data?.code) === 'WORK_STALE',
  );
  assert.equal(s.tables.projectWorkEvents.size, events);
  for (const row of missing) s.tables.projectWorkDataRecords.set(row._id, row);
  assert.equal(JSON.parse(await copy()).same, 2, 'copy retry preserves exact immutable versions');
  await s.send({ action: 'intent-status', intentId: id, status: 'completed' });
  assert.equal((await check()).status, 'completed');
  const rows = [...s.tables.projectWorkDataRecords.values()];
  console.log(
    JSON.stringify({
      legacyDataRows: rows.length,
      collections: Object.fromEntries(
        [...new Set(rows.map(r => r.collection))].map(collection => [
          collection,
          rows.filter(r => r.collection === collection).length,
        ]),
      ),
    }),
  );
});
