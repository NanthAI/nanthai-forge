// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoverOwner } from '../dist/recovery-owner.js';
import { nativeOwner, NativeSource } from '../dist/native-source.js';
import { runnerRecoveryFixture } from './recovery-runner-fixture.mjs';
import { hostedRecoveryRows } from '../dist/recovery-hosted.js';
import { RECOVERY_HELP } from '../dist/recovery-cli.js';

// The former owner entry point now has exactly the runner/cache behavior.
test('clean Route B preserves hosted-only acceptance and exact queue receipts without an accepting owner', async t => {
  const f = await runnerRecoveryFixture(t),
    result = await recoverOwner(f.target, f.request, f.transport);
  assert.equal(result.role, 'runner-cache');
  assert.equal(result.coverage.main.head, f.head);
  assert.equal(readFileSync(join(f.target, 'source.ts'), 'utf8'), 'accepted only on hosted\n');
  assert.equal(nativeOwner(f.target), null);
  assert(!existsSync(join(f.target, '.forge/work/work.json')));
  assert(!existsSync(join(f.target, '.forge/work/host.json')));
  const source = new NativeSource(f.target),
    recovery = result.coverage.hosted;
  for (const table of [
    'projectHostedAcceptances',
    'projectHostedAcceptancePlans',
    'projectHostedLandingRequests',
    'projectReturnSupersessions',
  ])
    assert.deepEqual(
      [...hostedRecoveryRows(source, recovery, table)].sort((a, b) => a._id.localeCompare(b._id)),
      [...f.tables[table]].sort((a, b) => a._id.localeCompare(b._id)),
    );
  assert.equal(f.registrations.size, 1);
  assert.equal(f.counters().reconnects, 0);
});

test('interrupted page resumes its cursor and registration lost reply replays once', async t => {
  const f = await runnerRecoveryFixture(t, { accepted: 150 }),
    page = f.transport.hostedPage;
  let interrupted = false;
  f.transport.hostedPage = async (selection, table, cursor) => {
    if (!interrupted && table === 'projectHostedAcceptances' && cursor) {
      interrupted = true;
      throw Object.assign(new Error('Synthetic interruption'), { code: 'EXCHANGE_REQUEST_FAILED' });
    }
    return page(selection, table, cursor);
  };
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'EXCHANGE_REQUEST_FAILED' });
  assert(!existsSync(f.target));
  assert.equal(f.registrations.size, 0);
  f.calls.length = 0;
  f.loseRegistrationReply();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'HOSTED_ACTION_FAILED' });
  assert.equal(f.calls[0].table, 'projectHostedAcceptances');
  assert(f.calls[0].cursor);
  assert.equal(f.registrations.size, 1);
  const result = await recoverOwner(f.target, f.request, f.transport);
  assert.equal(f.registrations.size, 1);
  assert.equal(result.coverage.hosted.counts.projectHostedAcceptances, 150);
});

test('completed retry checks access and preserves local edits as hosted advances', async t => {
  const f = await runnerRecoveryFixture(t);
  await recoverOwner(f.target, f.request, f.transport);
  writeFileSync(join(f.target, 'source.ts'), 'local edits');
  f.selection.revision++;
  await recoverOwner(f.target, f.request, f.transport);
  assert.equal(readFileSync(join(f.target, 'source.ts'), 'utf8'), 'local edits');
  f.revoke();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'AUTH_REVOKED' });
  assert.equal(f.registrations.size, 1);
});

test('unrelated destination and changed operation input never cause hosted mutations', async t => {
  const f = await runnerRecoveryFixture(t);
  mkdirSync(f.target);
  writeFileSync(join(f.target, 'keep'), 'keep');
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'RESTORE_TARGET_EXISTS' });
  assert.equal(f.counters().prepares, 0);
  const target = join(f.directory, 'other');
  f.revoke();
  await assert.rejects(recoverOwner(target, f.request, f.transport), { code: 'AUTH_REVOKED' });
  f.allow();
  const page = f.transport.hostedPage;
  f.transport.hostedPage = async () => {
    throw new Error('interrupted');
  };
  await assert.rejects(recoverOwner(target, f.request, f.transport));
  f.transport.hostedPage = page;
  await assert.rejects(recoverOwner(target, { ...f.request, projectId: 'another' }, f.transport), {
    code: 'WORK_OPERATION_CHANGED',
  });
  assert.equal(f.registrations.size, 0);
  assert.equal(readFileSync(join(f.target, 'keep'), 'utf8'), 'keep');
});

