// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoverOwner, reconnectOwner } from '../dist/recovery-owner.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
import { recoveryFixture } from './recovery-fixture.mjs';

for (const archive of [false, true])
  test(`${archive ? 'archive' : 'hosted'} recovery restores accepted main, saved Lanes, later journal, evidence and explicit owner role`, async t => {
    const f = await recoveryFixture(t, archive);
    const result = await recoverOwner(f.target, f.request, f.transport),
      data = f.store().load();
    assert.equal(result.connection.binding.operationId, f.selection.ownerId);
    assert.equal(result.coverage.main.head, f.main.head);
    assert.equal(data.lanes.find(l => l.id === f.lane.id).head, f.saved.head);
    assert.equal(
      readFileSync(join(f.store().path(f.lane.id), 'source.ts'), 'utf8'),
      'export const value = 2;\n',
    );
    assert.equal(data.intents.find(i => i.id === f.secondIntent.id).notes.at(-1).text, 'Later hosted note');
    assert.equal(data.runs.find(r => r.id === f.runIds[1]).status, 'interrupted');
    assert(result.coverage.evidence.unavailable.some(path => path.endsWith('stderr.log')));
    assert(result.coverage.evidence.included.some(file => file.path.endsWith('artifacts/artifact-0.bin')));
    assert.equal(readHostState(f.store()).binding.acceptanceOwner, true);
    assert.equal(f.receipts.size, 1);
    assert.equal(result.coverage.completeHistory, 'complete');
    assert(!existsSync(join(f.target, 'must-never-run')));
  });

test('lost reconnect reply reconciles original receipt even after hosted pins advance', async t => {
  const f = await recoveryFixture(t);
  f.loseReply();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'HOSTED_ACTION_FAILED' });
  assert(!existsSync(f.target));
  assert.equal(f.receipts.size, 1);
  const before = f.counters();
  f.selection.revision++;
  const result = await recoverOwner(f.target, f.request, f.transport);
  assert.equal(f.counters().downloads, before.downloads);
  assert.equal(f.counters().reconnects, before.reconnects);
  assert.equal(result.coverage.journalRevision, f.selection.revision - 1);
  writeFileSync(join(f.target, 'local-edit.txt'), 'preserve after completed retry');
  await recoverOwner(f.target, f.request, f.transport);
  assert.equal(readFileSync(join(f.target, 'local-edit.txt'), 'utf8'), 'preserve after completed retry');
});

test('revoked authority is checked before fresh, staged and completed cached recovery', async t => {
  const f = await recoveryFixture(t);
  f.revoke();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'AUTH_REVOKED' });
  assert.equal(f.counters().downloads, 0);
  f.allow();
  f.loseReply();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'HOSTED_ACTION_FAILED' });
  const before = f.counters();
  f.revoke();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'AUTH_REVOKED' });
  assert.deepEqual(f.counters(), before);
  assert(!existsSync(f.target));
  f.allow();
  await recoverOwner(f.target, f.request, f.transport);
  f.revoke();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'AUTH_REVOKED' });
});

test('changed hosted journal/source pins never silently substitute another checkpoint', async t => {
  const f = await recoveryFixture(t),
    prepare = f.transport.prepare;
  let calls = 0;
  f.transport.prepare = async () => {
    if (++calls === 2) f.selection.revision++;
    return prepare();
  };
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'WORK_STALE' });
  assert(!existsSync(f.target));
  assert.equal(f.receipts.size, 0);
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'WORK_STALE' });
});

test('corrupt/missing objects and interrupted downloads leave no published owner and can retry original pins', async t => {
  const f = await recoveryFixture(t);
  f.corrupt(true);
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'INVALID_WORK_BACKUP' });
  assert(!existsSync(f.target));
  f.corrupt(false);
  f.interrupt();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'EXCHANGE_REQUEST_FAILED' });
  assert(!existsSync(f.target));
  const download = f.transport.download;
  f.transport.download = async () => {
    throw Object.assign(new Error('Synthetic missing object'), { code: 'SOURCE_UNAVAILABLE' });
  };
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'SOURCE_UNAVAILABLE' });
  f.transport.download = download;
  assert.equal((await recoverOwner(f.target, f.request, f.transport)).restored, true);
});

