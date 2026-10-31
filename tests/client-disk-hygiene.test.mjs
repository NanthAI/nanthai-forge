// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { gcNestedLanes, gcNestedLanesHourly, touchNestedLane } from '../dist/client-cache-gc.js';
import { hostedLaneDirty } from '../dist/hosted-lane-dirty.js';
import { laneHousekeeping } from '../dist/lane-prune.js';
import { recordLane } from '../dist/lane-registry.js';
import { digest } from '../dist/hash.js';
import { createServer } from 'node:net';
import { openWorkerNotifications } from '../dist/local-worker-notifications.js';
import { PeersCache } from '../dist/agent-peers-cache.js';

const hour = 3_600_000;
const address = { url: 'https://fixture.invalid', projectId: 'project' };
function isolated(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-test-hygiene-'));
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory, 'state');
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
/** A real hosted Lane checkout (marker, baseline State and files) at ROOT. */
async function realCheckout(root, laneId = randomUUID()) {
  const objects = new Map();
  const put = value => {
    const bytes = Buffer.from(value),
      id = digest(bytes);
    objects.set(id, bytes);
    return id;
  };
  const files = [
    { path: 'src/a.txt', blob: put('first\n'), mode: 'file' },
    { path: 'bin/run', blob: put('#!/bin/sh\necho synthetic\n'), mode: 'executable' },
  ];
  const head = put(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: 'synthetic',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  const selection = {
    schema: 2,
    projectId: address.projectId,
    laneId,
    intentId: randomUUID(),
    head,
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    base: { head: 'a'.repeat(64), receiptId: 'base' },
    authority: { mode: 'server', epoch: 1 },
  };
  const transport = {
    select: async () => structuredClone(selection),
    objects: async ids => ids.map(sha256 => ({ sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) => writeFileSync(path, objects.get(pin.sha256), { mode: 0o600 }),
  };
  await checkoutHostedLane(root, { ...address, laneId, operationId: randomUUID() }, transport);
  return laneId;
}
const age = (path, hours) => {
  const when = new Date(Date.now() - hours * hour);
  utimesSync(path, when, when);
};
function ageTree(path, hours) {
  if (!existsSync(path)) return;
  for (const name of existsSync(path) && lstatSync(path).isDirectory() ? readdirSync(path) : [])
    ageTree(join(path, name), hours);
  age(path, hours);
}
/** A nested copy with a declared size, last used HOURS ago. */
function copy(root, bytes, hours) {
  const laneId = randomUUID(),
    path = join(`${root}.forge-client`, 'lanes', laneId);
  mkdirSync(join(path, '.forge'), { recursive: true });
  writeFileSync(join(path, '.forge', 'cache-use.json'), JSON.stringify({ bytes }));
  age(join(path, '.forge', 'cache-use.json'), hours);
  age(path, hours);
  return { laneId, path };
}
const settings = (gb, hours) => ({ clientCacheMaxGB: gb, clientCacheMaxAgeHours: hours });
const clean = () => false;

test('unsaved-edit check is read-only and sees edits, additions, deletions and mode changes', async t => {
  const directory = isolated(t),
    root = join(directory, 'lane');
  await realCheckout(root);
  assert.equal(hostedLaneDirty(root), false);
  touchNestedLane(root);
  writeFileSync(join(root, '.forge', 'cache-use.json'), '{}');
  assert.equal(hostedLaneDirty(root), false, 'Forge metadata is not source');
  writeFileSync(join(root, 'src', 'a.txt'), 'edited\n');
  assert.equal(hostedLaneDirty(root), true);
  writeFileSync(join(root, 'src', 'a.txt'), 'first\n');
  assert.equal(hostedLaneDirty(root), false);
  writeFileSync(join(root, 'new.txt'), 'x');
  assert.equal(hostedLaneDirty(root), true);
  rmSync(join(root, 'new.txt'));
  chmodSync(join(root, 'bin', 'run'), 0o644);
  assert.equal(hostedLaneDirty(root), true);
  chmodSync(join(root, 'bin', 'run'), 0o755);
  rmSync(join(root, 'src', 'a.txt'));
  assert.equal(hostedLaneDirty(root), true);
  assert.equal(hostedLaneDirty(join(directory, 'missing')), true, 'unknown state counts as unsaved');
});

test('cache GC evicts least recently used first until the size cap holds', t => {
  const directory = isolated(t),
    root = join(directory, 'main');
  const oldest = copy(root, 1e9, 30),
    middle = copy(root, 1e9, 20),
    newest = copy(root, 1e9, 10);
  const result = gcNestedLanes({ root, settings: settings(2, 0), isDirty: clean });
  assert.deepEqual(
    result.evicted.map(item => item.laneId),
    [oldest.laneId],
  );
  assert.equal(result.totalBytes, 2e9);
  assert(!existsSync(oldest.path));
  assert(existsSync(middle.path) && existsSync(newest.path));
  // Under the cap and young enough: nothing more is touched.
  assert.deepEqual(gcNestedLanes({ root, settings: settings(2, 0), isDirty: clean }).evicted, []);
});

test('cache GC evicts by age and a zero setting turns each limit off', t => {
  const directory = isolated(t),
    root = join(directory, 'main');
  const stale = copy(root, 10, 50),
    fresh = copy(root, 10, 1);
  assert.deepEqual(gcNestedLanes({ root, settings: settings(0, 0), isDirty: clean }).evicted, []);
  const result = gcNestedLanes({ root, settings: settings(0, 24), isDirty: clean });
  assert.deepEqual(
    result.evicted.map(item => item.laneId),
    [stale.laneId],
  );
  assert(existsSync(fresh.path));
});

test('cache GC never evicts the caller’s Lane, a locked or just-used copy, a linked copy or unsaved edits', t => {
  const directory = isolated(t),
    root = join(directory, 'main');
  const own = copy(root, 1e9, 40),
    locked = copy(root, 1e9, 41),
    justUsed = copy(root, 1e9, 42),
    linked = copy(root, 1e9, 43),
    edited = copy(root, 1e9, 44),
    free = copy(root, 1e9, 45);
  writeFileSync(`${locked.path}.forge-client`, 'x');
  rmSync(`${locked.path}.forge-client`);
  mkdirSync(`${locked.path}.forge-client`);
  writeFileSync(join(`${locked.path}.forge-client`, 'lock'), '{}');
  utimesSync(join(justUsed.path, '.forge', 'cache-use.json'), new Date(), new Date());
  symlinkSync(linked.path, join(directory, 'lane-link'));
  const result = gcNestedLanes({
    root,
    keepLaneIds: [own.laneId],
    settings: settings(0.5, 0),
    isDirty: path => path === edited.path,
  });
  const kept = Object.fromEntries(result.kept.map(item => [item.laneId, item.reason]));
  assert.equal(kept[own.laneId], 'the caller’s Lane');
  assert.equal(kept[locked.laneId], 'in use');
  assert.equal(kept[justUsed.laneId], 'in use');
  assert.equal(kept[linked.laneId], 'linked from a sibling directory');
  assert.equal(kept[edited.laneId], 'unsaved edits');
  assert.deepEqual(
    result.evicted.map(item => item.laneId),
    [free.laneId],
  );
  for (const item of [own, locked, justUsed, linked, edited]) assert(existsSync(item.path));
});

test('cache GC runs at most once an hour and only stamps a finished pass', t => {
  const directory = isolated(t),
    root = join(directory, 'main');
  assert.equal(
    gcNestedLanesHourly({ root, settings: settings(2, 24), isDirty: clean }),
    null,
    'no cache yet',
  );
  const stale = copy(root, 10, 50);
  const first = gcNestedLanesHourly({ root, settings: settings(2, 24), isDirty: clean });
  assert.deepEqual(
    first.evicted.map(item => item.laneId),
    [stale.laneId],
  );
  const other = copy(root, 10, 50);
  assert.equal(gcNestedLanesHourly({ root, settings: settings(2, 24), isDirty: clean }), null);
  assert(existsSync(other.path), 'the second call within the hour did nothing');
  age(`${root}.forge-client/gc-stamp`, 2);
  assert.equal(gcNestedLanesHourly({ root, settings: settings(2, 24), isDirty: clean }).evicted.length, 1);
  // An out-of-time pass leaves no stamp, so the next start continues.
  const late = copy(root, 10, 50);
  rmSync(`${root}.forge-client/gc-stamp`);
  const partial = gcNestedLanesHourly({ root, settings: settings(2, 24), isDirty: clean, budgetMs: -1 });
  assert.equal(partial.finished, false);
  assert(existsSync(late.path));
  assert(!existsSync(`${root}.forge-client/gc-stamp`));
});

test('prune removes a clean active Lane idle past the age, and keeps an edited one listed', async t => {
  const directory = isolated(t);
  const now = Date.now(),
    cleanRoot = join(directory, 'clean'),
    editedRoot = join(directory, 'edited'),
    doneRoot = join(directory, 'done');
  const ids = {};
  for (const [name, root] of [
    ['clean', cleanRoot],
    ['edited', editedRoot],
    ['done', doneRoot],
  ]) {
    ids[name] = await realCheckout(root);
    for (const path of [
      root,
      join(root, '.forge'),
      join(root, '.forge', 'hosted-lane.json'),
      join(root, 'src'),
      join(root, 'src', 'a.txt'),
      join(root, 'bin'),
      join(root, 'bin', 'run'),
    ])
      age(path, 10);
    ageTree(`${root}.forge-client`, 10);
    recordLane({ laneId: ids[name], root, ...address, outcome: name, lastActionAt: now - 10 * hour }, now);
  }
  writeFileSync(join(editedRoot, 'src', 'a.txt'), 'unsaved\n');
  age(join(editedRoot, 'src', 'a.txt'), 10);
  const states = { [ids.clean]: 'active', [ids.edited]: 'active', [ids.done]: 'completed' };
  const readStates = async (_address, laneIds) => new Map(laneIds.map(id => [id, states[id]]));
  const dry = await laneHousekeeping({ readStates, address, apply: false, now });
  assert.equal(dry.pruned.length, 2);
  assert(existsSync(cleanRoot), 'dry run removes nothing');
  const result = await laneHousekeeping({ readStates, address, apply: true, now });
  assert.deepEqual(new Set(result.pruned.map(item => item.laneId)), new Set([ids.clean, ids.done]));
  assert(!existsSync(cleanRoot) && !existsSync(doneRoot));
  assert(existsSync(join(editedRoot, 'src', 'a.txt')), 'a root with unsaved edits is never removed');
  assert.deepEqual(
    result.idle.map(item => item.laneId),
    [ids.edited],
  );
  assert.equal(result.kept.find(item => item.laneId === ids.edited).reason, 'unsaved edits');
  // A recent Lane is untouched, and the check is bounded per pass.
  const busy = [];
  for (let index = 0; index < 12; index++) {
    const laneId = randomUUID(),
      root = join(directory, `busy-${index}`);
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(
      join(root, '.forge', 'hosted-lane.json'),
      JSON.stringify({ url: address.url, selection: { laneId, projectId: address.projectId } }),
    );
    age(root, 10);
    age(join(root, '.forge'), 10);
    age(join(root, '.forge', 'hosted-lane.json'), 10);
    recordLane({ laneId, root, ...address, lastActionAt: now - 10 * hour }, now);
    busy.push(laneId);
  }
  let checks = 0;
  const bounded = await laneHousekeeping({
    readStates: async (_address, laneIds) => new Map(laneIds.map(id => [id, 'active'])),
    address,
    apply: true,
    now,
    isDirty: () => (checks++, false),
  });
  assert.equal(checks, 8);
  assert.equal(bounded.pruned.length, 8);
});

test('a killed driver’s wake directory is swept; live and young ones stay', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'forge-test-wake-')),
    saved = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(temp, { recursive: true, force: true });
  });
  const dead = join(temp, 'nforge-wake-dead'),
    young = join(temp, 'nforge-wake-young'),
    live = join(temp, 'nforge-wake-live');
  for (const path of [dead, young, live]) mkdirSync(path);
  writeFileSync(join(dead, 'wake'), '');
  writeFileSync(join(young, 'wake'), '');
  const server = createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(join(live, 'wake'), resolve));
  for (const path of [dead, live]) age(path, 5);
  const channel = await openWorkerNotifications();
  await channel.close();
  await new Promise(resolve => server.close(resolve));
  assert.deepEqual(readdirSync(temp).sort(), ['nforge-wake-live', 'nforge-wake-young']);
});

test('the peers cache drops entries not written for a day, at most once an hour', t => {
  const directory = isolated(t),
    cache = new PeersCache('root', join(directory, 'peers'));
  cache.write('first', { n: 1 });
  const entry = key => join(directory, 'peers', digest(key));
  assert(existsSync(entry('first')));
  age(entry('first'), 30);
  cache.write('second', { n: 2 });
  assert(existsSync(entry('first')), 'swept less than an hour ago: nothing is removed yet');
  age(join(directory, 'peers', '.swept'), 2);
  cache.write('third', { n: 3 });
  assert(!existsSync(entry('first')));
  assert.deepEqual(cache.read('second'), { n: 2 });
  assert.deepEqual(cache.read('third'), { n: 3 });
});
