// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  symlinkSync,
  mkdirSync,
  readdirSync,
  linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { digest } from '../dist/hash.js';
import { ForgeError } from '../dist/errors.js';
import { fixture } from './hosted-sync-client-fixture.mjs';
test('explicit sync apply fetches only affected materialized objects and preserves sparse scope', async t => {
  const s = await fixture(t, ['a']),
    command = s.command();
  const result = await applyHostedSync(s.root, command, s.transport);
  assert.equal(result.head, command.lane.head);
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  assert.equal(result.downloadedObjects, 2);
  assert(!s.reads.includes(s.files[1].blob));
  assert(!existsSync(join(s.root, 'unaffected')));
  assert.deepEqual(readHostedLaneCheckout(s.root).scope, ['a']);
  assert.equal(readHostedLaneCheckout(s.root).state.files.length, 2);
  writeFileSync(join(s.root, 'a'), 'new local edit');
  const replay = await applyHostedSync(s.root, command, s.transport);
  assert.equal(replay.replayed, true);
  assert.equal(replay.downloadedObjects, 0);
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'new local edit');
  s.revoke();
  await assert.rejects(applyHostedSync(s.root, command, s.transport), /access revoked/);
});
test('changed-on-disk during transfer is preserved with the old marker; retry resumes cached source', async t => {
  const s = await fixture(t),
    command = s.command();
  const before = readHostedLaneCheckout(s.root);
  s.onDownload(() => writeFileSync(join(s.root, 'a'), 'newer on disk'));
  await assert.rejects(applyHostedSync(s.root, command, s.transport), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'newer on disk');
  assert.deepEqual(readHostedLaneCheckout(s.root), before);
  s.onDownload(undefined);
  writeFileSync(join(s.root, 'a'), 'before\n');
  const result = await applyHostedSync(s.root, command, s.transport);
  assert.equal(result.downloadedObjects, 0);
  assert.equal(result.head, command.lane.head);
});
test('older interrupted apply cannot overwrite a newer checkout or newer server selection', async t => {
  const s = await fixture(t),
    old = s.command();
  let failed = false;
  s.onDownload(() => {
    if (!failed) {
      failed = true;
      throw new Error('interrupted transfer');
    }
  });
  await assert.rejects(applyHostedSync(s.root, old, s.transport), /interrupted/);
  s.onDownload(undefined);
  s.change();
  const current = s.selection();
  await checkoutHostedLane(
    s.root,
    { operationId: randomUUID(), url: old.url, projectId: current.projectId, laneId: current.laneId },
    s.transport,
  );
  const marker = readHostedLaneCheckout(s.root);
  await assert.rejects(applyHostedSync(s.root, old, s.transport), { code: 'WORK_STALE' });
  assert.deepEqual(readHostedLaneCheckout(s.root), marker);
  const fresh = {
    ...s.command(),
    from: {
      ...old.from,
      head: old.lane.head,
      version: old.lane.version,
      sourceVersion: old.lane.sourceVersion,
    },
  };
  await assert.rejects(applyHostedSync(s.root, fresh, s.transport), { code: 'WORK_STALE' });
});
for (const kind of ['deletion', 'mode', 'symlink', 'untracked'])
  test(`sync apply preserves a local ${kind}`, async t => {
    const s = await fixture(t),
      command = s.command();
    if (kind === 'deletion') rmSync(join(s.root, 'a'));
    if (kind === 'mode') chmodSync(join(s.root, 'a'), 0o755);
    if (kind === 'symlink') {
      rmSync(join(s.root, 'a'));
      symlinkSync('../elsewhere', join(s.root, 'a'));
    }
    if (kind === 'untracked') writeFileSync(join(s.root, 'untracked'), 'retained');
    await assert.rejects(applyHostedSync(s.root, command, s.transport), { code: 'WORK_CONFLICT' });
    assert.equal(readHostedLaneCheckout(s.root).selection.head, s.from.head);
  });
test('fresh apply rejects a newer remote head and changed original command explicitly', async t => {
  const s = await fixture(t),
    old = s.command();
  s.change();
  await assert.rejects(applyHostedSync(s.root, old, s.transport), { code: 'WORK_STALE' });
  const current = s.command();
  await applyHostedSync(s.root, current, s.transport);
  await assert.rejects(
    applyHostedSync(s.root, { ...current, from: { ...current.from, version: 99 } }, s.transport),
    { code: 'WORK_OPERATION_CHANGED' },
  );
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
});

