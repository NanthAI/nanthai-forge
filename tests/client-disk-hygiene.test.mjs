// SPDX-License-Identifier: Apache-2.0
import './automatic-cleanup.mjs';
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
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { gcNestedLanes, gcNestedLanesHourly, touchNestedLane } from '../dist/client-cache-gc.js';
import { hostedLaneDirty } from '../dist/hosted-lane-dirty.js';
import { laneHousekeeping } from '../dist/lane-prune.js';
import { lanePruneLogFile } from '../dist/lane-prune-log.js';
import { recordLane } from '../dist/lane-registry.js';
import { digest } from '../dist/hash.js';
import { createServer } from 'node:net';
import { openWorkerNotifications } from '../dist/local-worker-notifications.js';
import { socketDirectory } from '../dist/socket-directory.js';
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
  writeFileSync(join(edited.path, 'local-draft'), 'preserve this draft');
  age(edited.path, 44);
  const result = gcNestedLanes({
    root,
    keepLaneIds: [own.laneId],
    settings: settings(0.5, 0),
    isDirty: path => existsSync(join(path, 'local-draft')),
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

test('prune removes a clean active Lane idle past the active age, and keeps an edited one listed', async t => {
  const directory = isolated(t);
  const settings = { autoPruneHours: 3, idleLaneHours: 1, activeLanePruneHours: 3 };
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
    age(`${root}.forge-metrics.jsonl`, 10);
    recordLane({ laneId: ids[name], root, ...address, outcome: name, lastActionAt: now - 10 * hour }, now);
  }
  writeFileSync(join(editedRoot, 'src', 'a.txt'), 'unsaved\n');
  age(join(editedRoot, 'src', 'a.txt'), 10);
  const states = { [ids.clean]: 'active', [ids.edited]: 'active', [ids.done]: 'completed' };
  const readStates = async (_address, laneIds) => new Map(laneIds.map(id => [id, states[id]]));
  const dry = await laneHousekeeping({ readStates, address, apply: false, now, settings });
  assert.equal(dry.wouldPrune.length, 2);
  assert.equal(dry.pruned.length, 0, 'a dry run names nothing as pruned');
  assert(existsSync(cleanRoot), 'dry run removes nothing');
  const result = await laneHousekeeping({ readStates, address, apply: true, now, settings });
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
    settings,
    isDirty: () => (checks++, false),
  });
  assert.equal(checks, 8);
  assert.equal(bounded.pruned.length, 8);
});

test('an idle active Lane root survives housekeeping by default and a removal is logged', async t => {
  const directory = isolated(t);
  const now = Date.now();
  const old = {},
    waiting = {};
  const prepare = async (name, hours) => {
    const root = join(directory, name),
      laneId = await realCheckout(root);
    ageTree(root, hours);
    ageTree(`${root}.forge-client`, hours);
    if (existsSync(`${root}.forge-metrics.jsonl`)) age(`${root}.forge-metrics.jsonl`, hours);
    recordLane({ laneId, root, ...address, outcome: name, lastActionAt: now - hours * hour }, now);
    return { laneId, root };
  };
  Object.assign(waiting, await prepare('waiting', 24 * 3));
  Object.assign(old, await prepare('abandoned-long-ago', 24 * 9));
  const done = await prepare('done', 5);
  const states = { [waiting.laneId]: 'active', [old.laneId]: 'active', [done.laneId]: 'completed' };
  const readStates = async (_address, laneIds) => new Map(laneIds.map(id => [id, states[id]]));
  // Default settings: 3 h for finished Lanes, 7 days for an open one.
  const settings = { autoPruneHours: 3, idleLaneHours: 1 };
  const result = await laneHousekeeping({
    readStates,
    address,
    apply: true,
    now,
    settings,
    isDirty: () => false,
  });
  assert(
    existsSync(waiting.root),
    'an open Lane idle for 3 days (waiting on a landing or review) keeps its root',
  );
  assert.deepEqual(
    result.idle.map(item => item.laneId),
    [waiting.laneId],
    'it is still listed as idle',
  );
  assert(!existsSync(done.root) && !existsSync(old.root), 'finished and week-old unsaved-clean roots go');
  assert.deepEqual(new Set(result.pruned.map(item => item.laneId)), new Set([done.laneId, old.laneId]));
  const lines = readFileSync(lanePruneLogFile(), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(new Set(lines.map(line => line.laneId)), new Set([done.laneId, old.laneId]));
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), [
      'at',
      'bytes',
      'idleHours',
      'laneId',
      'reason',
      'root',
      'state',
    ]);
    assert.match(line.reason, /idle .*h, threshold \d+h/);
  }
  assert.equal(lines.find(line => line.laneId === old.laneId).state, 'active');
  // activeLanePruneHours 0 means an open Lane is never removed.
  const never = await prepare('never', 24 * 30);
  const kept = await laneHousekeeping({
    readStates: async (_address, laneIds) => new Map(laneIds.map(id => [id, 'active'])),
    address,
    apply: true,
    now,
    settings: { ...settings, activeLanePruneHours: 0 },
    isDirty: () => false,
  });
  assert(existsSync(never.root));
  assert.deepEqual(kept.pruned, []);
});

