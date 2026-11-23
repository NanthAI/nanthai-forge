// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// e0ae9db0 (F1-F5): recover-apply and old-checkout disposal move or remove only what they must.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { recoverLocalApply } from '../dist/hosted-apply-recovery.js';
import { disposePriorCheckout } from '../dist/hosted-checkout-dispose.js';
import { listKeptApply, keptApplyRoot } from '../dist/hosted-apply-kept.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { digest } from '../dist/hash.js';

/** Every path under `root` (the marker included) with its exact bytes. */
function snapshot(root, at = '', out = {}) {
  for (const name of fs.readdirSync(join(root, at)).sort()) {
    const path = at ? `${at}/${name}` : name,
      stat = fs.lstatSync(join(root, path));
    if (stat.isDirectory()) snapshot(root, path, out);
    else out[path] = fs.readFileSync(join(root, path)).toString('base64');
  }
  return out;
}
const files = directory => (fs.existsSync(directory) ? Object.keys(snapshot(directory)) : []);
const blockedWith = async (promise, check) => {
  let recovery;
  await assert.rejects(promise, error => {
    recovery = error.recovery;
    check?.(error);
    return recovery?.next?.action === 'recover-apply';
  });
  return recovery;
};

test('F1: recover-apply moves only the unsaved change that clashes with the incoming change', async t => {
  const s = await fixture(t, undefined, [
    { path: 'y', content: 'y baseline\n' },
    { path: 'dir/z', content: 'z baseline\n' },
  ]);
  const request = s.command();
  fs.writeFileSync(join(s.root, 'a'), 'local edit of a file main changed\n');
  fs.writeFileSync(join(s.root, 'y'), 'local y\n');
  fs.writeFileSync(join(s.root, 'dir', 'z'), 'local z\n');
  fs.writeFileSync(join(s.root, 'new.txt'), 'a brand new local file\n');
  await blockedWith(applyHostedSync(s.root, request, s.transport), error =>
    assert.equal(error.code, 'WORK_CONFLICT'),
  );
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(recovered.status, 'applied');
  assert.equal(fs.readFileSync(join(s.root, 'a'), 'utf8'), 'after\n', 'the incoming change is installed');
  assert.deepEqual(files(recovered.preservedAt), ['a'], 'only the clashing edit moved');
  assert.equal(
    fs.readFileSync(join(recovered.preservedAt, 'a'), 'utf8'),
    'local edit of a file main changed\n',
  );
  assert.equal(fs.readFileSync(join(s.root, 'y'), 'utf8'), 'local y\n', 'other edits stay in place');
  assert.equal(fs.readFileSync(join(s.root, 'dir', 'z'), 'utf8'), 'local z\n');
  assert.equal(fs.readFileSync(join(s.root, 'new.txt'), 'utf8'), 'a brand new local file\n');
  assert.deepEqual(recovered.kept.paths, { edited: ['a'], extra: [], deleted: [] });
});

test('F2: recover-apply on a Lane that moved on before the first apply receipt leaves every byte in place', async t => {
  const s = await fixture(t);
  const request = s.command();
  // The Lane moves on (another save) while the sync result waits to be applied.
  s.setFiles([{ ...s.files[0], blob: s.put('newer\n') }, ...s.files.slice(1)]);
  fs.writeFileSync(join(s.root, 'a'), 'local a\n');
  fs.writeFileSync(join(s.root, 'unaffected'), 'local unaffected\n');
  fs.writeFileSync(join(s.root, 'new.txt'), 'new local file\n');
  const before = snapshot(s.root);
  const cache = clientCacheRoot(s.root),
    baseline = join(cache, `apply-baseline-${request.operationId}.json`),
    blocked = join(cache, `apply-blocked-${request.operationId}.json`);
  fs.copyFileSync(join(s.root, '.forge', 'hosted-lane.json'), baseline);
  const retained = await blockedWith(applyHostedSync(s.root, request, s.transport));
  assert(retained.superseded, 'the sync names the moved Lane');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await recoverLocalApply(s.root, request.operationId, s.transport);
    assert.equal(result.status, 'superseded');
    assert.deepEqual(result.next, { action: 'open', laneId: request.lane.laneId });
    assert.deepEqual(snapshot(s.root), before, 'every byte, marker included, stays in place');
    assert.equal(result.preservedAt, null, 'nothing was kept because nothing moved');
    assert.deepEqual(listKeptApply(s.root).entries, []);
    for (const path of [blocked, baseline]) assert(!fs.existsSync(path), path);
  }
});