test('existing destination and changed request are preserved without remote mutations', async t => {
  const f = await recoveryFixture(t);
  mkdirSync(f.target);
  writeFileSync(join(f.target, 'keep'), 'existing');
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'RESTORE_TARGET_EXISTS' });
  assert.equal(f.counters().prepares, 0);
  assert.equal(readFileSync(join(f.target, 'keep'), 'utf8'), 'existing');
  rmSync(f.target, { recursive: true });
  f.interrupt();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'EXCHANGE_REQUEST_FAILED' });
  await assert.rejects(recoverOwner(f.target, { ...f.request, projectId: 'other-project' }, f.transport), {
    code: 'WORK_OPERATION_CHANGED',
  });
});

test('restore resumes its marked stage after losing the local coverage write', async t => {
  const f = await recoveryFixture(t);
  f.loseReply();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'HOSTED_ACTION_FAILED' });
  // Simulate interruption after atomic stage publication but before recording coverage.
  const { readdirSync } = await import('node:fs');
  const staging = join(
    f.directory,
    readdirSync(f.directory).find(name => name.startsWith('.forge-recovery-')),
  );
  const path = join(staging, 'state.json'),
    state = JSON.parse(readFileSync(path, 'utf8'));
  delete state.coverage;
  delete state.workSha256;
  writeFileSync(path, JSON.stringify(state));
  f.receipts.clear();
  const before = f.counters().downloads;
  const result = await recoverOwner(f.target, f.request, f.transport);
  assert.equal(f.counters().downloads, before);
  assert.equal(result.coverage.elapsedMs, null);
});

test('the old machine rejoins as a client without changing local source or canonical project identity', async t => {
  const f = await recoveryFixture(t);
  await recoverOwner(f.target, f.request, f.transport);
  const before = f.work.store.snapshotBytes();
  updateHostState(f.work.store, state => {
    state.binding = readHostState(f.store()).binding;
  });
  f.request.operationId = randomUUID();
  const client = await reconnectOwner(f.root, f.request, 'client', f.transport);
  assert.equal(client.connection.binding.operationId, f.selection.ownerId);
  assert.equal(readHostState(f.work.store).binding.acceptanceOwner, false);
  assert(f.work.store.snapshotBytes().equals(before));
  assert.match(client.message, /exchange ROOT pull --target/);
  assert.equal(readHostState(f.store()).binding.acceptanceOwner, true);
});

test('a local native archive can reconnect explicitly; mismatched archive bytes fail before reconnect', async t => {
  const f = await recoveryFixture(t, true);
  await assert.rejects(
    recoverOwner(f.target, { ...f.request, archivePath: join(f.directory, 'missing.tar.gz') }, f.transport),
  );
  // A changed archive selection uses an explicit new operation.
  f.request.operationId = randomUUID();
  f.request.archivePath = f.exported.archive.path;
  const restored = await recoverOwner(f.target, f.request, f.transport);
  assert.equal(restored.reconnected, true);
  f.request.operationId = randomUUID();
  const result = await reconnectOwner(f.target, f.request, 'owner', f.transport);
  assert.equal(result.connection.role, 'owner');
});

test('a cached reconnect receipt never bypasses staged evidence validation', async t => {
  const f = await recoveryFixture(t);
  f.loseReply();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'HOSTED_ACTION_FAILED' });
  const { readdirSync } = await import('node:fs');
  const staging = join(
    f.directory,
    readdirSync(f.directory).find(name => name.startsWith('.forge-recovery-')),
  );
  writeFileSync(
    join(staging, 'owner/.forge/work', `check-${f.runIds[0]}/artifacts/artifact-0.bin`),
    'damaged',
  );
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'INVALID_WORK_BACKUP' });
  assert(!existsSync(f.target));
});

test('a preexisting staging journal symlink never overwrites source on retry', async t => {
  const f = await recoveryFixture(t);
  f.revoke();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'AUTH_REVOKED' });
  const { readdirSync, symlinkSync, lstatSync } = await import('node:fs');
  const staging = join(
    f.directory,
    readdirSync(f.directory).find(name => name.startsWith('.forge-recovery-')),
  );
  const source = join(f.root, 'source.ts'),
    before = readFileSync(source);
  symlinkSync(source, join(staging, 'journal.json'));
  f.allow();
  await recoverOwner(f.target, f.request, f.transport);
  assert(readFileSync(source).equals(before));
  assert.equal(lstatSync(join(staging, 'journal.json')).isSymbolicLink(), false);
});