test('incident replay: a builder waiting on a long landing loses no Lane folder to housekeeping', async t => {
  // lane-0a94a093 vanished while its builder waited: the server still said active, the root had no
  // unsaved edits (everything saved before the landing) and 3 h without a Forge action elapsed.
  const directory = isolated(t);
  const now = Date.now(),
    root = join(directory, 'lane-0a94a093'),
    laneId = await realCheckout(root);
  ageTree(root, 4);
  ageTree(`${root}.forge-client`, 4);
  if (existsSync(`${root}.forge-metrics.jsonl`)) age(`${root}.forge-metrics.jsonl`, 4);
  recordLane({ laneId, root, ...address, lastActionAt: now - 4 * hour }, now);
  const readStates = async (_address, laneIds) => new Map(laneIds.map(id => [id, 'active']));
  const input = { readStates, address, apply: true, now, settings: { autoPruneHours: 3, idleLaneHours: 1 } };
  const result = await laneHousekeeping(input);
  assert(existsSync(root));
  assert.deepEqual(result.pruned, []);
  // Even past the active age, a command still running in the Lane (a landing wait) protects the root.
  recordLane(
    {
      laneId,
      running: { action: 'wait', pid: process.pid, since: now - hour },
      lastActionAt: now - 30 * 24 * hour,
    },
    now,
  );
  const running = await laneHousekeeping({ ...input, isDirty: () => false });
  assert(existsSync(root));
  assert.equal(running.kept.find(item => item.laneId === laneId)?.reason, 'command running');
});