for (const name of ['..forge-client', '.forge-client'])
  test(`sync apply relocates a verified misplaced ${name} cache without losing bytes`, async t => {
    const s = await fixture(t);
    const bytes = Buffer.from('legacy cached bytes'),
      id = digest(bytes);
    const objects = join(s.root, name, 'objects');
    mkdirSync(objects, { recursive: true });
    writeFileSync(join(objects, id), bytes);
    const command = s.command();
    const result = await applyHostedSync(s.root, command, s.transport);
    assert.equal(result.head, s.selection().head);
    assert(!existsSync(join(s.root, name)));
    assert.equal(result.localRecovery.length, 1);
    const recovery = result.localRecovery[0];
    assert.deepEqual(readFileSync(join(recovery.preservedAt, 'objects', id)), bytes);
    assert(recovery.undo.includes(recovery.preservedAt));
    const replay = await applyHostedSync(s.root, command, s.transport);
    assert.deepEqual(replay.localRecovery, result.localRecovery);
    assert.equal(replay.replayed, true);
  });

for (const unknown of ['unknown file', 'wrong hash', 'symlink', 'hardlink'])
  test(`cache repair preserves ${unknown} as user content instead of discarding it`, async t => {
    const s = await fixture(t),
      directory = join(s.root, '..forge-client', 'objects');
    mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from('local bytes'),
      id = digest(bytes),
      path = join(directory, id);
    if (unknown === 'unknown file') writeFileSync(join(directory, 'notes.txt'), bytes);
    if (unknown === 'wrong hash') writeFileSync(path, 'not the named hash');
    if (unknown === 'symlink') symlinkSync('../elsewhere', path);
    if (unknown === 'hardlink') {
      writeFileSync(join(s.root, 'outside'), bytes);
      linkSync(join(s.root, 'outside'), path);
    }
    await assert.rejects(applyHostedSync(s.root, s.command(), s.transport), { code: 'WORK_CONFLICT' });
    assert(readdirSync(directory).length);
  });

for (const obstruction of ['edit', 'deletion', 'mode', 'symlink', 'extra', 'sparse mismatch'])
  test(`executable local recovery preserves a ${obstruction} and resumes the pinned apply`, async t => {
    const { recoverLocalApply } = await import('../dist/hosted-apply-recovery.js');
    const { assertAgentResponseShape } = await import('./agent-response-shape.mjs');
    const { describeFailure } = await import('../dist/system-errors.js');
    const s = await fixture(t, obstruction === 'sparse mismatch' ? ['a'] : undefined);
    if (obstruction === 'edit') writeFileSync(join(s.root, 'a'), 'local draft');
    if (obstruction === 'deletion') rmSync(join(s.root, 'a'));
    if (obstruction === 'mode') chmodSync(join(s.root, 'a'), 0o755);
    if (obstruction === 'symlink') {
      rmSync(join(s.root, 'a'));
      symlinkSync('local-target', join(s.root, 'a'));
    }
    if (obstruction === 'extra' || obstruction === 'sparse mismatch')
      writeFileSync(join(s.root, 'extra.txt'), 'local extra');
    const request = s.command();
    let blocked;
    try {
      await applyHostedSync(s.root, request, s.transport);
      assert.fail('expected local obstruction');
    } catch (error) {
      blocked = { error: describeFailure(error) };
    }
    const next = assertAgentResponseShape(blocked, s.root);
    const result = await recoverLocalApply(s.root, next.body.applyOperationId, s.transport);
    assert.equal(result.applied.head, request.lane.head);
    assert(existsSync(result.preservedAt));
    if (obstruction === 'edit')
      assert.equal(readFileSync(join(result.preservedAt, 'a'), 'utf8'), 'local draft');
    if (obstruction === 'deletion') assert(!existsSync(join(result.preservedAt, 'a')));
    assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
    const again = await recoverLocalApply(s.root, next.body.applyOperationId, s.transport);
    assert.equal(again.preservedAt, result.preservedAt);
    assert.equal(again.applied.replayed, true);
  });