test('F3: sync timeout, then open, then finish never rolls the checkout back', async t => {
  const s = await resolutionFixture(t, { overlap: false }),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  f.moveMain({ overlap: false });
  s.eagerSource(false);
  const controller = new AbortController();
  controller.abort();
  const pending = await s.transport().dispatch('sync', { laneId: f.lane.laneId }, controller.signal);
  assert.equal(pending.result.status, 'submitted');
  s.eagerSource(true);
  await s.exchange.client.mutation(makeFunctionReference('projectHostedSyncJobs:submit'), {
    projectId: f.projectId,
    operationId: pending.operationId,
  });
  // `open` while the handoff waits installs the synced head.
  await s.transport().dispatch('open', { laneId: f.lane.laneId, operationId: randomUUID() });
  const opened = readHostedLaneCheckout(s.root).selection;
  assert.equal(opened.head, (await f.readLane(f.lane.laneId)).head);
  assert.equal(fs.readFileSync(join(s.root, 'accepted.txt'), 'utf8'), 'already accepted\n');
  fs.writeFileSync(join(s.root, 'after-open.txt'), 'edited after open\n');
  try {
    await s.transport().dispatch('finish', { laneId: f.lane.laneId });
  } catch (error) {
    // Any advertised recovery must leave the newer checkout and its edits where they are.
    const next = error.recovery?.next;
    assert(next, `finish failed without a recovery: ${error.message}`);
    const { action, ...command } = next;
    await s
      .transport()
      .dispatch(action, command)
      .catch(() => {});
  }
  const now = readHostedLaneCheckout(s.root).selection;
  assert(now.version >= opened.version, 'the checkout is not rolled back to the pre-sync pins');
  assert.equal(fs.readFileSync(join(s.root, 'accepted.txt'), 'utf8'), 'already accepted\n');
  assert.equal(fs.readFileSync(join(s.root, 'after-open.txt'), 'utf8'), 'edited after open\n');
  assert.deepEqual(listKeptApply(s.root).entries, [], 'nothing was moved out of the tree');
});

/** A prior checkout as a whole-checkout publication leaves it: baseline files plus its marker. */
function priorCheckout(t, entries) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'forge-dispose-')));
  t.after(() => {
    for (const path of [dir, keptApplyRoot(join(dir, 'client'))])
      if (fs.existsSync(path)) {
        fs.chmodSync(path, 0o700);
        for (const name of fs.readdirSync(path, { recursive: true }))
          try {
            const at = join(path, name);
            if (fs.lstatSync(at).isDirectory()) fs.chmodSync(at, 0o700);
          } catch {}
        fs.rmSync(path, { recursive: true, force: true });
      }
  });
  const root = join(dir, 'client'),
    cacheRoot = clientCacheRoot(root),
    previous = join(cacheRoot, 'previous');
  fs.mkdirSync(join(previous, '.forge'), { recursive: true });
  fs.mkdirSync(root);
  const baseline = [];
  for (const [path, content] of entries) {
    fs.mkdirSync(join(previous, path, '..'), { recursive: true });
    fs.writeFileSync(join(previous, path), content);
    baseline.push({ path, blob: digest(Buffer.from(content)), mode: 'file' });
  }
  fs.writeFileSync(join(previous, '.forge', 'hosted-lane.json'), '{}');
  return {
    root,
    cacheRoot,
    previous,
    operationId: randomUUID(),
    files: () => baseline,
    markerName: 'hosted-lane.json',
  };
}

test('F9: a crash after the held receipt but before moving previous never advertises a missing backup', t => {
  const input = priorCheckout(t, []);
  fs.writeFileSync(join(input.previous, 'draft'), 'only copy');
  const rename = fs.renameSync;
  let pending;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === input.previous) {
      pending = to;
      assert(fs.existsSync(join(to, '..', 'receipt.json')));
      assert.deepEqual(listKeptApply(input.root), { entries: [], more: 0 });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(disposePriorCheckout(input), pending);
  } finally {
    fs.renameSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(listKeptApply(input.root).entries.length, 1);
  assert.equal(fs.readFileSync(join(pending, 'draft'), 'utf8'), 'only copy');
});

