// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { gcNestedLanes } from '../dist/client-cache-gc.js';
import { listKeptApply } from '../dist/hosted-apply-kept.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { digest } from '../dist/hash.js';

/** Run `during` exactly once, immediately before the whole-checkout rename of `root` lands. */
function beforeRename(t, from, during) {
  const rename = fs.renameSync;
  let fired = false;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (!fired && source === from && String(destination).endsWith('/previous')) {
      fired = true;
      during();
    }
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  return {
    restore: () => {
      fs.renameSync.mock.restore();
      syncBuiltinESMExports();
    },
    fired: () => fired,
  };
}

const userBytes = Buffer.from('UNRELATED USER BYTES WRITTEN AFTER THE CLEAN CHECK\n'),
  userId = digest(userBytes);

test('B1: a cache-shaped user directory recreated between the final clean check and the whole-checkout rename survives apply, replay and real nested GC', async t => {
  const s = await fixture(t);
  // A nested Lane copy, so real GC can evict its whole adjacent cache afterwards.
  const owner = s.root + '-owner',
    parentCache = clientCacheRoot(owner),
    root = join(parentCache, 'lanes', randomUUID());
  fs.mkdirSync(join(parentCache, 'lanes'), { recursive: true });
  fs.renameSync(s.root, root);
  fs.renameSync(clientCacheRoot(s.root), clientCacheRoot(root));
  // A valid legacy cache directory is verified and quarantined normally first.
  const candidate = join(root, '..forge-client'),
    cached = Buffer.from('verified cached bytes');
  fs.mkdirSync(join(candidate, 'objects'), { recursive: true });
  fs.writeFileSync(join(candidate, 'objects', digest(cached)), cached);
  // A file to directory flip forces the whole-checkout publication path.
  s.setFiles([
    { path: 'a', blob: s.put('after\n'), mode: 'file' },
    { path: 'unaffected/inner', blob: s.put('nested\n'), mode: 'file' },
  ]);
  const request = s.command();
  const hook = beforeRename(t, root, () => {
    // An independent writer recreates the exact cache layout with its own correctly named bytes.
    fs.mkdirSync(join(candidate, 'objects'), { recursive: true });
    fs.writeFileSync(join(candidate, 'objects', userId), userBytes);
  });
  let applied;
  try {
    applied = await applyHostedSync(root, request, s.transport);
  } finally {
    hook.restore();
  }
  assert(hook.fired(), 'the race was replayed at the publication boundary');
  assert.equal(fs.readFileSync(join(root, 'unaffected', 'inner'), 'utf8'), 'nested\n');
  assert.equal(applied.displacedRecovery?.length, 1, 'the held prior checkout is reported');
  const held = applied.displacedRecovery[0];
  const survivor = join(held, '..forge-client', 'objects', userId);
  assert.deepEqual(fs.readFileSync(survivor), userBytes, 'user bytes survive publication');
  assert.match(applied.warning, /kept at/);
  // Baseline bytes were removed; only the unexpected content was held.
  assert(!fs.existsSync(join(held, 'a')), 'baseline files are not kept');
  assert(!fs.existsSync(join(held, 'unaffected')), 'baseline files are not kept');
  const listing = listKeptApply(root).entries.find(entry => held.startsWith(entry.directory + '/'));
  assert(listing, 'status lists the held folder');
  assert.equal(listing.expiresAt, undefined, 'held bytes are never swept by expiry');
  assert.deepEqual(listing.paths.extra, [`..forge-client/objects/${userId}`]);
  // Replay of the original operation reports the same reconcilable location.
  const replayed = await applyHostedSync(root, request, s.transport);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.displacedRecovery, [held]);
  const gc = gcNestedLanes({
    root: owner,
    settings: { clientCacheMaxGB: 1, clientCacheMaxAgeHours: 1 },
    now: Date.now() + 48 * 3600000,
  });
  assert.equal(gc.evicted.length, 1, 'the nested checkout and its adjacent cache are evicted');
  assert.deepEqual(fs.readFileSync(survivor), userBytes, 'held bytes outlive nested cache eviction');
});