test('a killed driver’s wake directory is swept; live and young ones stay', async t => {
  // The sockets below sit two levels down; keep the whole path under the Unix socket limit.
  const temp = socketDirectory('forge-test-wake-', 'nforge-wake-abcdef/wake'),
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

test('GC protects relative sibling links and recent registry use through a symlinked parent', t => {
  const directory = isolated(t),
    physical = join(directory, 'physical'),
    alias = join(directory, 'alias');
  mkdirSync(physical);
  symlinkSync(physical, alias);
  const root = join(alias, 'main'),
    linked = copy(root, 1e9, 40),
    active = copy(root, 1e9, 41);
  symlinkSync(`main.forge-client/lanes/${linked.laneId}`, join(alias, 'linked-lane'));
  recordLane({ laneId: active.laneId, root: active.path, ...address, lastActionAt: Date.now() });
  const result = gcNestedLanes({ root, settings: settings(0.5, 0), isDirty: clean });
  assert.equal(
    result.kept.find(item => item.laneId === linked.laneId)?.reason,
    'linked from a sibling directory',
  );
  assert.equal(result.kept.find(item => item.laneId === active.laneId)?.reason, 'in use');
  assert.equal(result.evicted.length, 0);
  assert(existsSync(linked.path) && existsSync(active.path));
});

test('prune keeps a checkout excluded through an alias of its physical root', async t => {
  const directory = isolated(t),
    physical = join(directory, 'physical'),
    alias = join(directory, 'alias');
  mkdirSync(physical);
  symlinkSync(physical, alias);
  const root = join(physical, 'checkout'),
    laneId = randomUUID(),
    now = Date.now();
  await realCheckout(root, laneId);
  ageTree(root, 10);
  ageTree(`${root}.forge-client`, 10);
  recordLane({ laneId, root, ...address, lastActionAt: now - 10 * hour }, now);
  const result = await laneHousekeeping({
    readStates: async () => new Map([[laneId, 'completed']]),
    address,
    apply: true,
    now,
    exclude: { roots: [join(alias, 'checkout')] },
    settings: { autoPruneHours: 3, idleLaneHours: 0 },
  });
  assert.equal(result.kept.find(item => item.laneId === laneId)?.reason, 'in use by this command');
  assert.equal(result.pruned.length, 0);
  assert(existsSync(join(root, 'src', 'a.txt')));
});

test('the worker wake socket falls back to a short root when TMPDIR is too deep for a Unix socket', async t => {
  const deep = mkdtempSync(join(tmpdir(), 'forge-test-deep-')),
    saved = process.env.TMPDIR;
  let nested = deep;
  while (Buffer.byteLength(nested) < 120) nested = join(nested, 'nested-runtime-directory');
  mkdirSync(nested, { recursive: true });
  process.env.TMPDIR = nested;
  t.after(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(deep, { recursive: true, force: true });
  });
  assert(Buffer.byteLength(join(nested, 'nforge-wake-abcdef', 'wake')) > 104);
  const channel = await openWorkerNotifications();
  try {
    assert(Buffer.byteLength(channel.endpoint) <= 100, channel.endpoint);
    assert(!channel.endpoint.startsWith(nested));
    const woken = new Promise(resolve => channel.subscribe(resolve));
    const { createConnection } = await import('node:net');
    createConnection(channel.endpoint).on('error', () => {});
    await woken;
  } finally {
    await channel.close();
  }
});

test('cache eviction retains a long-running process directory and unknown coverage, and logs unused-copy removal', t => {
  const directory = isolated(t),
    root = join(directory, 'main');
  const running = copy(root, 1e9, 50),
    unused = copy(root, 1e9, 51);
  const unusedPhysicalPath = realpathSync(unused.path);
  const result = gcNestedLanes({
    root,
    settings: settings(0.5, 0),
    isDirty: clean,
    processes: () => ({ paths: [join(realpathSync(running.path), 'nested')], unknown: false }),
  });
  assert(existsSync(running.path), 'saved source with ignored run artifacts stays with its process');
  assert(!existsSync(unused.path));
  assert.deepEqual(
    result.evicted.map(x => x.laneId),
    [unused.laneId],
  );
  const log = readFileSync(lanePruneLogFile(), 'utf8').trim().split('\n').map(JSON.parse);
  assert(log.some(x => x.root === unusedPhysicalPath && x.state === 'cache' && x.bytes === 1e9));
  const unknown = gcNestedLanes({
    root,
    settings: settings(0.5, 0),
    isDirty: clean,
    processes: () => ({ paths: [], unknown: true }),
  });
  assert.deepEqual(unknown.evicted, []);
  assert(existsSync(running.path));
});

test('automatic idle pruning retains a process directory even when no Forge command is registered', async t => {
  const directory = isolated(t),
    root = join(directory, 'running');
  const id = await realCheckout(root),
    now = Date.now();
  ageTree(root, 10);
  ageTree(`${root}.forge-client`, 10);
  ageTree(`${root}.forge-metrics.jsonl`, 10);
  recordLane({ laneId: id, root, ...address, lastActionAt: now - 10 * hour }, now);
  const input = {
    apply: true,
    address,
    now,
    settings: { autoPruneHours: 3, idleLaneHours: 1, activeLanePruneHours: 3 },
    readStates: async () => new Map([[id, 'active']]),
    isDirty: clean,
  };
  const running = await laneHousekeeping({
    ...input,
    processes: () => ({ paths: [join(realpathSync(root), 'nested')], unknown: false }),
  });
  assert.deepEqual(running.pruned, []);
  assert(existsSync(root));
  const unknown = await laneHousekeeping({ ...input, processes: () => ({ paths: [], unknown: true }) });
  assert.deepEqual(unknown.pruned, []);
  assert(existsSync(root));
  const unused = await laneHousekeeping({ ...input, processes: () => ({ paths: [], unknown: false }) });
  assert.deepEqual(
    unused.pruned.map(x => x.laneId),
    [id],
  );
  assert(!existsSync(root));
});
