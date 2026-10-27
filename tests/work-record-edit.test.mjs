// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { editRecordProjection } from '../dist/work-record-edit.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-projection-edit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.txt'), 'synthetic source\n');
  initNative(root);
  const store = new WorkStore(root),
    data = store.load();
  const intent = {
    id: randomUUID(),
    outcome: 'Retain discussion',
    constraints: '',
    base: data.nativeHead,
    status: 'active',
    createdAt: new Date().toISOString(),
    notes: [{ kind: 'decision', at: new Date().toISOString(), text: 'Retained diagnosis' }],
  };
  data.intents.push(intent);
  store.locked(() => store.save(data));
  const tx = store.readRecords();
  t.after(() => tx.dispose());
  return { store, tx, id: intent.id };
}

for (const copy of [false, true])
  test(`projection rejects a changed compact record (${copy ? 'copied' : 'direct'})`, async t => {
    const { store, tx, id } = fixture(t),
      data = tx.data(),
      before = store.snapshotBytes();
    const compact = tx.fields('intents', id).record;
    data.intents = [copy ? { ...compact } : compact];
    assert.throws(
      () =>
        editRecordProjection(store, tx, data, ['intents'], current => {
          current.intents[0].notes.push({ kind: 'decision', at: new Date().toISOString(), text: 'New note' });
        }),
      { code: 'INVALID_WORK_STORE' },
    );
    assert.deepEqual(store.snapshotBytes(), before);
    assert.deepEqual(
      store.select('intents', id).notes.map(note => note.text),
      ['Retained diagnosis'],
    );
  });

test('projection permits full-record edits and leaves unchanged compact records read-only', async t => {
  const { store, tx, id } = fixture(t),
    data = tx.data(),
    before = store.snapshotBytes();
  data.intents = [tx.fields('intents', id).record];
  await editRecordProjection(store, tx, data, ['intents'], () => {});
  assert.deepEqual(store.snapshotBytes(), before);
  data.intents = [tx.find('intents', id).record];
  await editRecordProjection(store, tx, data, ['intents'], current => {
    current.intents[0].notes.push({ kind: 'decision', at: new Date().toISOString(), text: 'New note' });
  });
  assert.deepEqual(
    store.select('intents', id).notes.map(note => note.text),
    ['Retained diagnosis', 'New note'],
  );
});

test('projection continues to reject selected-record removal', t => {
  const { store, tx, id } = fixture(t),
    data = tx.data();
  data.intents = [tx.find('intents', id).record];
  assert.throws(
    () =>
      editRecordProjection(store, tx, data, ['intents'], current => {
        current.intents = [];
      }),
    { code: 'INVALID_WORK_STORE' },
  );
  assert.ok(store.select('intents', id));
});

for (const copy of [false, true])
  test(`projection rejects replacing a full selection with a compact result (${copy ? 'copied' : 'direct'})`, t => {
    const { store, tx, id } = fixture(t),
      data = tx.data(),
      before = store.snapshotBytes();
    data.intents = [tx.find('intents', id).record];
    assert.throws(
      () =>
        editRecordProjection(store, tx, data, ['intents'], current => {
          const compact = tx.fields('intents', id).record;
          compact.status = 'completed';
          current.intents[0] = copy ? { ...compact } : compact;
        }),
      { code: 'INVALID_WORK_STORE' },
    );
    assert.deepEqual(store.snapshotBytes(), before);
  });
