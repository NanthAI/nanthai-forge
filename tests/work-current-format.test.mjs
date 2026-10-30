// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { emptyHostedProject } from '../dist/hosted-bootstrap.js';
import { githubHostedProject } from '../dist/hosted-github-bootstrap.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createWork } from '../dist/work-create.js';
import { assertCurrentWorkFormat, latestWorkFormat } from '../dist/work-format.js';
import { WorkStore } from '../dist/work-store.js';
import { initNative } from '../dist/native-work.js';
import { exportNativeWork, exportNativeSource, restoreNativeWork } from '../dist/native-backup.js';
import { restoreWorkFormat } from '../dist/work-restore-format.js';
import { convertHostedIntents } from '../dist/work-hosted-intents.js';
import { workSchema } from '../dist/work-types.js';
import { digest } from '../dist/hash.js';
import { fixture } from './helpers.mjs';

function native(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-current-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'source.txt'), 'retained source\n');
  initNative(root);
  return new WorkStore(root);
}

test('new native and Git stores use current unified Work without invented migration facts', t => {
  for (const store of [native(t), new WorkStore(fixture(t))]) {
    const data = store.load();
    assert.equal(data.schema, latestWorkFormat);
    assert.deepEqual(data.initiatives, []);
    assert.deepEqual(data.intentAliases, []);
    assert.equal(data.legacyIntentMerge, undefined);
    assert.equal(data.intentMergeReceipt, undefined);
    assert.equal(data.autonomyPolicy.preset, 'supervised');
    store.save(data);
    assert.deepEqual(store.load(), data);
  }
});

test('source-only exports preserve unspecified policy defaults without inheriting private Work', async t => {
  const store = native(t),
    original = store.load();
  const backup = (await exportNativeSource(store, store.revision(), original.nativeHead)).result;
  const exported = JSON.parse(readFileSync(join(backup.path, 'work.json')));
  assert.equal(exported.schema, latestWorkFormat);
  assert.equal(exported.autonomyPolicy, undefined);
  assert.equal(exported.intentMergeReceipt, undefined);
  assert.equal(exported.legacyIntentMerge, undefined);
  assert.deepEqual(exported.intents, []);
  assert.deepEqual(exported.runs, []);
  const target = join(store.root, 'source-only-restored');
  await restoreNativeWork(backup.archive.path, target);
  const restored = new WorkStore(target).load();
  assert.equal(restored.autonomyPolicy, undefined);
  assert.equal(restored.nativeHead, original.nativeHead);
  assert.equal(store.load().autonomyPolicy.preset, 'supervised');
});

test('old portable and indexed owners fail before collection reads or writes and retain their bytes', t => {
  const store = native(t),
    path = join(store.directory, 'work.json');
  const pointer = JSON.parse(readFileSync(path));
  rmSync(join(store.directory, 'records'), { recursive: true, force: true });
  for (const schema of [1, 21, 22, 23, 25]) {
    for (const value of [
      { ...createWork(), schema },
      { ...pointer, fields: { ...pointer.fields, schema } },
    ]) {
      const bytes = JSON.stringify(value);
      writeFileSync(path, bytes);
      for (const read of [
        () => store.load(),
        () => store.revision(),
        () => store.readRecords(),
        () => store.records(),
        () => store.page('intents'),
      ])
        assert.throws(read, { code: 'WORK_UPGRADE_REQUIRED' });
      assert.throws(() => store.save(createWork()), { code: 'WORK_UPGRADE_REQUIRED' });
      assert.throws(() => store.pinnedBytes(Buffer.from(bytes)), { code: 'WORK_UPGRADE_REQUIRED' });
      assert.equal(existsSync(join(store.directory, 'records')), false);
      assert.equal(readFileSync(path, 'utf8'), bytes);
    }
    assert.throws(() => store.save({ ...createWork(), schema }), { code: 'WORK_UPGRADE_REQUIRED' });
  }
});

