// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { immutableDirectory, immutableDirectorySync } from './immutable-directory.mjs';
import { hostedSnapshot, restoreHosted } from './hosted-snapshot.mjs';
import { fixture } from '../project-exchange-fixture.mjs';
import { getFunctionName, makeFunctionReference } from 'convex/server';

for (const factory of [immutableDirectory, immutableDirectorySync]) {
  let builds = 0;
  const copy = factory('forge-private-seed-', root => {
    builds++;
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'source'), 'seed');
    chmodSync(join(root, 'nested', 'source'), 0o700);
    symlinkSync('source', join(root, 'nested', 'link'));
    return { nested: { count: 1 }, bytes: Buffer.from('seed') };
  });
  test(`${factory.name} keeps filesystem and returned metadata private`, async t => {
    const a = await copy(),
      b = await copy();
    t.after(() => {
      rmSync(a.root, { recursive: true, force: true });
      rmSync(b.root, { recursive: true, force: true });
    });
    assert.equal(builds, 1);
    assert.equal(readlinkSync(join(b.root, 'nested', 'link')), 'source');
    assert.notEqual(
      statSync(join(a.root, 'nested', 'source')).ino,
      statSync(join(b.root, 'nested', 'source')).ino,
    );
    assert.equal(statSync(join(b.root, 'nested', 'source')).mode & 0o777, 0o700);
    writeFileSync(join(a.root, 'nested', 'source'), 'changed');
    a.value.nested.count++;
    a.value.bytes[0] = 0;
    assert.ok(Buffer.isBuffer(b.value.bytes));
    assert.equal(b.value.bytes.toString(), 'seed');
    assert.equal(readFileSync(join(b.root, 'nested', 'source'), 'utf8'), 'seed');
    assert.equal(b.value.nested.count, 1);
    const c = await copy();
    t.after(() => rmSync(c.root, { recursive: true, force: true }));
    assert.equal(readFileSync(join(c.root, 'nested', 'source'), 'utf8'), 'seed');
    assert.equal(c.value.nested.count, 1);
  });
}

test('hosted snapshots isolate rows and storage metadata and retain allocator uniqueness', async () => {
  const seed = fixture();
  const id = await seed.ctx.db.insert('projectObjects', { value: { count: 1 } });
  const fileId = await seed.ctx.storage.store(new Blob(['seed']));
  await seed.ctx.scheduler.runAfter(0, makeFunctionReference('synthetic:task'), { count: 1 });
  const deletedId = await seed.ctx.db.insert('projectObjects', {});
  await seed.ctx.db.delete(deletedId);
  const snapshot = await hostedSnapshot(seed);
  const a = await restoreHosted(fixture(), snapshot),
    b = await restoreHosted(fixture(), snapshot);
  a.tables.projectObjects.get(id).value.count++;
  a.files.get(fileId).metadata.sha256 = 'changed';
  a.scheduled[0].args.count++;
  assert.equal(getFunctionName(b.scheduled[0].fn), 'synthetic:task');
  assert.equal(b.scheduled[0].args.count, 1);
  assert.equal(b.tables.projectObjects.get(id).value.count, 1);
  assert.equal(seed.tables.projectObjects.get(id).value.count, 1);
  assert.notEqual(b.files.get(fileId).metadata.sha256, 'changed');
  assert.equal(await b.files.get(fileId).blob.text(), 'seed');
  const nextId = await b.ctx.db.insert('projectObjects', { value: { count: 7 } });
  const nextFile = await b.ctx.storage.store(new Blob(['next']));
  assert.notEqual(nextId, id);
  assert.notEqual(nextId, deletedId);
  assert.notEqual(nextFile, fileId);
  assert.equal(b.tables.projectObjects.get(id).value.count, 1);
  assert.equal(await b.files.get(fileId).blob.text(), 'seed');
});

test('durable state waits observe changes and retain their failure deadline', async t => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { waitForState } = await import('./wait-for-state.mjs');
  const root = mkdtempSync(join(tmpdir(), 'forge-state-wait-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'work.json');
  writeFileSync(file, 'before');
  const pending = waitForState({ directory: root }, () => readFileSync(file, 'utf8') === 'after', 2000);
  writeFileSync(file, 'after');
  assert.equal(await pending, true);
  await assert.rejects(
    waitForState({ directory: root }, () => false, 20),
    { code: 'TEST_STATE_TIMEOUT' },
  );
  const controller = new AbortController();
  const aborted = waitForState({ directory: root }, () => false, 2000, controller.signal);
  controller.abort(new Error('observation cancelled'));
  await assert.rejects(aborted, /observation cancelled/);
});
