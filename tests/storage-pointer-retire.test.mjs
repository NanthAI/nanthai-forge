// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state, schemaRow, backupRow } from './hosted-fixture.mjs';

const { page, run, continuationPage, proofRows } = await import(
  moduleUrl('../convex/storagePointerRetire.ts')
);

const r2 = digest => ({ location: 'r2', r2Key: `v1/p/project/o/${digest}`, r2Committed: true });
const object = (id, at, fields) =>
  schemaRow('projectObjects', {
    _id: id,
    _creationTime: at,
    projectId: 'project',
    digest: String(at).padStart(64, '0'),
    size: 1,
    nonce: 'n',
    removed: false,
    ...fields,
  });
function seed(total) {
  const s = state();
  for (let i = 0; i < total; i++) {
    const digest = i.toString(16).padStart(64, '0');
    // Every third row shares its pointer with the next row (deduplicated bytes), so pages must
    // keep rows of one id in order; every 50th row has no R2 copy and must stay untouched.
    const storageId = `storage-${String(Math.floor(i / 3) * 3 + (i % 3 === 2 ? 1 : 0)).padStart(5, '0')}`;
    s.tables.projectObjects.set(
      `object-${i}`,
      object(`object-${i}`, i + 1, { digest, storageId, ...(i % 50 === 7 ? {} : r2(digest)) }),
    );
  }
  s.tables.projectObjects.set('current', object('current', total + 1, r2('f'.repeat(64))));
  return s;
}
async function drain(s, table, apply, owned = []) {
  const total = { pages: 0, scanned: 0, cleared: 0, blocked: 0, blockedIds: [] };
  let cursor = null;
  do {
    const next = await page._handler(s.ctx, { table, cursor, apply, owned });
    assert.ok(next.scanned <= 256, 'a page stays inside its row cap');
    total.pages++;
    total.scanned += next.scanned;
    total.cleared += next.cleared;
    total.blocked += next.blocked;
    total.blockedIds.push(...next.blockedIds);
    cursor = next.cursor;
  } while (cursor !== null && total.pages < 100);
  return total;
}
// The action runs one page per mutation; this context runs them against the fixture, and names
// fixture storage ids the way Convex's `db.system.normalizeId('_storage', ...)` would.
const withStorageIds = ctx => ({
  ...ctx,
  db: {
    ...ctx.db,
    system: { ...ctx.db.system, normalizeId: (_t, id) => (/^storage-/.test(id) ? id : null) },
  },
});
const runner = (s, between = () => {}) => ({
  runQuery: (_fn, args) => continuationPage._handler(withStorageIds(s.ctx), args),
  runMutation: async (_fn, args) => {
    const result = await page._handler(s.ctx, args);
    between(args, result);
    return result;
  },
});

test('F6 dry run counts every old storage pointer and writes nothing', async () => {
  const s = seed(700);
  const before = structuredClone([...s.tables.projectObjects.values()]);
  const dry = await drain(s, 'projectObjects', false);
  assert.equal(dry.scanned, 700);
  assert.equal(dry.blocked, 14);
  assert.equal(dry.cleared, 686);
  assert.deepEqual([...s.tables.projectObjects.values()], before);
});

test('F6 converter clears pointers only where bytes read from committed R2, never skipping rows of one id across pages', async () => {
  const s = seed(700);
  const result = await drain(s, 'projectObjects', true);
  assert.ok(result.pages >= 3, 'the run spans several bounded pages');
  assert.equal(result.cleared, 686);
  const rows = [...s.tables.projectObjects.values()];
  assert.deepEqual(
    rows
      .filter(row => row.storageId !== undefined)
      .map(row => row._id)
      .sort(),
    result.blockedIds.sort(),
    'only rows without an R2 copy keep their pointer',
  );
  // A replay finds only the blocked rows and clears nothing more.
  const again = await drain(s, 'projectObjects', true);
  assert.equal(again.cleared, 0);
  assert.equal(again.scanned, 14);
});

