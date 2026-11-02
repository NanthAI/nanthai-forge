// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { gcNestedLanes, touchNestedLane } from '../dist/client-cache-gc.js';
import { cacheUsePath, readCacheUse } from '../dist/client-cache-use.js';
import { cleanHostedCheckout } from '../dist/hosted-checkout-files.js';

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'forge-cache-bookkeeping-'));
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory, 'state');
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const settings = { clientCacheMaxGB: 1, clientCacheMaxAgeHours: 1 };
const old = Date.now() - 48 * 3_600_000;
function copy(root) {
  const id = randomUUID(),
    path = join(`${root}.forge-client`, 'lanes', id);
  fs.mkdirSync(join(path, '.forge'), { recursive: true });
  fs.mkdirSync(`${path}.forge-client`);
  fs.writeFileSync(cacheUsePath(path), JSON.stringify({ bytes: 12345 }));
  for (const target of [path, cacheUsePath(path)]) fs.utimesSync(target, old / 1000, old / 1000);
  return { id, path };
}

for (const basename of ['a project.with spaces', '.forge-client', 'x.forge-client'])
  test(`touch, inventory and eviction share external bookkeeping for ${basename}`, t => {
    const directory = fixture(t),
      root = join(directory, basename);
    const c = copy(root);
    const now = Date.now();
    touchNestedLane(c.path, now);
    assert.equal(readCacheUse(c.path).bytes, 12345);
    assert(Math.abs(fs.statSync(cacheUsePath(c.path)).mtimeMs - now) < 1);
    assert.deepEqual(fs.readdirSync(join(c.path, '.forge')), []);
    const kept = gcNestedLanes({
      root,
      settings: { ...settings, clientCacheMaxGB: 0.000001 },
      now,
      isDirty: () => false,
    });
    assert.equal(kept.kept[0].reason, 'in use');
    assert.equal(kept.totalBytes, 12345);
    const evicted = gcNestedLanes({ root, settings, now: now + 2 * 3_600_000, isDirty: () => false });
    assert.deepEqual(evicted.evicted, [{ laneId: c.id, bytes: 12345 }]);
    assert(!fs.existsSync(c.path));
    assert(!fs.existsSync(cacheUsePath(c.path)));
  });

test('touch ignores ordinary roots and malformed nested Lane names', t => {
  const directory = fixture(t);
  for (const path of [join(directory, 'ordinary'), join(directory, 'x.forge-client/lanes/not-a-uuid')]) {
    touchNestedLane(path);
    assert(!fs.existsSync(`${path}.forge-client`));
  }
});

for (const kind of ['valid', 'empty', 'unknown field', 'invalid bytes', 'symlink', 'directory'])
  test(`legacy bookkeeping ${kind} is preserved without ignoring unknown metadata`, t => {
    const directory = fixture(t),
      c = copy(join(directory, 'project'));
    fs.rmSync(cacheUsePath(c.path));
    const path = join(c.path, '.forge/cache-use.json');
    const valid = ['valid', 'empty'].includes(kind);
    if (kind === 'symlink') fs.symlinkSync(join(directory, 'outside'), path);
    else if (kind === 'directory') fs.mkdirSync(path);
    else
      fs.writeFileSync(
        path,
        JSON.stringify(
          kind === 'valid'
            ? { bytes: 654 }
            : kind === 'empty'
              ? {}
              : kind === 'unknown field'
                ? { secret: 'keep' }
                : { bytes: -1 },
        ),
      );
    if (valid) {
      cleanHostedCheckout(c.path, [], 'hosted-lane.json', true);
      assert.equal(readCacheUse(c.path).bytes, kind === 'valid' ? 654 : undefined);
      assert(fs.existsSync(cacheUsePath(c.path)), 'legacy record survives checkout replacement');
      assert(fs.existsSync(path), 'validation leaves the original alone');
    } else {
      assert.throws(
        () => cleanHostedCheckout(c.path, [], 'hosted-lane.json', true),
        error => {
          assert.equal(error.code, 'WORK_CONFLICT');
          assert.match(error.message, /\.forge\/cache-use.json/);
          return true;
        },
      );
      assert(fs.lstatSync(path));
      const result = gcNestedLanes({
        root: join(directory, 'project'),
        settings,
        now: Date.now() + 2 * 3_600_000,
        isDirty: () => false,
      });
      assert.equal(result.kept[0].reason, 'unknown Forge metadata');
      assert(fs.lstatSync(path));
    }
  });

test('unknown Forge metadata is neither replaced nor evicted', t => {
  const directory = fixture(t),
    root = join(directory, 'project'),
    c = copy(root);
  const path = join(c.path, '.forge/keep.json');
  fs.writeFileSync(path, 'unknown');
  assert.throws(() => cleanHostedCheckout(c.path, [], 'hosted-lane.json', true), /\.forge\/keep.json/);
  const result = gcNestedLanes({ root, settings, isDirty: () => false });
  assert.equal(result.kept[0].reason, 'unknown Forge metadata');
  assert.equal(fs.readFileSync(path, 'utf8'), 'unknown');
});

for (const count of [560, 1120])
  test(`bookkeeping budget at ${count} active copies: constant IO per copy and zero Convex calls`, t => {
    const directory = fixture(t),
      root = join(directory, 'project');
    const copies = Array.from({ length: count }, () => copy(root));
    let calls = 0,
      reads = 0;
    for (const method of ['query', 'mutation', 'action'])
      t.mock.method(ConvexHttpClient.prototype, method, () => {
        calls++;
        throw Error('No network');
      });
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (path, ...args) => {
      reads++;
      assert(!copies.some(c => String(path) === c.path), 'cached size never walks checkout source');
      return readdir(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const memory = process.memoryUsage().heapUsed,
      start = performance.now();
    const result = gcNestedLanes({ root, settings: { ...settings, clientCacheMaxAgeHours: 0 } });
    const elapsed = performance.now() - start,
      heapGrowth = process.memoryUsage().heapUsed - memory;
    assert(result.finished);
    assert.equal(result.totalBytes, count * 12345);
    assert.equal(result.evicted.length, 0);
    assert(reads <= 3, `only cache, sibling and registry listings, observed ${reads}`);
    assert.equal(calls, 0);
    assert(heapGrowth < 64 * 1024 * 1024);
    t.diagnostic(
      `copies=${count} Convex=${calls} directoryReads=${reads} heapGrowth=${heapGrowth} wallMs=${elapsed.toFixed(1)} peakRSSKiB=${process.resourceUsage().maxRSS}`,
    );
  });
