// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state, schemaRow, backupRow } from './hosted-fixture.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';

const retire = await import(moduleUrl('../convex/storageTombstoneRetire.ts'));

const digestOf = n => String(n).padStart(64, '0');
const keyOf = n => `v1/p/project/o/${digestOf(n)}`;
const tombstone = (n, size) =>
  schemaRow('legacyStorageTombstones', {
    _id: `tombstone-${n}`,
    _creationTime: n,
    storageId: `storage-${n}`,
    digest: digestOf(n),
    size,
    copyKey: keyOf(n),
    operationId: 'op',
  });
const bytesOf = n => Buffer.from(`copy ${n} bytes`);
const runner = s => ({
  runQuery: (ref, args) => retire[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
  runMutation: (ref, args) => retire[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
});

// F6 owner decision 7ac252f6: copies held only by legacy tombstones are deleted now; a copy a live
// row still names, or one whose size no longer matches its pin, is never deleted.
function seed(t) {
  const r2 = fakeSourceR2(t),
    s = state();
  for (const n of [1, 2, 3, 4, 5, 6]) {
    s.tables.legacyStorageTombstones.set(`tombstone-${n}`, tombstone(n, bytesOf(n).length));
    // Copy 4 is already gone from R2; copy 3 changed size since its pin.
    if (n !== 4) r2.objects.set(`/synthetic/${keyOf(n)}`, n === 3 ? Buffer.from('other') : bytesOf(n));
  }
  // Copy 2 is also a live source object's key; copy 5 is a backup's archive key; copy 6 is a live
  // object's key that no source names (review of Item c0af6cfa, finding anthropic-high).
  s.tables.projectObjects.set(
    'live',
    schemaRow('projectObjects', {
      _id: 'live',
      _creationTime: 1,
      projectId: 'project',
      digest: digestOf(2),
      size: bytesOf(2).length,
      nonce: 'n',
      removed: false,
      sourceReferenced: true,
      location: 'r2',
      r2Committed: true,
      r2Key: keyOf(2),
    }),
  );
  s.tables.projectObjects.set(
    'live-plain',
    schemaRow('projectObjects', {
      _id: 'live-plain',
      _creationTime: 2,
      projectId: 'project',
      digest: digestOf(6),
      size: bytesOf(6).length,
      nonce: 'n',
      removed: false,
      location: 'r2',
      r2Committed: true,
      r2Key: keyOf(6),
    }),
  );
  s.tables.projectBackups.set(
    'backup',
    backupRow({ _id: 'backup', location: 'r2', r2Committed: true, r2Key: keyOf(5) }),
  );
  // Receipts of the retired cleanup endpoints go; expiry and capsule receipts in the same table stay.
  [
    ['delete-1', 'op-1'],
    ['bench-2', 'op-2'],
    ['cursors', 'op-3'],
    ['online-retirement', 'op-4'],
    ['source:0', 'exhaust:op-5:source'],
    ['cursor', 'exhaust-catchup:v1:project'],
    ['callbacks:3', 'exhaust:op-6:callbacks'],
  ].forEach(([part, operationId], i) =>
    s.tables.legacyStorageCleanupPages.set(`receipt-${i}`, {
      _id: `receipt-${i}`,
      _creationTime: i + 1,
      operationId,
      part,
      request: 'r',
      result: '{}',
    }),
  );
  for (const n of [1, 2])
    s.tables.legacyStorageCleanupWindows.set(
      `window-${n}`,
      schemaRow('legacyStorageCleanupWindows', {
        _id: `window-${n}`,
        _creationTime: n,
        operationId: 'op',
        deployment: 'dev:synthetic',
        startedAt: 1,
        expiresAt: 2,
        active: false,
      }),
    );
  return { r2, s };
}

test('F6 tombstone copies: a dry run counts every copy and changes nothing', async t => {
  const { r2, s } = seed(t);
  const before = [...r2.objects.keys()].sort();
  const result = await retire.run._handler(runner(s), { apply: false });
  assert.equal(s.tables.legacyStorageCleanupPages.size, 7, 'a dry run deletes no receipt');
  assert.deepEqual(result, {
    tombstones: 6,
    tombstoneBytes: [1, 2, 3, 4, 5, 6].reduce((n, i) => n + bytesOf(i).length, 0),
    shared: 3,
    copies: 1,
    copyBytes: bytesOf(1).length,
    missing: 1,
    mismatched: 1,
    deleted: 0,
    deletedBytes: 0,
    rowsRemoved: 0,
    windows: 2,
    windowsRemoved: 0,
    receipts: 4,
    receiptBytes: result.receiptBytes,
  });
  assert.ok(result.receiptBytes > 0);
  assert.deepEqual([...r2.objects.keys()].sort(), before);
  assert.equal(s.tables.legacyStorageTombstones.size, 6);
  assert.equal(s.tables.legacyStorageCleanupWindows.size, 2);
});

test('F6 tombstone copies: apply deletes only copies held by a tombstone alone, drops settled rows and the windows, and a replay does nothing', async t => {
  const { r2, s } = seed(t);
  const result = await retire.run._handler(runner(s), { apply: true });
  assert.equal(result.deleted, 1);
  assert.equal(result.deletedBytes, bytesOf(1).length);
  assert.equal(result.windowsRemoved, 2);
  assert.equal(result.rowsRemoved, 5, 'the deleted, missing and three shared rows are dropped');
  assert.deepEqual(
    [...r2.objects.keys()].sort(),
    [2, 3, 5, 6].map(n => `/synthetic/${keyOf(n)}`).sort(),
    'the live object copies, the backup copy and the changed copy stay',
  );
  assert.equal(result.receipts, 4);
  assert.deepEqual(
    [...s.tables.legacyStorageCleanupPages.values()].map(row => row.part).sort(),
    ['callbacks:3', 'cursor', 'source:0'],
    'only the retired endpoints receipts go',
  );
  assert.deepEqual([...s.tables.legacyStorageTombstones.keys()], ['tombstone-3'], 'a size mismatch stays');
  assert.equal(s.tables.legacyStorageCleanupWindows.size, 0);
  const again = await retire.run._handler(runner(s), { apply: true });
  assert.deepEqual([again.deleted, again.rowsRemoved, again.mismatched, again.windows], [0, 0, 1, 0]);
  assert.doesNotMatch(JSON.stringify(result), /v1\/p|storage-/, 'counts and bytes only, never keys');
});

test('F6 tombstone copies: a reference published between the page read and the delete stops that delete', async t => {
  const { r2, s } = seed(t);
  const base = runner(s);
  let paged = false;
  const result = await retire.run._handler(
    {
      runQuery: async (ref, args) => {
        const value = await base.runQuery(ref, args);
        // A normal upload of the same content lands right after the page said copy 1 was sole.
        if (!paged && getFunctionName(ref) === 'storageTombstoneRetire:page') {
          paged = true;
          s.tables.projectObjects.set(
            'late',
            schemaRow('projectObjects', {
              _id: 'late',
              _creationTime: 9,
              projectId: 'project',
              digest: digestOf(1),
              size: bytesOf(1).length,
              nonce: 'n',
              removed: false,
              location: 'r2',
              r2Committed: true,
              r2Key: keyOf(1),
            }),
          );
        }
        return value;
      },
      runMutation: base.runMutation,
    },
    { apply: true },
  );
  assert.equal(result.deleted, 0);
  assert.ok(r2.objects.has(`/synthetic/${keyOf(1)}`), 'the copy a live row now names stays');
});