test('F6 review 77acbe23: a removed or purged row without a committed R2 copy keeps its pointer', async () => {
  const s = state();
  s.tables.projectObjects.set('removed', object('removed', 1, { removed: true, storageId: 'storage-a' }));
  s.tables.projectObjects.set(
    'purged',
    object('purged', 2, { purged: { at: 1, operationId: 'op' }, storageId: 'storage-b' }),
  );
  s.tables.projectObjects.set(
    'removed-r2',
    object('removed-r2', 3, { removed: true, storageId: 'storage-c', ...r2('c'.repeat(64)) }),
  );
  const result = await drain(s, 'projectObjects', true);
  assert.equal(result.cleared, 0);
  assert.equal(result.blocked, 3);
  assert.ok([...s.tables.projectObjects.values()].every(row => row.storageId !== undefined));
});

test('F6 review 77acbe23: a page stays inside its row cap when 1,000 rows share one old id', async () => {
  const s = state();
  for (let i = 0; i < 1000; i++)
    s.tables.projectObjects.set(
      `same-${i}`,
      object(`same-${i}`, i + 1, { storageId: 'storage-same', ...r2(String(i).padStart(64, '0')) }),
    );
  const pages = [];
  let cursor = null;
  do {
    const next = await page._handler(s.ctx, { table: 'projectObjects', cursor, apply: false });
    pages.push(next.scanned);
    cursor = next.cursor;
  } while (cursor !== null && pages.length < 20);
  assert.ok(Math.max(...pages) <= 256, `pages scanned ${pages}`);
  assert.equal(
    pages.reduce((a, b) => a + b, 0),
    1000,
    'every row of the group is visited once',
  );
  const applied = await drain(s, 'projectObjects', true);
  assert.equal(applied.cleared, 1000);
});

test('F6 review 77acbe23: a page stays inside its byte cap', async () => {
  const s = state();
  // ~10 KiB rows: 1 MiB holds about 100 of them, well under the row cap.
  for (let i = 0; i < 300; i++)
    s.tables.projectObjects.set(
      `wide-${i}`,
      object(`wide-${i}`, i + 1, {
        storageId: 'storage-wide',
        stateParents: Array.from({ length: 150 }, (_, n) => String(n).padStart(64, '0')),
        ...r2(String(i).padStart(64, '0')),
      }),
    );
  const first = await page._handler(s.ctx, {
    table: 'projectObjects',
    cursor: null,
    apply: false,
    owned: [],
  });
  assert.ok(first.readBytes <= 1024 * 1024, `read ${first.readBytes}`);
  assert.ok(first.scanned < 256 && first.cursor !== null);
});

test('F6 review 77acbe23: run catches a pointer written behind its cursor mid-scan without a replay', async () => {
  const s = seed(600);
  let inserted = false;
  const ctx = runner(s, (args, result) => {
    if (inserted || args.table !== 'projectObjects' || result.cursor === null) return;
    inserted = true;
    s.tables.projectObjects.set(
      'late',
      object('late', 10_000, { storageId: 'storage-zzzzz', ...r2('e'.repeat(64)) }),
    );
  });
  const result = await run._handler(ctx, { apply: true });
  assert.ok(inserted);
  assert.equal(
    s.tables.projectObjects.get('late').storageId,
    undefined,
    'the late pointer is cleared in the same run',
  );
  assert.ok(
    result.passes.at(-1).every(pass => pass.cleared === 0),
    'the run ends with a rescan that clears nothing',
  );
});

