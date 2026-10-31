// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneReleases, slimReleaseBuild, settleRelease } from '../dist/maintainer-release-retention.js';

const hex = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
function runtime(t, count, { chain = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const releases = join(dir, 'releases');
  const install = n => join(releases, hex(n), 'install-x');
  for (let n = 1; n <= count; n++) {
    mkdirSync(join(install(n), 'node_modules'), { recursive: true });
    writeFileSync(join(releases, hex(n), 'package.json'), '{}');
    // Release N replaced release N-1 (the first one replaced a legacy backup outside releases/).
    writeFileSync(
      join(releases, hex(n), 'owner-install-selection.json'),
      JSON.stringify({
        installed: install(n),
        previous: n > 1 && chain ? install(n - 1) : join(dir, 'legacy'),
      }),
    );
  }
  symlinkSync(install(count), join(dir, 'installed-owner'));
  return { dir, releases, hex, exists: n => existsSync(join(releases, hex(n))) };
}
const idle = { inUse: () => false };

test('keeps the rollback chain of the current release and removes the rest', t => {
  const f = runtime(t, 6);
  const result = pruneReleases(f.dir, hex(6), 3, idle);
  assert.deepEqual(result.kept, [hex(4), hex(5), hex(6)]);
  assert.deepEqual(result.removed, [hex(1), hex(2), hex(3)]);
  for (const n of [4, 5, 6]) assert.ok(f.exists(n));
  for (const n of [1, 2, 3]) assert.ok(!f.exists(n));
});

test('retention count is configurable and always keeps current plus previous at minimum 2', t => {
  const f = runtime(t, 5);
  assert.deepEqual(pruneReleases(f.dir, hex(5), 2, idle).kept, [hex(4), hex(5)]);
  const g = runtime(t, 5);
  assert.deepEqual(pruneReleases(g.dir, hex(5), 5, idle).removed, []);
});

test('the install link target is a root even when the finished release is older', t => {
  const f = runtime(t, 5);
  // Release 5 finished, but the owner still runs release 3 (a rollback happened).
  rmSync(join(f.dir, 'installed-owner'));
  symlinkSync(join(f.releases, hex(3), 'install-x'), join(f.dir, 'installed-owner'));
  const result = pruneReleases(f.dir, hex(5), 2, idle);
  assert.deepEqual(result.kept, [hex(2), hex(3), hex(4), hex(5)]);
  assert.deepEqual(result.removed, [hex(1)]);
});

test('a release a process still uses survives and is reported', t => {
  const f = runtime(t, 6);
  const used = join(f.releases, hex(1));
  const result = pruneReleases(f.dir, hex(6), 3, { inUse: directory => directory === used });
  assert.ok(f.exists(1));
  assert.deepEqual(result.skipped, [{ release: hex(1), reason: 'in-use' }]);
  assert.deepEqual(result.removed, [hex(2), hex(3)]);
});

test('an unfinished release is kept for a day, then removed', t => {
  const f = runtime(t, 4);
  mkdirSync(join(f.releases, hex(9)));
  const result = pruneReleases(f.dir, hex(4), 2, idle);
  assert.ok(f.exists(9));
  assert.deepEqual(result.skipped, [{ release: hex(9), reason: 'unfinished' }]);
  const old = new Date(Date.now() - 25 * 3600_000);
  utimesSync(join(f.releases, hex(9)), old, old);
  assert.deepEqual(pruneReleases(f.dir, hex(4), 2, idle).removed, [hex(9)]);
});

test('a missing releases directory or unreadable chain removes nothing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(pruneReleases(dir, hex(1), 3, idle).removed, []);
  const f = runtime(t, 3);
  rmSync(join(f.releases, hex(3), 'owner-install-selection.json'));
  rmSync(join(f.dir, 'installed-owner'));
  // No chain from the finished release: only it is known, older ones with selections are ordinary old releases.
  assert.deepEqual(pruneReleases(f.dir, hex(3), 3, idle).kept, [hex(3)]);
});

function journalFor(dir, build) {
  return {
    directory: join(dir, 'releases', hex(1)),
    request: { operationId: hex(1), runtimeDirectory: dir },
    stages: [{ name: 'build', attempts: [{ receipt: { status: 'succeeded', result: { path: build } } }] }],
  };
}

test('a completed release drops netlify plugins, node_modules and .git from its build source', t => {
  const f = runtime(t, 1);
  const build = join(f.releases, hex(1), 'build-a', 'source');
  for (const path of ['.netlify/plugins/node_modules/x', 'node_modules/y', '.git/objects/z'])
    mkdirSync(join(build, path), { recursive: true });
  writeFileSync(join(build, '.netlify', 'state.json'), '{}');
  writeFileSync(join(build, 'package.json'), '{}');
  assert.deepEqual(slimReleaseBuild(journalFor(f.dir, build)), ['node_modules', '.netlify/plugins', '.git']);
  assert.ok(!existsSync(join(build, '.netlify', 'plugins')));
  assert.ok(existsSync(join(build, '.netlify', 'state.json')));
  assert.ok(existsSync(join(build, 'package.json')));
  assert.ok(existsSync(join(f.releases, hex(1), 'install-x', 'node_modules')));
  assert.deepEqual(slimReleaseBuild(journalFor(f.dir, build)), []); // Idempotent.
});

test('slimming only touches a build path inside the release directory', t => {
  const f = runtime(t, 1);
  const outside = join(f.dir, 'elsewhere');
  mkdirSync(join(outside, 'node_modules'), { recursive: true });
  assert.deepEqual(slimReleaseBuild(journalFor(f.dir, outside)), []);
  assert.ok(existsSync(join(outside, 'node_modules')));
});

test('settleRelease slims and prunes together and never throws', t => {
  const f = runtime(t, 5);
  const build = join(f.releases, hex(5), 'build-a', 'source');
  mkdirSync(join(build, 'node_modules'), { recursive: true });
  const journal = journalFor(f.dir, build);
  journal.directory = join(f.releases, hex(5));
  journal.request = { operationId: hex(5), runtimeDirectory: f.dir, retainReleases: 2 };
  const result = settleRelease(journal, idle);
  assert.deepEqual(result.slimmed, ['node_modules']);
  assert.deepEqual(result.removed, [hex(1), hex(2), hex(3)]);
  journal.request.runtimeDirectory = join(f.dir, 'missing');
  assert.deepEqual(settleRelease(journal, idle).removed, []);
});
