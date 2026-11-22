// SPDX-License-Identifier: Apache-2.0
import './automatic-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { gcNestedLanes, gcNestedLanesHourly, touchNestedLane } from '../dist/client-cache-gc.js';
import { writeCacheUse } from '../dist/client-cache-use.js';
import { pruneDependencyCache, touchDependencyEntry } from '../dist/dependency-cache.js';
import { hostedLaneDirty } from '../dist/hosted-lane-dirty.js';
import { laneHousekeeping } from '../dist/lane-prune.js';
import { lanePruneLogFile } from '../dist/lane-prune-log.js';
import { snapshotDirectory, snapshotLockPath } from '../dist/lane-snapshot-hint.js';
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
  if (lstatSync(path).isSymbolicLink()) lutimesSync(path, when, when);
  else utimesSync(path, when, when);
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

test('cache GC runs at most once an hour and an unfinished pass resumes after a short retry', t => {
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
  // An out-of-time pass resumes five minutes later, not on every command (7da396ed F4).
  const late = copy(root, 10, 50);
  rmSync(`${root}.forge-client/gc-stamp`);
  const now = Date.now();
  const partial = gcNestedLanesHourly({ root, settings: settings(2, 24), isDirty: clean, budgetMs: -1, now });
  assert.equal(partial.finished, false);
  assert(existsSync(late.path));
  assert.equal(
    gcNestedLanesHourly({ root, settings: settings(2, 24), isDirty: clean, now: now + 60_000 }),
    null,
    'the next command within the retry window does not rerun the pass',
  );
  const resumed = gcNestedLanesHourly({
    root,
    settings: settings(2, 24),
    isDirty: clean,
    now: now + 6 * 60_000,
  });
  assert.equal(resumed.finished, true, 'the pass resumes after the retry window');
  assert(!existsSync(late.path));
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

test('finished Lane prune ignores snapshot maintenance without losing dirty or held copies', async t => {
  const directory = isolated(t);
  const settings = { autoPruneHours: 3, idleLaneHours: 1, activeLanePruneHours: 3 };
  const now = Date.parse('2026-01-02T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const states = new Map();
  const prepare = async (name, state) => {
    const root = join(directory, name);
    const laneId = await realCheckout(root);
    const snapshots = snapshotDirectory(root);
    mkdirSync(snapshots, { recursive: true });
    ageTree(root, 10);
    ageTree(`${root}.forge-client`, 10);
    age(`${root}.forge-metrics.jsonl`, 10);
    recordLane({ laneId, root, ...address, lastActionAt: now - 10 * hour }, now);
    states.set(laneId, state);
    const stat = join(snapshots, 'stat.json');
    const temporary = `${stat}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ entries: 'x'.repeat(32 * 1024) }));
    renameSync(temporary, stat);
    writeFileSync(join(snapshots, 'worker'), '');
    for (const path of [snapshots, stat]) age(path, 0);
    age(join(snapshots, 'worker'), 2 / 60);
    return { root, laneId, stat, snapshots };
  };
  const done = await prepare('landed', 'completed');
  const abandoned = await prepare('abandoned', 'abandoned');
  const dirty = await prepare('dirty', 'completed');
  const inUse = await prepare('snapshot in use', 'abandoned');
  const starting = await prepare('snapshot starting', 'abandoned');
  const racing = await prepare('snapshot raced prune', 'completed');
  const pending = await prepare('pending', 'completed');
  const recent = await prepare('recent', 'abandoned');
  const pinned = await prepare('pinned', { state: 'completed', pinned: true });
  const active = await prepare('active', 'active');
  const edited = join(dirty.root, 'src', 'a.txt');
  writeFileSync(edited, 'unsaved\n');
  age(edited, 10);
  writeFileSync(snapshotLockPath(inUse.root), String(process.pid));
  writeFileSync(join(pending.snapshots, 'pending.json'), '{}');
  writeFileSync(join(recent.root, 'src', 'a.txt'), 'first\n');
  for (const path of [
    snapshotLockPath(inUse.root),
    join(starting.snapshots, 'worker'),
    join(pending.snapshots, 'pending.json'),
    join(recent.root, 'src', 'a.txt'),
  ])
    age(path, 0);
  const input = {
    readStates: async () => states,
    address,
    now,
    settings,
    processes: () => ({ paths: [], unknown: false }),
  };
  const dry = await laneHousekeeping({ ...input, apply: false });
  assert.deepEqual(
    new Set(dry.wouldPrune.map(row => row.laneId)),
    new Set([done.laneId, abandoned.laneId, racing.laneId]),
  );
  assert.deepEqual(dry.pruned, []);
  assert(existsSync(done.stat) && existsSync(abandoned.stat));
  const bytes = path => {
    const stat = lstatSync(path);
    const children = stat.isDirectory() ? readdirSync(path) : [];
    return stat.blocks * 512 + children.reduce((total, name) => total + bytes(join(path, name)), 0);
  };
  const expectedBytes =
    bytes(done.root) + bytes(`${done.root}.forge-client`) + bytes(`${done.root}.forge-metrics.jsonl`);
  assert.equal(dry.wouldPrune.find(row => row.laneId === done.laneId).bytes, expectedBytes);

  const applied = await laneHousekeeping({
    ...input,
    apply: true,
    isDirty: root => {
      if (root === realpathSync(racing.root)) {
        const lock = snapshotLockPath(root);
        writeFileSync(lock, String(process.pid));
        age(lock, 0);
      }
      return hostedLaneDirty(root);
    },
  });
  assert.deepEqual(
    applied.pruned,
    dry.wouldPrune.filter(row => row.laneId !== racing.laneId),
  );
  assert(!existsSync(done.root) && !existsSync(abandoned.root));
  assert(!existsSync(done.stat) && !existsSync(abandoned.stat));
  assert.equal(readFileSync(edited, 'utf8'), 'unsaved\n');
  const kept = new Map(applied.kept.map(row => [row.laneId, row.reason]));
  assert.equal(kept.get(dirty.laneId), 'unsaved edits');
  for (const lane of [inUse, starting, racing]) assert.equal(kept.get(lane.laneId), 'snapshot running');
  assert.equal(kept.get(pinned.laneId), 'pinned');
  for (const lane of [pending, recent, active]) assert.equal(kept.get(lane.laneId), 'modified within 3h');
  assert([inUse, starting, racing, pending, recent, pinned, active].every(lane => existsSync(lane.root)));
  const logged = readFileSync(lanePruneLogFile(), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logged.find(row => row.laneId === done.laneId).bytes, expectedBytes);
});

test('finished Lane prune releases dependency links despite cache inventory writes, but retains old unsaved edits', async t => {
  const directory = realpathSync(isolated(t));
  const project = join(directory, 'project');
  const lanes = join(`${project}.forge-client`, 'lanes');
  const now = Date.parse('2026-01-02T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const installed = join(directory, 'deps', `npm-${'1'.repeat(24)}`);
  const modules = join(installed, 'node_modules');
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(modules, 'dep.js'), 'synthetic');
  const make = async name => {
    const root = join(lanes, name);
    const laneId = await realCheckout(root);
    recordLane({ laneId, root, ...address, lastActionAt: now - 10 * hour }, now);
    return { root, laneId };
  };
  const done = await make('finished-aaaaaaaa');
  const dirty = await make('dirty-bbbbbbbb');
  const live = await make('live-cccccccc');
  const parent = await make('parent-dddddddd');
  const recent = await make('recent-eeeeeeee');
  const raced = await make('raced-ffffffff');
  const nested = join(parent.root, '.forge', 'scratch', 'sub.forge-client', 'lanes', randomUUID());
  await realCheckout(nested);
  symlinkSync(modules, join(done.root, 'node_modules'));
  touchDependencyEntry(installed, done.root);
  writeFileSync(join(dirty.root, 'src', 'a.txt'), 'unsaved');
  for (const lane of [done, dirty, live, parent, recent, raced]) {
    ageTree(lane.root, 10);
    ageTree(`${lane.root}.forge-client`, 10);
    age(`${lane.root}.forge-metrics.jsonl`, 10);
    writeCacheUse(lane.root, { bytes: 4096, used: now - (lane === recent ? 0 : 10 * hour) });
  }
  // The earlier size writer replaced an unchanged file on each pass. A measured
  // record must survive inventory, and the earlier replacement must not refresh use.
  const cache = `${dirty.root}.forge-client`;
  age(cache, 10);
  gcNestedLanes({ root: project, settings: settings(2, 24), isDirty: clean });
  assert(lstatSync(cache).mtimeMs < now - 3 * hour);
  const deps = { cache: join(directory, 'deps'), budgetBytes: 1 };
  assert.deepEqual(pruneDependencyCache({ ...deps, apply: false }).wouldRemove, []);
  let sourceInspected = false;
  const result = await laneHousekeeping({
    apply: true,
    settings: { autoPruneHours: 3, idleLaneHours: 1 },
    scan: lanes,
    isDirty: root => {
      if (root === raced.root) sourceInspected = true;
      return hostedLaneDirty(root);
    },
    readStates: async (_address, ids) => new Map(ids.map(id => [id, 'completed'])),
    processes: () => ({
      paths: [`${live.root}.forge-client`, ...(sourceInspected ? [join(raced.root, 'src', 'a.txt')] : [])],
      unknown: false,
    }),
  });
  assert.deepEqual(
    result.pruned.map(item => item.laneId),
    [done.laneId],
  );
  assert(!existsSync(done.root));
  assert.equal(readFileSync(join(dirty.root, 'src', 'a.txt'), 'utf8'), 'unsaved');
  assert(existsSync(nested));
  const reasons = new Map(result.kept.map(row => [row.laneId, row.reason]));
  assert.equal(reasons.get(dirty.laneId), 'unsaved edits');
  assert.equal(reasons.get(parent.laneId), 'contains other Lane roots');
  assert.equal(reasons.get(recent.laneId), 'modified within 3h');
  assert.match(reasons.get(live.laneId), /process is working/);
  assert.match(reasons.get(raced.laneId), /process is working/);
  assert(existsSync(raced.root));
  assert.deepEqual(
    pruneDependencyCache(deps).removed.map(row => row.entry),
    [installed],
  );
});

test('prune inventories stale registry paths, unregistered checkouts, cache companions and markerless folders', async t => {
  const directory = realpathSync(isolated(t));
  const now = Date.parse('2026-01-02T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const scan = join(directory, 'lanes');
  const moved = join(scan, 'moved'),
    missing = join(directory, 'old-path'),
    active = join(scan, 'active');
  const movedId = await realCheckout(moved),
    activeId = await realCheckout(active);
  const scratch = join(active, '.forge', 'scratch');
  mkdirSync(scratch);
  writeFileSync(join(scratch, 'output.txt'), 'x'.repeat(16_384));
  const unknown = join(scan, 'markerless');
  const closed = join(scan, 'closed-without-landing');
  const closedId = await realCheckout(closed);
  const outside = join(directory, 'outside');
  const outsideRoot = join(outside, 'outside-aaaaaaaa');
  const outsideId = await realCheckout(outsideRoot);
  const alias = join(scan, 'alias.forge-client');
  mkdirSync(alias);
  symlinkSync(outside, join(alias, 'lanes'));
  const duplicate = join(scan, 'duplicate');
  mkdirSync(unknown);
  await realCheckout(duplicate, movedId);
  for (const root of [moved, active, duplicate, closed, outsideRoot]) {
    ageTree(root, 10);
    ageTree(`${root}.forge-client`, 10);
    age(`${root}.forge-metrics.jsonl`, 10);
  }
  recordLane({ laneId: movedId, root: missing, ...address, lastActionAt: now - 10 * hour }, now);
  const landedHead = JSON.parse(readFileSync(join(moved, '.forge', 'hosted-lane.json'), 'utf8')).selection
    .head;
  const input = {
    scan,
    now,
    finishedOnly: true,
    settings: { autoPruneHours: 3, idleLaneHours: 1, activeLanePruneHours: 3 },
    scratchBudgetBytes: 4096,
    readStates: async () =>
      new Map([
        [movedId, { state: 'completed', landedHead }],
        [activeId, 'active'],
        [closedId, 'completed'],
        [outsideId, 'abandoned'],
      ]),
    processes: () => ({ paths: [], unknown: false }),
  };
  const ambiguous = await laneHousekeeping({ ...input, apply: false });
  assert.deepEqual(ambiguous.wouldPrune, []);
  assert.equal(
    ambiguous.folders.find(row => row.root === moved).reason,
    'multiple unregistered roots claim the same Lane',
  );
  renameSync(duplicate, join(directory, 'outside-scan'));
  const result = await laneHousekeeping({ ...input, apply: true });
  const byRoot = new Map(result.folders.map(row => [row.root, row]));
  assert.deepEqual(
    [...byRoot.keys()].filter(existsSync).sort(),
    readdirSync(scan)
      .map(name => join(scan, name))
      .filter(path => lstatSync(path).isDirectory())
      .sort(),
  );
  assert.deepEqual(
    result.pruned.map(row => row.laneId),
    [movedId],
  );
  assert.equal(byRoot.get(moved).registered, false);
  assert.equal(byRoot.get(unknown).reason, 'no readable hosted Lane marker');
  assert.equal(byRoot.get(`${moved}.forge-client`).reason, 'removed with Lane checkout');
  assert.equal(byRoot.get(active).reason, 'active Lane');
  assert.equal(byRoot.get(closed).reason, 'no verified landing for this checkout head');
  assert(existsSync(outsideRoot) && !byRoot.has(outsideRoot));
  assert(byRoot.get(active).scratchBytes >= 16_384);
  assert.equal(byRoot.get(active).largeScratch, true);
});

test('bounded start cleanup resumes after a slow dirty Lane', async t => {
  const directory = realpathSync(isolated(t));
  const now = Date.parse('2026-01-02T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const dirty = join(directory, 'dirty');
  const clean = join(directory, 'clean');
  await realCheckout(dirty, first);
  await realCheckout(clean, second);
  for (const [root, laneId] of [
    [dirty, first],
    [clean, second],
  ]) {
    ageTree(root, 10);
    ageTree(`${root}.forge-client`, 10);
    age(`${root}.forge-metrics.jsonl`, 10);
    recordLane({ root, laneId, ...address, lastActionAt: now - 10 * hour }, now);
  }
  const input = {
    apply: true,
    address,
    now,
    budgetMs: 8000,
    settings: { autoPruneHours: 3, idleLaneHours: 1 },
    readStates: async (_address, ids) => new Map(ids.map(id => [id, 'abandoned'])),
    processes: () => ({ paths: [], unknown: false }),
    isDirty: root => {
      if (root !== dirty) return hostedLaneDirty(root);
      t.mock.timers.tick(8000);
      return true;
    },
  };
  const firstPass = await laneHousekeeping(input);
  assert.equal(firstPass.kept.find(row => row.laneId === first).reason, 'unsaved edits');
  assert(existsSync(clean));
  const secondPass = await laneHousekeeping(input);
  assert.deepEqual(
    secondPass.pruned.map(row => row.laneId),
    [second],
  );
  assert(existsSync(dirty));
});

test('explicit prune reclaims clean deleted-project copies and retains unsaved, pinned and held copies', async t => {
  const directory = realpathSync(isolated(t));
  const now = Date.parse('2026-01-02T00:00:00Z'),
    states = new Map();
  t.mock.timers.enable({ apis: ['Date'], now });
  const prepare = async (name, state = 'project-deleted', flags = {}) => {
    const laneId = randomUUID(),
      root = join(directory, `${name}.forge-client`, 'lanes', laneId);
    await realCheckout(root, laneId);
    ageTree(root, 10);
    ageTree(`${root}.forge-client`, 10);
    age(`${root}.forge-metrics.jsonl`, 10);
    recordLane({ laneId, root, ...address, lastActionAt: now - 10 * hour, ...flags });
    states.set(laneId, state);
    return { root, laneId };
  };
  const deleted = await prepare('deleted'),
    dirty = await prepare('dirty'),
    withheld = await prepare('withheld', 'unknown'),
    pinned = await prepare('pinned', 'project-deleted', { pinned: true }),
    held = await prepare('held', 'project-deleted', {
      landing: { operationId: randomUUID(), at: now - 10 * hour },
    }),
    inUse = await prepare('in-use');
  const edited = join(dirty.root, 'src', 'a.txt');
  writeFileSync(edited, 'unsaved\n');
  age(edited, 10);
  const input = {
    readStates: async () => states,
    now,
    settings: { autoPruneHours: 3, idleLaneHours: 1 },
    processes: () => ({ paths: [inUse.root], unknown: false }),
  };
  assert.deepEqual((await laneHousekeeping({ ...input, apply: true })).pruned, []);
  const dry = await laneHousekeeping({ ...input, apply: false, deletedProjects: true });
  assert.deepEqual(
    dry.wouldPrune.map(row => row.laneId),
    [deleted.laneId],
  );
  assert(existsSync(deleted.root));
  const applied = await laneHousekeeping({ ...input, apply: true, deletedProjects: true });
  assert.deepEqual(applied.pruned, dry.wouldPrune);
  assert(!existsSync(deleted.root));
  assert.equal(readFileSync(edited, 'utf8'), 'unsaved\n');
  assert([withheld, pinned, held, inUse].every(lane => existsSync(lane.root)));
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

test('incident replay 7da396ed: cache GC never evicts an open Lane checkout whose landing is in flight', t => {
  // be3c9d3d (2026-11-17T17:29Z) and 15b05101 (2026-11-18): start puts a builder's own Lane under
  // ROOT.forge-client/lanes. Everything was saved, land was submitted and 11 minutes passed; another
  // builder's command ran the hourly pass with the directory over its size cap and removed the folder
  // as "Unused Lane cache exceeded size cap" while the landing was still checking.
  const directory = isolated(t),
    root = join(directory, 'main'),
    now = Date.now();
  const landing = copy(root, 1e9, 0.18),
    landed = copy(root, 1e9, 30),
    cached = copy(root, 1e9, 20);
  recordLane(
    { laneId: landing.laneId, root: landing.path, ...address, lastActionAt: now - 0.18 * hour },
    now,
  );
  recordLane({ laneId: landed.laneId, root: landed.path, ...address, state: 'completed' }, now - 30 * hour);
  const result = gcNestedLanes({ root, settings: settings(0.5, 0), isDirty: clean, now });
  assert(existsSync(landing.path), 'the open Lane folder survives the pass');
  assert.equal(result.kept.find(item => item.laneId === landing.laneId)?.reason, 'open Lane checkout');
  // A landed Lane and an unregistered copy are still cache: removed oldest first.
  assert.deepEqual(result.evicted.map(item => item.laneId).sort(), [landed.laneId, cached.laneId].sort());
});

test('7da396ed F1: an open Lane entry idle past the active-prune age is cache again', t => {
  // An entry lane-prune never settles (say its server read keeps failing) must not pin disk forever.
  const directory = isolated(t),
    root = join(directory, 'main'),
    now = Date.now();
  const forgotten = copy(root, 1e9, 200);
  recordLane(
    { laneId: forgotten.laneId, root: forgotten.path, ...address, lastActionAt: now - 200 * hour },
    now,
  );
  const result = gcNestedLanes({
    root,
    settings: { ...settings(0.5, 0), activeLanePruneHours: 168 },
    isDirty: clean,
    now,
  });
  assert.deepEqual(
    result.evicted.map(item => item.laneId),
    [forgotten.laneId],
  );
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