for (const fault of ['revoked', 'corrupt', 'main-changed', 'unconfigured'])
  test(`Route B ${fault} leaves no published cache or registration`, async t => {
    const f = await runnerRecoveryFixture(t);
    if (fault === 'revoked') f.revoke();
    if (fault === 'corrupt') f.transport.download = async () => Buffer.from('corrupt');
    if (fault === 'main-changed')
      f.transport.current = async () => ({ ...f.selection.hostedMain, head: 'a'.repeat(64) });
    if (fault === 'unconfigured') f.transport.configuration = async () => null;
    await assert.rejects(recoverOwner(f.target, f.request, f.transport));
    assert(!existsSync(f.target));
    assert.equal(f.registrations.size, 0);
  });

test('recover help preserves native-owner recovery and scopes cache-only behavior to server authority', () => {
  assert.match(RECOVERY_HELP, /Native-owner and server-shadow projects retain full owner recovery/);
  assert.match(RECOVERY_HELP, /Server authority/);
  assert.match(RECOVERY_HELP, /reconnect\|client/);
});

test('lost registration reply reconciles the original snapshot after hosted advances', async t => {
  const f = await runnerRecoveryFixture(t);
  f.loseRegistrationReply();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'HOSTED_ACTION_FAILED' });
  f.selection.revision++;
  const result = await recoverOwner(f.target, f.request, f.transport);
  assert.equal(result.coverage.main.head, f.head);
  assert.equal(f.registrations.size, 1);
});

test('retry after final rename preserves new local edits and registration identity', async t => {
  const { recoveryRunnerTestHooks } = await import('../dist/recovery-runner.js');
  t.after(() => {
    delete recoveryRunnerTestHooks.afterPublish;
  });
  const f = await runnerRecoveryFixture(t);
  recoveryRunnerTestHooks.afterPublish = () => {
    throw new Error('Synthetic interruption after rename');
  };
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), /after rename/);
  delete recoveryRunnerTestHooks.afterPublish;
  writeFileSync(join(f.target, 'source.ts'), 'new local edit');
  f.selection.revision++;
  await recoverOwner(f.target, f.request, f.transport);
  assert.equal(readFileSync(join(f.target, 'source.ts'), 'utf8'), 'new local edit');
  assert.equal(f.registrations.size, 1);
});

test('staged source corruption cannot be published using a registration retry', async t => {
  const f = await runnerRecoveryFixture(t);
  f.loseRegistrationReply();
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'HOSTED_ACTION_FAILED' });
  const { readdirSync } = await import('node:fs');
  const staging = join(
    f.directory,
    readdirSync(f.directory).find(name => name.startsWith('.forge-recovery-')),
  );
  writeFileSync(join(staging, 'cache/.forge/work/objects', f.blob), 'corrupt cached blob');
  await assert.rejects(recoverOwner(f.target, f.request, f.transport), { code: 'INVALID_WORK_BACKUP' });
  assert(!existsSync(f.target));
});

test('the direct runner/cache entry point cannot replace native-owner recovery', async t => {
  const { recoverRunner } = await import('../dist/recovery-runner.js');
  const f = await runnerRecoveryFixture(t);
  f.selection.authority = { mode: 'native-owner', epoch: 2 };
  delete f.selection.hostedMain;
  await assert.rejects(recoverRunner(f.target, f.request, f.transport), { code: 'SOURCE_AUTHORITY_STALE' });
  assert(!existsSync(f.target));
  assert.equal(f.registrations.size, 0);
});

test('a completed runner recovery replays its original cache after rollback without becoming an owner', async t => {
  const f = await runnerRecoveryFixture(t);
  const before = await recoverOwner(f.target, f.request, f.transport);
  f.selection.authority = { mode: 'native-owner', epoch: 4 };
  delete f.selection.hostedMain;
  writeFileSync(join(f.target, 'source.ts'), 'preserve after rollback');
  const replay = await recoverOwner(f.target, f.request, f.transport);
  assert.equal(replay.role, 'runner-cache');
  assert.deepEqual(replay.coverage, before.coverage);
  assert.equal(nativeOwner(f.target), null);
  assert.equal(readFileSync(join(f.target, 'source.ts'), 'utf8'), 'preserve after rollback');
  assert.equal(f.registrations.size, 1);
});
