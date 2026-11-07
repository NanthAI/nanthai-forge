// SPDX-License-Identifier: Apache-2.0
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
  const retained = await blockedWith(applyHostedSync(s.root, request, s.transport));
  assert(retained.superseded, 'the sync names the moved Lane');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await recoverLocalApply(s.root, request.operationId, s.transport);
    assert.equal(result.status, 'superseded');
    assert.deepEqual(result.next, { action: 'open', laneId: request.lane.laneId });
    assert.deepEqual(snapshot(s.root), before, 'every byte, marker included, stays in place');
    assert.equal(result.preservedAt, null, 'nothing was kept because nothing moved');
    assert.deepEqual(listKeptApply(s.root).entries, []);
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
  return { root, cacheRoot, previous, files: baseline, markerName: 'hosted-lane.json' };
}

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
      fs.writeFileSync(join(input.previous, 'a'), 'WRITTEN AFTER THE CHECK\n');
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
