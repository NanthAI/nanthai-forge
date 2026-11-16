// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { pruneDependencyCache, touchDependencyEntry } from '../dist/dependency-cache.js';
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

test('a CLI install stage renamed into a retained runtime keeps its dependency tree', t => {
  const f = fixture(t),
    entry = f.entry(1),
    stage = join(f.directory, 'cli', 'builds', '.install-stage');
  mkdirSync(stage, { recursive: true });
  linkDirectory(join(entry, 'node_modules'), join(stage, 'node_modules'));
  touchDependencyEntry(entry, stage);
  const runtime = join(dirname(stage), 'abc123');
  renameSync(stage, runtime);
  assert.deepEqual(f.sweep().removed, []);
  assert.equal(readFileSync(join(runtime, 'node_modules', 'dep', 'index.js'), 'utf8').length, 1000);
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