for (const phase of ['after-preserve', 'after-baseline', 'after-receipt'])
  test(`local recovery reconciles an interruption ${phase} with the same apply id and preserved bytes`, async t => {
    const fs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const { recoverLocalApply } = await import('../dist/hosted-apply-recovery.js');
    const s = await fixture(t),
      request = s.command();
    writeFileSync(join(s.root, 'a'), 'local draft');
    await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
    const rename = fs.renameSync;
    let interrupted = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
      const result = rename(from, to);
      const match =
        phase === 'after-preserve'
          ? from === s.root && String(to).endsWith('/checkout')
          : phase === 'after-baseline'
            ? String(from).includes('/baseline-') && to === s.root
            : String(to).endsWith('/receipt.json') && JSON.parse(readFileSync(to)).restored;
      if (match && !interrupted) {
        interrupted = true;
        throw new ForgeError('LOCAL_APPLY_INTERRUPTED', 'Synthetic recovery interruption');
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        recoverLocalApply(s.root, request.operationId, s.transport),
        /Synthetic recovery interruption/,
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert(interrupted);
    const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
    assert.equal(recovered.applyOperationId, request.operationId);
    assert.equal(readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'local draft');
    assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
    assert.equal(
      (await recoverLocalApply(s.root, request.operationId, s.transport)).preservedAt,
      recovered.preservedAt,
    );
  });

test('legacy cache relocation interrupted after rename retains all bytes and same apply can resume', async t => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const s = await fixture(t),
    request = s.command(),
    directory = join(s.root, '..forge-client'),
    bytes = Buffer.from('cached legacy bytes'),
    id = digest(bytes);
  mkdirSync(join(directory, 'objects'), { recursive: true });
  writeFileSync(join(directory, 'objects', id), bytes);
  const rename = fs.renameSync;
  let preserved;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to);
    if (from === directory) {
      preserved = to;
      throw Error('Synthetic legacy relocation interruption');
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      applyHostedSync(s.root, request, s.transport),
      /Synthetic legacy relocation interruption/,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert(preserved);
  assert.deepEqual(readFileSync(join(preserved, 'objects', id)), bytes);
  const receipt = JSON.parse(readFileSync(preserved + '.json'));
  assert.equal(receipt.preservedAt, preserved);
  const result = await applyHostedSync(s.root, request, s.transport);
  assert.equal(result.head, request.lane.head);
  assert.equal(result.localRecovery[0].preservedAt, preserved);
  assert.deepEqual(readFileSync(join(preserved, 'objects', id)), bytes);
});

test('local preservation recovery rechecks authority before moving any local bytes', async t => {
  const { recoverLocalApply } = await import('../dist/hosted-apply-recovery.js');
  const s = await fixture(t),
    request = s.command();
  writeFileSync(join(s.root, 'a'), 'local draft');
  await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  s.revoke();
  await assert.rejects(recoverLocalApply(s.root, request.operationId, s.transport), /current access revoked/);
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'local draft');
  assert(!existsSync(s.root + '.kept-apply-' + request.operationId));
});

test('an edit during recovery gets another preservation round instead of a new retry dead end', async t => {
  const { recoverLocalApply } = await import('../dist/hosted-apply-recovery.js');
  const s = await fixture(t),
    request = s.command();
  writeFileSync(join(s.root, 'a'), 'first local draft');
  await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  let changed = false;
  s.onDownload(() => {
    if (!changed) {
      changed = true;
      writeFileSync(join(s.root, 'a'), 'second local draft');
    }
  });
  await assert.rejects(recoverLocalApply(s.root, request.operationId, s.transport), {
    code: 'WORK_CONFLICT',
  });
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'first local draft');
  assert.equal(recovered.additionalPreservedAt.length, 1);
  assert.equal(readFileSync(join(recovered.additionalPreservedAt[0], 'a'), 'utf8'), 'second local draft');
  assert.equal(recovered.applied.head, request.lane.head);
});

test('recovery reconciles source already installed before a lost local checkout receipt', async t => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { recoverLocalApply } = await import('../dist/hosted-apply-recovery.js');
  const s = await fixture(t),
    request = s.command(),
    rename = fs.renameSync;
  let interrupted = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to);
    if (!interrupted && String(from).includes('/checkout-') && to === s.root) {
      interrupted = true;
      throw Error('Synthetic apply publication interruption');
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      applyHostedSync(s.root, request, s.transport),
      /Synthetic apply publication interruption/,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert(interrupted);
  assert.equal(readHostedLaneCheckout(s.root).selection.head, request.lane.head);
  writeFileSync(join(s.root, 'a'), 'draft after interrupted publication');
  await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(recovered.applied.head, request.lane.head);
  assert.equal(readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'draft after interrupted publication');
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  assert(existsSync(recovered.priorPreservedAt), 'prior installer backup remains preserved too');
});
