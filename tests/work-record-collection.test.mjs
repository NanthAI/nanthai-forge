// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { recordIO, recordObject, readRecords, stageRecords } from '../dist/work-records.js';
import { collectRecords } from '../dist/work-record-collection.js';
import { exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';
import { digest } from '../dist/hash.js';
import { packRecord, unpackRecord } from '../dist/work-record-codec.js';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'forge-record-gc-')),
    root = join(parent, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'source\n');
  initNative(root);
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const work = new WorkService(root),
    store = work.store;
  const orphan = recordIO(store.directory).put({ old: 'superseded '.repeat(300) });
  return { parent, root, store, work, orphan };
}
const command = { action: 'collect-records' };
const pagePath = (store, id) => join(store.directory, 'records', id);
const pointer = store => readFileSync(join(store.directory, 'work.json'));
function fingerprint(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(entry.parentPath, entry.name),
        info = statSync(path);
      return [path, info.mtimeMs, info.size, digest(readFileSync(path))];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

test('dry run reports pages, byte totals and reasons without writing or taking a lock', async t => {
  const { store, work, orphan } = fixture(t),
    before = fingerprint(store.directory);
  store.locked = () => {
    throw Error('A dry run must not lock');
  };
  const { result } = await work.dispatch(command);
  assert.equal(result.dryRun, true);
  assert.ok(result.candidates.some(page => page.id === orphan));
  assert.ok(result.kept.every(page => page.reasons.includes('current Work pointer/revision')));
  assert.equal(result.before.bytes - result.reclaimable.bytes, result.afterBytes);
  assert.deepEqual(fingerprint(store.directory), before);
});

test('apply requires a verified current-revision full-directory backup', t => {
  const { store, orphan } = fixture(t),
    before = pointer(store);
  assert.throws(() => collectRecords(store, { ...command, apply: true }), { code: 'RECORD_BACKUP_REQUIRED' });
  assert.deepEqual(pointer(store), before);
  assert.ok(readFileSync(pagePath(store, orphan)).length);
});

test('apply backs up every page and source file before removal; retry is idempotent', t => {
  const { store, root, orphan } = fixture(t),
    source = fingerprint(join(store.directory, 'objects'));
  writeFileSync(join(root, 'unsaved.txt'), 'not checkpointed');
  const { result } = collectRecords(store, { ...command, apply: true, backup: true });
  assert.ok(result.removed.some(page => page.id === orphan));
  assert.ok(readFileSync(join(result.backup.path, '.forge/work/records', orphan)).length);
  assert.equal(readFileSync(join(result.backup.path, 'unsaved.txt'), 'utf8'), 'not checkpointed');
  assert.deepEqual(fingerprint(join(store.directory, 'objects')), source);
  assert.equal(collectRecords(store, { ...command, apply: true }).result.removed.length, 0);
  assert.doesNotThrow(() => store.load());
});

test('backup protects historical Work page closure and a newer revision invalidates apply guard', t => {
  const { store } = fixture(t);
  collectRecords(store, { ...command, apply: true, backup: true });
  const old = JSON.parse(pointer(store)),
    oldPages = Object.values(old.collections).flatMap(index => index.pages);
  const data = store.load();
  data.revision++;
  data.extension = 'new revision';
  store.save(data);
  const plan = collectRecords(store, command).result;
  for (const id of oldPages)
    assert.ok(
      plan.kept.find(page => page.id === id)?.reasons.some(reason => reason.startsWith('kept backup:')),
    );
  assert.throws(() => collectRecords(store, { ...command, apply: true }), { code: 'RECORD_BACKUP_REQUIRED' });
  const registry = JSON.parse(readFileSync(join(store.directory, 'record-collection-backups.json')));
  writeFileSync(join(registry[0].path, 'a.txt'), 'damaged backup');
  // A fresh backup still permits collection without relying on the damaged copy.
  assert.doesNotThrow(() => collectRecords(store, { ...command, apply: true, backup: true }));
});

test('damaged current backup cannot authorize deletion', t => {
  const { store, root } = fixture(t);
  const backup = collectRecords(store, { ...command, apply: true, backup: true }).result.backup;
  writeFileSync(join(backup.path, 'a.txt'), 'changed');
  assert.throws(() => collectRecords(store, { ...command, apply: true }), { code: 'RECORD_BACKUP_REQUIRED' });
  assert.ok(new WorkStore(root).load());
});

test('pending operation pins close over their nested record pages and lookup indexes', t => {
  const { store } = fixture(t),
    data = store.load();
  data.revision++;
  data.extensionList = [{ id: randomUUID(), names: ['one', 'two'] }];
  const staged = stageRecords(store.directory, data);
  mkdirSync(join(store.directory, 'agent-finish'));
  writeFileSync(
    join(store.directory, 'agent-finish', 'pending.json'),
    JSON.stringify({ pending: true, pointer: staged }),
  );
  const root = staged.collections.extensionList.pages[0],
    plan = collectRecords(store, command).result;
  assert.ok(
    plan.kept
      .find(page => page.id === root)
      ?.reasons.some(reason => reason.includes('pending journal/operation')),
  );
  collectRecords(store, { ...command, apply: true, backup: true });
  assert.deepEqual(readRecords(store.directory, staged).extensionList, data.extensionList);
});

test('recent closed snapshots and the latest open snapshot retain Work pins; expired closed snapshots do not', async t => {
  const { store, root } = fixture(t),
    agent = new AgentWorkflow(root),
    started = await agent.dispatch({ action: 'start', outcome: 'snapshot retention' }),
    lane = store.select('lanes', started.result.laneId),
    data = store.load(),
    now = Date.now();
  const closed = { ...structuredClone(lane), id: randomUUID(), state: 'completed' };
  data.lanes.push(closed);
  data.revision++;
  store.save(data);
  const dir = join(store.directory, 'auto-snapshots');
  mkdirSync(dir, { recursive: true });
  const io = recordIO(store.directory),
    openPin = io.put({ open: 'old snapshot' }),
    recentPin = io.put({ recent: 'closed snapshot' }),
    expiredPin = io.put({ expired: 'closed snapshot' });
  const snapshot = (laneId, age, pin, name = laneId) =>
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({ laneId, at: new Date(now - age * 86400000).toISOString(), workPage: pin }),
    );
  snapshot(lane.id, 30, openPin);
  snapshot(closed.id, 6, recentPin);
  snapshot(closed.id, 8, expiredPin, randomUUID());
  const plan = collectRecords(store, command).result;
  assert.ok(plan.kept.find(page => page.id === openPin)?.reasons.includes('open Lane latest snapshot'));
  assert.ok(
    plan.kept
      .find(page => page.id === recentPin)
      ?.reasons.includes('Lane snapshot within seven-day retention'),
  );
  assert.ok(plan.candidates.some(page => page.id === expiredPin));
});