test('F9: held receipts awaiting a move cannot crowd out a real kept checkout in status', t => {
  const input = priorCheckout(t, []);
  fs.writeFileSync(join(input.previous, 'draft'), 'real backup');
  const held = disposePriorCheckout(input);
  const cache = keptApplyRoot(input.root);
  for (let index = 0; index < 25; index++) {
    const id = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      directory = join(cache, id);
    fs.writeFileSync(join(cache, `awaiting-previous-${id}`), '');
    fs.mkdirSync(directory);
    fs.writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ held: true }));
  }
  const { entries, more } = listKeptApply(input.root);
  assert.equal(more, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].directory, join(held, '..'));
});

for (const failing of ['receipt', 'index'])
  test(`F9: disk-full ${failing} writes leave previous intact and no files per retry`, t => {
    const input = priorCheckout(t, []);
    fs.writeFileSync(join(input.previous, 'draft'), 'only copy');
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      const body = String(args[0]);
      if (
        failing === 'receipt'
          ? body.includes('"held":true')
          : body.startsWith('["') && body.includes('prior-checkout')
      ) {
        write(file, body.slice(0, 8));
        throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' });
      }
      return write(file, ...args);
    });
    syncBuiltinESMExports();
    try {
      for (let retry = 0; retry < 3; retry++) {
        assert.throws(() => disposePriorCheckout(input), { code: 'WORK_CONFLICT' });
        assert.deepEqual(fs.readdirSync(keptApplyRoot(input.root)), []);
        assert.deepEqual(fs.readdirSync(input.cacheRoot).sort(), ['kept-apply', 'previous']);
        assert.equal(fs.readFileSync(join(input.previous, 'draft'), 'utf8'), 'only copy');
      }
    } finally {
      fs.writeFileSync.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(fs.readFileSync(join(disposePriorCheckout(input), 'draft'), 'utf8'), 'only copy');
  });

test('F9: a symlink swapped in while claiming previous is held without visiting its target', t => {
  const input = priorCheckout(t, []);
  fs.writeFileSync(join(input.root, 'draft'), 'do not visit');
  const rename = fs.renameSync;
  let held;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === input.previous) {
      rename(from, join(input.cacheRoot, 'displaced'));
      fs.symlinkSync(input.root, from, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    held = disposePriorCheckout({
      ...input,
      files: () => assert.fail('a replacement symlink cannot supply a baseline'),
    });
  } finally {
    fs.renameSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert(fs.lstatSync(held).isSymbolicLink());
  assert.equal(fs.realpathSync(held), fs.realpathSync(input.root));
  assert.equal(fs.readFileSync(join(input.root, 'draft'), 'utf8'), 'do not visit');
});

test('F4: a read-only tracked folder in the old checkout is held with the rest, not a permanent refusal', async t => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const input = priorCheckout(t, [
    ['a', 'a\n'],
    ['locked/inner', 'inner\n'],
  ]);
  fs.chmodSync(join(input.previous, 'locked'), 0o555);
  const held = disposePriorCheckout(input);
  assert(held, 'the remainder is held and reported');
  assert(!fs.existsSync(input.previous), 'no prior checkout is left to refuse later checkouts');
  assert.equal(fs.readFileSync(join(held, 'locked', 'inner'), 'utf8'), 'inner\n', 'bytes are kept');
  const listing = listKeptApply(input.root).entries.find(entry => held.startsWith(entry.directory + '/'));
  assert(listing, 'status lists the held folder');
  assert.equal(listing.expiresAt, undefined, 'held bytes never expire');
});

test('F5: a write through the old path between the byte check and the delete is kept', async t => {
  const input = priorCheckout(t, [
    ['a', 'a\n'],
    ['b', 'b\n'],
  ]);
  const original = fs.unlinkSync;
  let fired = false;
  t.mock.method(fs, 'unlinkSync', path => {
    // The first removal of a checked baseline file: a writer whose cwd is the old root saves `a`.
    if (!fired && !String(path).endsWith('.json')) {
      fired = true;
      fs.writeFileSync(join(path, '..', '..', 'a'), 'WRITTEN AFTER THE CHECK\n');
    }
    return original(path);
  });
  syncBuiltinESMExports();
  let held;
  try {
    held = disposePriorCheckout(input);
  } finally {
    fs.unlinkSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert(fired, 'the write happened between the check and the delete');
  assert(held, 'the late write is held');
  assert.equal(fs.readFileSync(join(held, 'a'), 'utf8'), 'WRITTEN AFTER THE CHECK\n');
  assert(!fs.existsSync(join(held, 'b')), 'exact baseline bytes are still removed');
});