test('restore-native converts an old verified backup and preserves its original archive', async t => {
  const store = native(t);
  const backup = (await exportNativeWork(store, store.revision(), false)).result;
  const workPath = join(backup.path, 'work.json'),
    manifestPath = join(backup.path, 'manifest.json');
  const old = JSON.parse(readFileSync(workPath));
  old.schema = 1;
  delete old.autonomyPolicy;
  const bytes = Buffer.from(JSON.stringify(old));
  writeFileSync(workPath, bytes);
  const manifest = JSON.parse(readFileSync(manifestPath));
  Object.assign(
    manifest.files.find(file => file.path === 'work.json'),
    { sha256: digest(bytes), size: bytes.length },
  );
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const target = join(store.root, 'restored');
  await restoreNativeWork(backup.path, target);
  const recovered = new WorkStore(target).load();
  assert.equal(recovered.schema, latestWorkFormat);
  assert.equal(recovered.nativeHead, old.nativeHead);
  assert.equal(recovered.revision, old.revision);
  assert.equal(recovered.autonomyPolicy, undefined, 'old custom defaults are preserved');
  assert.ok(recovered.intentMergeReceipt);
  assert.deepEqual(readFileSync(workPath), bytes);
  assert.equal(readFileSync(join(target, 'source.txt'), 'utf8'), 'retained source\n');
});

test('recovery relabels unified Work without rewriting legacy facts, receipt, aliases or journal bytes', () => {
  const legacy = workSchema.parse({ schema: 21, revision: 12, intents: [], lanes: [], views: [] });
  const before = convertHostedIntents(legacy);
  before.intentMergeReceipt.futureReceiptFact = { retained: true };
  before.legacyIntentMerge.futureLegacyFact = { retained: true };
  const bytes = JSON.stringify(before);
  const after = restoreWorkFormat(before);
  assert.equal(after.schema, latestWorkFormat);
  for (const key of ['legacyIntentMerge', 'intentMergeReceipt', 'intentAliases', 'hostedEvents'])
    assert.deepEqual(after[key], before[key]);
  assert.equal(JSON.stringify(before), bytes);
  assert.deepEqual(restoreWorkFormat(after), after);
});

test('dogfood-size pointer format reads hydrate zero records and make zero network calls', t => {
  const store = native(t),
    path = join(store.directory, 'work.json');
  const pointer = JSON.parse(readFileSync(path));
  const counts = { intents: 600, lanes: 560, views: 2200, runs: 1500, channelMoves: 575 };
  for (const [collection, count] of Object.entries(counts)) {
    // Deliberately absent pages make any accidental collection hydration fail.
    pointer.collections[collection] = { count, pages: Array(Math.ceil(count / 128)).fill('f'.repeat(64)) };
  }
  writeFileSync(path, JSON.stringify(pointer));
  rmSync(join(store.directory, 'records'), { recursive: true, force: true });
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network call');
  });
  const start = performance.now(),
    before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100; i++) assert.equal(store.revision(), pointer.fields.revision);
  const heapDelta = Math.max(0, process.memoryUsage().heapUsed - before);
  assert.equal(fetch.mock.callCount(), 0);
  assert.ok(heapDelta < 16 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      operations: 100,
      pointerBytes: Buffer.byteLength(JSON.stringify(pointer)),
      networkCalls: 0,
      hydratedRecords: 0,
      heapDelta,
      wallMs: performance.now() - start,
    }),
  );
});

test('empty hosted and GitHub-imported projects also start directly at the current format', () => {
  const at = '2026-01-01T00:00:00Z';
  for (const value of [
    emptyHostedProject(randomUUID(), at),
    githubHostedProject(randomUUID(), at, 'a'.repeat(40), []),
  ]) {
    const work = JSON.parse(value.objects[1].text);
    assert.equal(work.schema, latestWorkFormat);
    assert.deepEqual(work.initiatives, []);
    assert.deepEqual(work.intentAliases, []);
    assert.equal(work.intentMergeReceipt, undefined);
    assert.equal(work.legacyIntentMerge, undefined);
    assert.equal(work.channelMoves[0].head, value.head);
  }
});

test('malformed format metadata fails structurally without reflecting untrusted values', () => {
  for (const schema of ['untrusted-format-value', {}, { toString: 'must-not-coerce' }, null]) {
    assert.throws(
      () => assertCurrentWorkFormat({ schema }),
      error => {
        assert.equal(error.code, 'INVALID_WORK_STORE');
        assert.equal(error.message.includes('untrusted-format-value'), false);
        return true;
      },
    );
  }
});
