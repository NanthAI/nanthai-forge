// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  existsSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  realpathSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname, basename } from 'node:path';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { pruneDependencyCache, retainDownloadCache, touchDependencyEntry } from '../dist/dependency-cache.js';
import { removeInstall, sealInstall } from '../dist/dependency-seal.js';
import { dependencyKey, shareDependencies } from '../dist/shared-dependencies.js';
import { tryHeavySlot } from '../dist/heavy-slots.js';
import { recordLane } from '../dist/lane-registry.js';
import { linkDirectory } from '../dist/source-links.js';
import { pruneCli } from '../dist/lane-prune.js';

function fixture(t) {
  const directory = realpathSync(temporaryDirectory(null, 'forge-dependency-cache-'));
  const saved = Object.fromEntries(
    ['XDG_STATE_HOME', 'XDG_CACHE_HOME', 'FORGE_DEPS_CACHE_MAX_GB'].map(key => [key, process.env[key]]),
  );
  process.env.XDG_STATE_HOME = join(directory, 'state');
  process.env.XDG_CACHE_HOME = directory;
  delete process.env.FORGE_DEPS_CACHE_MAX_GB;
  t.after(() => {
    removeInstall(directory);
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const cache = join(directory, 'forge', 'deps');
  const entry = (number, used = number) => {
    const name = `npm-${String(number).padStart(24, '0')}`,
      path = join(cache, name);
    mkdirSync(join(path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'dep', 'index.js'), 'x'.repeat(1000));
    writeFileSync(join(path, '.forge-complete'), name.slice(4));
    writeFileSync(join(path, '.forge-usage.json'), JSON.stringify({ used, roots: [] }));
    return path;
  };
  const sweep = extra => pruneDependencyCache({ cache, budgetBytes: 1, ...extra });
  return { directory, cache, entry, sweep };
}

test('eviction retains a legacy live Lane link and main while removing an unreferenced read-only install', t => {
  const f = fixture(t),
    live = f.entry(1),
    main = f.entry(2),
    unused = f.entry(3);
  const project = join(f.directory, 'project'),
    root = join(`${project}.forge-client`, 'lanes', 'live');
  mkdirSync(root, { recursive: true });
  mkdirSync(project);
  linkDirectory(join(live, 'node_modules'), join(root, 'node_modules'));
  linkDirectory(join(main, 'node_modules'), join(project, 'node_modules'));
  recordLane({
    laneId: '00000000-0000-4000-8000-000000000001',
    root,
    url: 'https://example.invalid',
    projectId: 'x',
  });
  sealInstall(unused, [join(unused, 'node_modules')]);
  const result = f.sweep();
  assert.deepEqual(
    result.removed.map(item => item.entry),
    [unused],
  );
  assert.equal(existsSync(unused), false);
  assert.equal(readFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'utf8').length, 1000);
  assert.equal(existsSync(main), true);
  assert.equal(result.bytes > result.budgetBytes, true, 'the budget never overrides live references');
});

test('unused installs are evicted by last use, including a cache hit that refreshes recency', t => {
  const f = fixture(t),
    one = f.entry(1, 1),
    two = f.entry(2, 2),
    three = f.entry(3, 3);
  touchDependencyEntry(one, join(f.directory, 'removed-lane'));
  const plan = f.sweep({ apply: false });
  const total = plan.wouldRemove.reduce((sum, item) => sum + item.bytes, 0);
  const oldest = plan.wouldRemove.find(item => item.entry === two);
  const result = f.sweep({ budgetBytes: total - oldest.bytes });
  assert.deepEqual(
    result.removed.map(item => item.entry),
    [two],
  );
  assert.equal(existsSync(one) && existsSync(three), true);
});

test('a running entry lock keeps its install, then an unlocked sealed entry can be removed', t => {
  const f = fixture(t),
    entry = f.entry(1),
    lock = tryHeavySlot(`${entry}.lock`, 1);
  assert.ok(lock);
  assert.deepEqual(f.sweep().removed, []);
  assert.equal(existsSync(entry), true);
  rmSync(lock, { recursive: true });
  sealInstall(entry, [join(entry, 'node_modules')]);
  assert.equal(f.sweep().removed[0].entry, entry);
});

test('abandoned partial installs and stages are reclaimed but a running stage stays', t => {
  const f = fixture(t),
    base = f.entry(1),
    stage = `${base}.tmp-abc123`;
  rmSync(join(base, '.forge-complete'));
  mkdirSync(stage);
  writeFileSync(join(stage, 'partial'), 'x');
  const lock = tryHeavySlot(`${base}.lock`, 1);
  assert.deepEqual(f.sweep().removed, []);
  rmSync(lock, { recursive: true });
  assert.deepEqual(new Set(f.sweep().removed.map(item => item.entry)), new Set([base, stage]));
});

test('an install racing eviction holds its lock through completion and reference publication', async t => {
  const f = fixture(t),
    root = join(f.directory, 'new-lane');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"name":"x"}');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
  const result = await shareDependencies(root, {
    cache: f.cache,
    enabled: true,
    heavy: false,
    install: async stage => {
      mkdirSync(join(stage, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(stage, 'node_modules', 'dep', 'index.js'), 'dep');
      assert.deepEqual(f.sweep().removed, [], 'GC cannot remove a running install stage');
    },
  });
  assert.equal(result.status, 'installed');
  assert.deepEqual(f.sweep().removed, [], 'published root reference survives after releasing the lock');
  assert.equal(readFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'dep');
  rmSync(join(root, 'node_modules'));
  assert.equal(f.sweep().removed.length, 1, 'an unlinked install becomes reclaimable');
});

test('a failed changed-lockfile install keeps its rollback entry during concurrent eviction', async t => {
  const f = fixture(t),
    root = join(f.directory, 'lane');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"name":"x"}');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
  const options = { cache: f.cache, enabled: true, heavy: false };
  await shareDependencies(root, {
    ...options,
    install: async stage => mkdirSync(join(stage, 'node_modules')),
  });
  const previous = readlinkSync(join(root, 'node_modules'));
  writeFileSync(
    join(root, 'package-lock.json'),
    '{"lockfileVersion":3,"packages":{"":{},"node_modules/new":{}}}',
  );
  const result = await shareDependencies(root, {
    ...options,
    install: async () => {
      assert.deepEqual(f.sweep().removed, [], 'the old entry is locked even while its Lane link is retired');
      throw new Error('synthetic install failure');
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(readlinkSync(join(root, 'node_modules')), previous);
  assert.equal(existsSync(previous), true);
});

test('nforge prune previews dependency eviction and --apply removes the same unused install', async t => {
  const f = fixture(t),
    entry = f.entry(1);
  process.env.FORGE_DEPS_CACHE_MAX_GB = '0.000000001';
  const readStates = async () => new Map();
  const preview = await pruneCli([], readStates);
  assert.deepEqual(
    preview.dependencies.wouldRemove.map(item => item.entry),
    [entry],
  );
  assert.equal(existsSync(entry), true);
  const applied = await pruneCli(['--apply'], readStates);
  assert.deepEqual(
    applied.dependencies.removed.map(item => item.entry),
    [entry],
  );
  assert.equal(existsSync(entry), false);
});

test('prune distinguishes a busy dependency sweep from an empty cache', async t => {
  const f = fixture(t);
  const readStates = async () => new Map();
  const empty = (await pruneCli([], readStates)).dependencies;
  assert.equal(empty.status, 'measured');
  assert.equal(empty.bytes, 0);

  const entry = f.entry(1);
  const sweep = tryHeavySlot(join(f.cache, '.gc.lock'), 1);
  assert.ok(sweep);
  try {
    const busy = (await pruneCli([], readStates)).dependencies;
    assert.equal(busy.status, 'busy');
    assert.equal(busy.bytes, null);
    assert.equal(busy.downloadBytes, null);
    assert.equal(busy.installedBytes, null);
    assert.deepEqual(busy.wouldRemove, []);
    assert.equal(existsSync(entry), true);
  } finally {
    rmSync(sweep, { recursive: true });
  }
  assert.equal((await pruneCli([], readStates)).dependencies.bytes > 0, true);
});

test('prune measures allocated cache bytes once per hard-linked inode, including downloads', async t => {
  const f = fixture(t);
  const first = f.entry(1),
    second = f.entry(2),
    downloads = join(f.cache, 'downloads'),
    store = join(downloads, 'pnpm'),
    outside = join(f.directory, 'outside');
  mkdirSync(store, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'private'), Buffer.alloc(256 * 1024));
  linkDirectory(outside, join(store, 'outside'));
  const payload = join(store, 'shared'),
    sparse = join(store, 'sparse');
  writeFileSync(payload, Buffer.alloc(64 * 1024, 1));
  writeFileSync(sparse, '');
  truncateSync(sparse, 4 * 1024 * 1024);
  for (const entry of [first, second]) {
    const installed = join(entry, 'node_modules', 'dep', 'index.js');
    rmSync(installed);
    linkSync(payload, installed);
  }
  linkSync(payload, join(store, 'shared-again'));
  process.env.FORGE_DEPS_CACHE_MAX_GB = '0.000000001';
  const readStates = async () => new Map();
  const preview = (await pruneCli([], readStates)).dependencies;
  const allocated = (...paths) => paths.reduce((sum, path) => sum + lstatSync(path).blocks * 512, 0);
  const downloadBytes = allocated(downloads, store, payload, sparse, join(store, 'outside'));
  assert.equal(preview.downloadBytes, downloadBytes);
  assert.equal(
    preview.bytes,
    downloadBytes +
      allocated(f.cache, join(f.cache, '.gc.lock'), `${first}.lock`, `${second}.lock`) +
      [first, second].reduce(
        (sum, entry) =>
          sum +
          allocated(
            entry,
            join(entry, 'node_modules'),
            join(entry, 'node_modules', 'dep'),
            join(entry, '.forge-complete'),
            join(entry, '.forge-usage.json'),
          ),
        0,
      ),
  );
  assert.deepEqual(
    preview.wouldRemove.map(item => item.entry),
    [first, second],
  );
  assert.equal(existsSync(first) && existsSync(second), true);
  const applied = (await pruneCli(['--apply'], readStates)).dependencies;
  assert.equal(applied.downloadBytes, downloadBytes);
  assert.equal(
    applied.bytes,
    downloadBytes + allocated(f.cache, join(f.cache, '.gc.lock'), `${first}.lock`, `${second}.lock`),
  );
  assert.equal(readFileSync(payload).length, 64 * 1024);
});

test('prune retains completed removals when a download directory cannot be measured', async t => {
  const f = fixture(t),
    entry = f.entry(1),
    downloads = join(f.cache, 'downloads');
  mkdirSync(downloads);
  process.env.FORGE_DEPS_CACHE_MAX_GB = '0.000000001';
  const readDirectory = readdirSync;
  const mock = t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === downloads)
      throw Object.assign(new Error('fixture denied directory read'), { code: 'EACCES' });
    return readDirectory(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = (await pruneCli(['--apply'], async () => new Map())).dependencies;
    assert.equal(result.status, 'unavailable');
    assert.equal(result.bytes, null);
    assert.equal(result.downloadBytes, null);
    assert.deepEqual(
      result.removed.map(item => item.entry),
      [entry],
    );
    assert.equal(existsSync(entry), false);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('prune discards the disk total when a download directory is replaced during measurement', async t => {
  const f = fixture(t),
    downloads = join(f.cache, 'downloads'),
    outside = join(f.directory, 'outside');
  mkdirSync(downloads, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'outside-file'), 'outside');
  const readDirectory = readdirSync;
  const mock = t.mock.method(fs, 'readdirSync', (path, ...args) => {
    if (path === downloads) {
      renameSync(downloads, join(f.directory, 'moved'));
      linkDirectory(outside, downloads);
    }
    return readDirectory(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = (await pruneCli([], async () => new Map())).dependencies;
    assert.equal(result.status, 'unavailable');
    assert.equal(result.bytes, null);
    assert.equal(result.downloadBytes, null);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('the default budget is 4 GiB and a positive GiB override changes it', t => {
  const f = fixture(t);
  assert.equal(f.sweep({ budgetBytes: undefined }).budgetBytes, 4 * 1024 ** 3);
  process.env.FORGE_DEPS_CACHE_MAX_GB = '1.5';
  assert.equal(f.sweep({ budgetBytes: undefined }).budgetBytes, 1.5 * 1024 ** 3);
  process.env.FORGE_DEPS_CACHE_MAX_GB = 'invalid';
  assert.equal(f.sweep({ budgetBytes: undefined }).budgetBytes, 4 * 1024 ** 3);
});

for (const mode of ['skipped', 'rebuild'])
  test(`a changed lockfile automatically replaces an npm-${mode} link`, async t => {
    const f = fixture(t),
      root = join(f.directory, mode);
    mkdirSync(root);
    const manifest = { name: 'x', ...(mode === 'rebuild' ? { trustedDependencies: ['native'] } : {}) };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    if (mode === 'skipped') writeFileSync(join(root, 'forge.json'), '{"install":{"scripts":true}}');

    // The rebuilt entry is seeded in its historical layout; no repository script needs to run.
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
    const oldKey = dependencyKey(root),
      old = join(f.cache, `npm-${mode}-${oldKey}`);
    mkdirSync(join(old, 'node_modules'), { recursive: true });
    writeFileSync(join(old, '.forge-complete'), oldKey);
    linkDirectory(join(old, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"":{},"node_modules/new":{}}}',
    );
    const result = await shareDependencies(root, {
      enabled: true,
      cache: f.cache,
      heavy: false,
      refresh: true,
      install: async stage => {
        mkdirSync(join(stage, 'node_modules', 'new'), { recursive: true });
        writeFileSync(join(stage, 'node_modules', 'new', 'index.js'), 'new');
      },
    });
    assert.equal(result.status, 'installed');
    assert.equal(result.relinked.from, oldKey);
    assert.equal(readFileSync(join(root, 'node_modules', 'new', 'index.js'), 'utf8'), 'new');
    assert.notEqual(dirname(readlinkSync(join(root, 'node_modules'))), old);
  });

test('workspace overlay references retain their install even when the budget is exceeded', async t => {
  const f = fixture(t),
    root = join(f.directory, 'workspace');
  mkdirSync(join(root, 'packages', 'a'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"x","workspaces":["packages/a"]}');
  writeFileSync(join(root, 'packages/a', 'package.json'), '{"name":"a"}');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{},"packages/a":{}}}');
  const result = await shareDependencies(root, {
    enabled: true,
    cache: f.cache,
    heavy: false,
    install: async stage => {
      mkdirSync(join(stage, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(stage, 'node_modules', 'dep', 'index.js'), 'workspace dep');
    },
  });
  assert.equal(result.status, 'installed');
  assert.deepEqual(f.sweep().removed, []);
  assert.equal(readFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'workspace dep');
});

test('only selected CLI builds and a live updater retain runtime dependency trees', t => {
  const f = fixture(t),
    installation = join(f.directory, 'cli'),
    builds = join(installation, 'builds'),
    update = tryHeavySlot(join(installation, 'update-lock'), 1);
  const pointers = ['current', 'previous', 'manager'];
  for (const [index, pointer] of pointers.entries()) {
    const entry = f.entry(index + 1),
      stage = join(builds, '.install-stage'),
      runtime = join(builds, (index + 1).toString().repeat(12));
    mkdirSync(stage, { recursive: true });
    linkDirectory(join(entry, 'node_modules'), join(stage, 'node_modules'));
    touchDependencyEntry(entry, stage);
    renameSync(stage, runtime);
    linkDirectory(runtime, join(installation, pointer));
  }
  const obsolete = f.entry(4),
    obsoleteBuild = join(builds, '4'.repeat(12));
  mkdirSync(obsoleteBuild);
  linkDirectory(join(obsolete, 'node_modules'), join(obsoleteBuild, 'node_modules'));
  touchDependencyEntry(obsolete, obsoleteBuild);
  assert.deepEqual(f.sweep().removed, []);
  rmSync(update, { recursive: true });
  const users = join(obsoleteBuild, '.users');
  mkdirSync(users);
  writeFileSync(join(users, String(process.pid)), JSON.stringify({ pid: process.pid }));
  assert.deepEqual(f.sweep().removed, [], 'a retired CLI can still lazy-load its dependencies');
  rmSync(users, { recursive: true });
  const otherBuilds = join(f.directory, 'project', 'builds', 'lane');
  const laneInstall = f.entry(5);
  mkdirSync(otherBuilds, { recursive: true });
  linkDirectory(join(laneInstall, 'node_modules'), join(otherBuilds, 'node_modules'));
  recordLane({ laneId: '00000000-0000-4000-8000-000000000005', root: otherBuilds });
  assert.deepEqual(
    f.sweep().removed.map(row => row.entry),
    [obsolete],
  );
  for (const pointer of pointers)
    assert.equal(
      readFileSync(join(installation, pointer, 'node_modules', 'dep', 'index.js'), 'utf8').length,
      1000,
    );
});

test('a dormant Lane loses only its install and recovers on refresh; pinned and running Lanes keep theirs', async t => {
  const f = fixture(t);
  const now = Date.parse('2026-01-02T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const before = now - 25 * 3_600_000;
  const options = {
    cache: f.cache,
    enabled: true,
    heavy: false,
    install: async stage => {
      mkdirSync(join(stage, 'node_modules'));
      writeFileSync(join(stage, 'node_modules', 'payload'), 'shared');
    },
  };
  const roots = [];
  for (const [index, kind] of ['dormant', 'recent', 'pinned', 'running'].entries()) {
    const root = join(f.directory, kind);
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: kind }));
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');
    assert.equal((await shareDependencies(root, options)).status, 'installed');
    const laneId = `00000000-0000-4000-8000-00000000000${index}`;
    recordLane({
      laneId,
      root,
      lastActionAt: kind === 'recent' ? now : before,
      ...(kind === 'pinned' ? { pinned: true } : {}),
      ...(kind === 'running' ? { running: { action: 'sync', pid: process.pid, since: before } } : {}),
    });
    roots.push({ root, laneId });
  }
  const { root, laneId } = roots[0];
  const dormant = dirname(readlinkSync(join(root, 'node_modules')));
  assert.deepEqual(
    f.sweep({ apply: false }).wouldRemove.map(row => row.entry),
    [dormant],
  );
  assert(existsSync(dormant));
  assert.deepEqual(
    f.sweep().removed.map(row => row.entry),
    [dormant],
  );
  assert(existsSync(join(root, 'package.json')));
  recordLane({ laneId });
  const restored = await shareDependencies(root, { ...options, refresh: true });
  assert.equal(restored.status, 'installed');
  assert.equal(restored.relinked.restored, true);
  assert.equal(readFileSync(join(root, 'node_modules', 'payload'), 'utf8'), 'shared');
});

test('explicit prune counts downloads and keeps a recent, linked or leased store while reclaiming an old one', t => {
  const f = fixture(t);
  const now = new Date('2026-01-02T00:00:00Z'),
    old = new Date(now.getTime() - 25 * 3_600_000);
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const store = scope => {
    const hold = retainDownloadCache(f.cache, { name: 'pnpm' }, scope);
    const path = hold.directory,
      payload = join(path, 'payload');
    writeFileSync(payload, Buffer.alloc(64 * 1024, 1));
    utimesSync(payload, old, old);
    utimesSync(path, old, old);
    return hold;
  };
  const unused = store('unused'),
    linked = store('linked'),
    recent = store('recent'),
    legacy = store(null),
    busy = store('busy');
  for (const item of [unused, linked, recent, legacy]) item.release();
  t.after(busy.release);
  utimesSync(recent.directory, now, now);
  const entry = f.entry(1);
  const root = join(f.directory, 'live');
  mkdirSync(root);
  linkDirectory(join(entry, 'node_modules'), join(root, 'node_modules'));
  touchDependencyEntry(entry, root, [], linked.directory);
  const legacyEntry = join(f.cache, `pnpm-${'2'.repeat(24)}`);
  renameSync(f.entry(2), legacyEntry);
  const legacyRoot = join(f.directory, 'legacy');
  mkdirSync(legacyRoot);
  linkDirectory(join(legacyEntry, 'node_modules'), join(legacyRoot, 'node_modules'));
  touchDependencyEntry(legacyEntry, legacyRoot);
  const outside = join(f.directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'outside');
  linkDirectory(outside, join(unused.directory, 'outside'));
  lutimesSync(join(unused.directory, 'outside'), old, old);
  utimesSync(unused.directory, old, old);
  const automatic = f.sweep();
  assert.deepEqual(automatic.removed, []);
  const preview = f.sweep({ remeasure: true, apply: false });
  assert(preview.bytes >= preview.downloadBytes && preview.downloadBytes >= 256 * 1024);
  assert.deepEqual(
    preview.wouldRemove.map(row => row.entry),
    [unused.directory],
  );
  assert(existsSync(unused.directory));
  const applied = f.sweep({ remeasure: true });
  assert.deepEqual(applied.removed, preview.wouldRemove);
  assert(applied.downloadBytes < preview.downloadBytes);
  assert(!existsSync(unused.directory));
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside');
  for (const item of [linked, recent, legacy, busy]) assert(existsSync(join(item.directory, 'payload')));
});

test('prune does not count shared blocks as reclaimed while a retained install still links them', t => {
  const f = fixture(t);
  const now = Date.parse('2026-01-02T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const store = (scope, hours) => {
    const hold = retainDownloadCache(f.cache, { name: 'pnpm' }, scope);
    const path = join(hold.directory, 'archive');
    writeFileSync(path, Buffer.alloc(128 * 1024, 1));
    const old = new Date(now - hours * 3_600_000);
    utimesSync(path, old, old);
    utimesSync(hold.directory, old, old);
    hold.release();
    return { dir: hold.directory, path };
  };
  const first = store('oldest', 48),
    second = store('next', 47);
  const entry = f.entry(1);
  const surviving = join(entry, 'node_modules', 'shared');
  linkSync(first.path, surviving);
  const root = join(f.directory, 'keep');
  mkdirSync(root);
  linkDirectory(join(entry, 'node_modules'), join(root, 'node_modules'));
  touchDependencyEntry(entry, root);
  const initial = f.sweep({ budgetBytes: 1024 ** 3, apply: false, remeasure: true });
  const budgetBytes = initial.bytes - 64 * 1024;
  const dry = f.sweep({ budgetBytes, apply: false, remeasure: true });
  assert.deepEqual(
    dry.wouldRemove.map(row => row.entry),
    [first.dir, second.dir],
  );
  const applied = f.sweep({ budgetBytes, remeasure: true });
  assert(applied.bytes <= budgetBytes);
  assert.equal(readFileSync(surviving).length, 128 * 1024);
});

test('writable tool-cache growth is counted without rewalking sealed packages or an explicit prune', t => {
  const f = fixture(t),
    entry = f.entry(1);
  sealInstall(entry, [join(entry, 'node_modules')]);
  const before = f.sweep({ budgetBytes: 1024 ** 3 }).bytes;
  mkdirSync(join(entry, 'node_modules', '.vite'));
  writeFileSync(join(entry, 'node_modules', '.vite', 'output'), Buffer.alloc(64 * 1024));
  const after = f.sweep({ budgetBytes: 1024 ** 3 }).bytes;
  assert.equal(after - before >= 64 * 1024, true);
  assert.deepEqual(
    f.sweep({ budgetBytes: before + 1024 }).removed.map(item => item.entry),
    [entry],
  );
});

test('two Lanes swapping lockfiles relink concurrently without an install-lock cycle', async t => {
  const f = fixture(t),
    roots = ['a', 'b'].map(name => join(f.directory, name));
  const locks = ['a', 'b'].map(name =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, [`node_modules/${name}`]: {} } }),
  );
  const options = {
    enabled: true,
    cache: f.cache,
    heavy: false,
    install: async stage => {
      mkdirSync(join(stage, 'node_modules'), { recursive: true });
    },
  };
  for (const [index, root] of roots.entries()) {
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    writeFileSync(join(root, 'package-lock.json'), locks[index]);
    await shareDependencies(root, options);
  }
  const before = roots.map(root => readlinkSync(join(root, 'node_modules')));
  for (const [index, root] of roots.entries())
    writeFileSync(join(root, 'package-lock.json'), locks[1 - index]);
  const results = await Promise.all(roots.map(root => shareDependencies(root, options)));
  assert.deepEqual(
    results.map(result => result.status),
    ['linked', 'linked'],
  );
  assert.deepEqual(
    roots.map(root => readlinkSync(join(root, 'node_modules'))),
    before.toReversed(),
  );
});

for (const linkThroughAlias of [false, true])
  test(`a live install survives eviction through a cache alias (link through alias: ${linkThroughAlias})`, t => {
    const f = fixture(t),
      entry = f.entry(1),
      alias = join(f.directory, 'cache-alias'),
      root = join(f.directory, 'lane');
    linkDirectory(f.cache, alias);
    mkdirSync(root);
    const linked = linkThroughAlias ? join(alias, basename(entry)) : entry;
    linkDirectory(join(linked, 'node_modules'), join(root, 'node_modules'));
    touchDependencyEntry(linked, root);
    const result = pruneDependencyCache({ cache: linkThroughAlias ? f.cache : alias, budgetBytes: 1 });
    assert.deepEqual(result.removed, []);
    assert.equal(readFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'utf8').length, 1000);
  });