test('B1: a clean whole-checkout publication keeps nothing and leaves no prior checkout', async t => {
  const s = await fixture(t);
  s.setFiles([
    { path: 'a', blob: s.put('after\n'), mode: 'file' },
    { path: 'unaffected/inner', blob: s.put('nested\n'), mode: 'file' },
  ]);
  const applied = await applyHostedSync(s.root, s.command(), s.transport);
  assert.equal(applied.displacedRecovery, undefined);
  assert(!fs.existsSync(join(clientCacheRoot(s.root), 'previous')));
  assert.deepEqual(listKeptApply(s.root).entries, []);
});

test('B1: an edit landing in a baseline file after the clean check is held, not deleted', async t => {
  const s = await fixture(t);
  s.setFiles([
    { path: 'a', blob: s.put('after\n'), mode: 'file' },
    { path: 'unaffected/inner', blob: s.put('nested\n'), mode: 'file' },
  ]);
  const hook = beforeRename(t, s.root, () => fs.writeFileSync(join(s.root, 'a'), 'LATE USER EDIT\n'));
  let applied;
  try {
    applied = await applyHostedSync(s.root, s.command(), s.transport);
  } finally {
    hook.restore();
  }
  assert(hook.fired());
  const held = applied.displacedRecovery[0];
  assert.equal(fs.readFileSync(join(held, 'a'), 'utf8'), 'LATE USER EDIT\n');
  assert(!fs.existsSync(join(held, 'unaffected')), 'unchanged baseline files are removed');
});

test('B1 main: an edit landing in the clone after the clean check and before the whole-checkout rename is held and reported', async t => {
  const { checkoutHostedMain } = await import('../dist/hosted-main-checkout.js');
  const dir = fs.mkdtempSync(join(fs.realpathSync(os.tmpdir()), 'hosted-main-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'client'),
    objects = new Map();
  const blob = text => {
    const bytes = Buffer.from(text);
    objects.set(digest(bytes), bytes);
    return digest(bytes);
  };
  const state = files =>
    blob(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: 'synthetic',
        at: '2026-01-01T00:00:00Z',
      }),
    );
  let head = state([
    { path: 'a', blob: blob('before\n'), mode: 'file' },
    { path: 'kept.txt', blob: blob('kept\n'), mode: 'file' },
  ]);
  const transport = {
    current: async () => ({
      schema: 1,
      projectId: 'project',
      generationId: 'generation',
      backupId: 'backup',
      channel: 'main',
      head,
      receipt: { id: `receipt-${head}`, kind: 'hosted', previousHead: null, previousReceiptId: null },
    }),
    objects: async ids => ids.map(sha256 => ({ sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) => fs.writeFileSync(path, objects.get(pin.sha256), { mode: 0o600 }),
  };
  const request = () => ({ url: 'https://fixture.invalid', projectId: 'project', operationId: randomUUID() });
  await checkoutHostedMain(root, request(), transport);
  // A file to directory flip forces the whole-checkout publication path.
  head = state([
    { path: 'a/inner', blob: blob('after\n'), mode: 'file' },
    { path: 'kept.txt', blob: blob('kept\n'), mode: 'file' },
  ]);
  const hook = beforeRename(t, root, () => fs.writeFileSync(join(root, 'kept.txt'), 'LATE USER EDIT\n'));
  let pulled;
  try {
    pulled = await checkoutHostedMain(root, request(), transport);
  } finally {
    hook.restore();
  }
  assert(hook.fired(), 'the race was replayed at the publication boundary');
  assert.equal(fs.readFileSync(join(root, 'a', 'inner'), 'utf8'), 'after\n');
  assert.equal(pulled.displacedRecovery?.length, 1, 'the held prior clone is reported');
  const held = pulled.displacedRecovery[0];
  assert.equal(fs.readFileSync(join(held, 'kept.txt'), 'utf8'), 'LATE USER EDIT\n');
  assert(!fs.existsSync(join(held, 'a')), 'baseline bytes are not kept');
});