test('SIGKILL after the first unlink leaves current store readable; rerun completes', t => {
  const { store, root } = fixture(t);
  recordIO(store.directory).put({ another: 'obsolete' });
  const before = store.load();
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { WorkStore } from './dist/work-store.js';
    import { collectRecords } from './dist/work-record-collection.js';
    collectRecords(new WorkStore(process.argv[1]), {action:'collect-records',apply:true,backup:true},
      {removed(){process.kill(process.pid,'SIGKILL')}});
  `,
      root,
    ],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.deepEqual(new WorkStore(root).load(), before);
  const result = collectRecords(store, { ...command, apply: true }).result;
  assert.ok(result.removed.length > 0);
  assert.deepEqual(store.load(), before);
});

test('a pending staged writer retains its unpublished pages until publication', t => {
  const { store } = fixture(t),
    tx = store.readRecords();
  // Transaction append creates unpublished page/fragment/index nodes.
  tx.append('frictionEvents', {
    id: randomUUID(),
    kind: 'capture',
    operationId: randomUUID(),
    request: 'synthetic',
    title: 'staged',
    detail: 'staged evidence',
    area: 'workflow',
    count: 1,
    at: new Date().toISOString(),
  });
  const result = collectRecords(store, { ...command, apply: true, backup: true }).result;
  assert.equal(result.removed.length, 0);
  assert.ok(
    result.kept.some(page => page.reasons.some(reason => reason.startsWith('pending record writer:'))),
  );
  store.locked(() => tx.commit());
  assert.equal(store.load().frictionEvents.length, 1);
});

test('old JSON pages and compressed pages have the same logical identity; corrupt compressed bytes are rejected', t => {
  const { store } = fixture(t),
    value = { testNames: Array(400).fill('one descriptive test name') },
    bytes = Buffer.from(JSON.stringify(value)),
    id = digest(bytes);
  writeFileSync(pagePath(store, id), bytes);
  assert.deepEqual(recordObject(store.directory, id), value);
  const packed = packRecord(bytes);
  assert.ok(packed.length < bytes.length / 4);
  writeFileSync(pagePath(store, id), packed);
  assert.deepEqual(recordObject(store.directory, id), value);
  writeFileSync(pagePath(store, id), packed.subarray(0, 22));
  assert.throws(() => recordObject(store.directory, id), { code: 'INVALID_WORK_STORE' });
});

test('old v1/v2 pointers remain readable and the next save advertises physical v3', t => {
  const { store } = fixture(t),
    data = store.load(),
    staged = stageRecords(store.directory, data);
  // v2 uses exactly the same fragmented logical links, even when pages are mixed.
  for (const id of readdirSync(join(store.directory, 'records'))) {
    const path = pagePath(store, id);
    writeFileSync(path, unpackRecord(readFileSync(path)));
  }
  staged.schema = 'forge-work-records-v2';
  writeFileSync(join(store.directory, 'work.json'), JSON.stringify(staged));
  assert.deepEqual(store.load(), data);
  assert.deepEqual(store.load(), data);
  // Empty default collections have the same v1 (unfragmented) representation.
  staged.schema = 'forge-work-records-v1';
  writeFileSync(join(store.directory, 'work.json'), JSON.stringify(staged));
  assert.deepEqual(store.load(), data);
  store.save(data);
  assert.equal(JSON.parse(pointer(store)).schema, 'forge-work-records-v3');
});

test('backup/export after collection restores and preserves Work/source', async t => {
  const { store, parent } = fixture(t);
  const before = store.load();
  collectRecords(store, { ...command, apply: true, backup: true });
  const exported = (await exportNativeWork(store, store.revision(), true)).result;
  const target = join(parent, 'restored');
  await restoreNativeWork(exported.archive.path, target);
  assert.deepEqual(new WorkStore(target).load(), before);
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'source\n');
});

test('unverifiable roots stop apply before any deletion; malformed or linked orphan entries are preserved', t => {
  const { store, orphan } = fixture(t),
    data = JSON.parse(pointer(store)),
    page = data.collections.intents.lookup;
  writeFileSync(pagePath(store, 'b'.repeat(64)), 'not JSON');
  assert.ok(collectRecords(store, command).result.preserved.some(item => item.name === 'b'.repeat(64)));
  rmSync(pagePath(store, page));
  assert.throws(() => collectRecords(store, { ...command, apply: true, backup: true }));
  assert.ok(readFileSync(pagePath(store, orphan)));
});

test('CLI exposes the same read-only default and explicit backup/apply behavior', t => {
  const { root, store, orphan } = fixture(t);
  const invoke = input => {
    const result = spawnSync(process.execPath, ['dist/cli.js', 'work', root, JSON.stringify(input), '0'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).result;
  };
  assert.equal(invoke({ ...command, backup: true }).dryRun, true);
  assert.ok(readFileSync(pagePath(store, orphan)));
  assert.ok(invoke({ ...command, apply: true, backup: true }).removed.some(page => page.id === orphan));
});

test('kept full backups retain pending-operation roots after the live journal is removed', t => {
  const { store, orphan } = fixture(t),
    directory = join(store.directory, 'agent-finish');
  mkdirSync(directory);
  const path = join(directory, 'pending.json');
  writeFileSync(path, JSON.stringify({ recordPage: orphan }));
  collectRecords(store, { ...command, apply: true, backup: true });
  rmSync(path);
  const plan = collectRecords(store, command).result;
  assert.ok(
    plan.kept
      .find(page => page.id === orphan)
      ?.reasons.some(
        reason => reason.startsWith('kept backup:') && reason.endsWith('agent-finish/pending.json'),
      ),
  );
  assert.ok(
    !collectRecords(store, { ...command, apply: true }).result.removed.some(page => page.id === orphan),
  );
});