test('F6 review 77acbe23: an object a saved source continuation names stays blocked', async () => {
  const s = state();
  s.tables.projectObjects.set(
    'owned',
    object('owned', 1, { storageId: 'storage-owned', ...r2('a'.repeat(64)) }),
  );
  s.tables.projectObjects.set(
    'free',
    object('free', 2, { storageId: 'storage-free', ...r2('b'.repeat(64)) }),
  );
  s.tables.projectSourceSteps = new Map([
    [
      'step',
      {
        _id: 'step',
        _creationTime: 1,
        cursor: JSON.stringify({ phase: 'objects', parts: [JSON.stringify({ ref: 'storage-owned' })] }),
      },
    ],
  ]);
  const result = await run._handler(runner(s), { apply: true });
  assert.equal(result.continuationRefs, 1);
  assert.equal(
    s.tables.projectObjects.get('owned').storageId,
    'storage-owned',
    'its ownership proof survives',
  );
  assert.equal(s.tables.projectObjects.get('free').storageId, undefined);
  assert.equal(result.passes[0][0].blocked, 1);
});

test('F6 d5850d3d: a backup and its archive receipt with a committed R2 copy lose their old id; a native-only one is blocked', async () => {
  const s = state();
  s.tables.projectBackups.set(
    'backup',
    backupRow({ _id: 'backup', storageId: 'storage-backup', ...r2('c'.repeat(64)) }),
  );
  s.tables.projectBackups.set(
    'archived',
    backupRow({
      _id: 'archived',
      _creationTime: 2,
      archiveReceipt: {
        digest: 'd'.repeat(64),
        size: 1,
        storageId: 'storage-archive',
        ...r2('d'.repeat(64)),
        operationId: 'op',
        at: 0,
      },
    }),
  );
  s.tables.projectBackups.set(
    'native',
    backupRow({ _id: 'native', _creationTime: 3, storageId: 'storage-native' }),
  );
  s.tables.projectBackups.set(
    'native-archive',
    backupRow({
      _id: 'native-archive',
      _creationTime: 4,
      archiveReceipt: {
        digest: 'e'.repeat(64),
        size: 1,
        storageId: 'storage-native-2',
        operationId: 'op',
        at: 0,
      },
    }),
  );
  const dry = await run._handler(runner(s), { apply: false });
  assert.deepEqual(
    dry.passes[0].map(pass => [pass.table, pass.scanned, pass.cleared, pass.blocked]),
    [
      ['projectObjects', 0, 0, 0],
      ['projectBackups', 2, 1, 1],
      ['projectBackupArchives', 2, 1, 1],
    ],
  );
  assert.equal(s.tables.projectBackups.get('backup').storageId, 'storage-backup', 'a dry run writes nothing');
  const result = await run._handler(runner(s), { apply: true });
  assert.equal(s.tables.projectBackups.get('backup').storageId, undefined);
  assert.equal(s.tables.projectBackups.get('archived').archiveReceipt.storageId, undefined);
  assert.equal(
    s.tables.projectBackups.get('archived').archiveReceipt.r2Key,
    `v1/p/project/o/${'d'.repeat(64)}`,
  );
  assert.equal(s.tables.projectBackups.get('native').storageId, 'storage-native');
  assert.equal(s.tables.projectBackups.get('native-archive').archiveReceipt.storageId, 'storage-native-2');
  const replay = await run._handler(runner(s), { apply: true });
  assert.deepEqual(
    replay.passes.at(-1).map(pass => pass.cleared),
    [0, 0, 0],
    'a replay clears nothing',
  );
  assert.equal(
    result.passes.at(-1).every(pass => pass.cleared === 0),
    true,
  );
});

test('F6 review 77acbe23: the byte proof refuses a missing or repeated row instead of returning less', async () => {
  const s = seed(3);
  await assert.rejects(
    proofRows._handler(s.ctx, { objects: ['object-0', 'object-gone'], backups: [] }),
    error => (error.code ?? error.data?.code) === 'BAD_ARGUMENT',
  );
  await assert.rejects(
    proofRows._handler(s.ctx, { objects: ['object-0', 'object-0'], backups: [] }),
    error => (error.code ?? error.data?.code) === 'BAD_ARGUMENT',
  );
  const found = await proofRows._handler(s.ctx, { objects: ['object-0', 'object-1'], backups: [] });
  assert.deepEqual(
    found.objects.map(row => row._id),
    ['object-0', 'object-1'],
  );
});
