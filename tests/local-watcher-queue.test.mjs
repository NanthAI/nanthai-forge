// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watcherRuntime } from '../dist/local-watcher.js';
import { acquireHeavySlot } from '../dist/heavy-slots.js';
import { withCheckoutWritePass } from '../dist/checkout-materialization.js';
import { waitForCliMeasurement } from '../dist/cli-measurement-hold.js';
import { FakeWatchWorker } from './local-watcher-fixture.mjs';

let time = Date.now();
function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-watch-queue-'));
  const workers = [];
  time += 120000;
  t.mock.method(watcherRuntime, 'now', () => time);
  t.mock.method(watcherRuntime, 'createWorker', () => {
    const worker = new FakeWatchWorker(options);
    workers.push(worker);
    return worker;
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => {
    t.mock.timers.reset();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, workers };
}

test('heavy-slot admission survives a native startup hang using its existing thirty-second fallback', async t => {
  const { directory, workers } = fixture(t, { hangStartup: true });
  const held = join(directory, '1');
  mkdirSync(held);
  writeFileSync(join(held, 'pid'), String(process.pid));
  const pending = acquireHeavySlot(directory, 1);
  t.mock.timers.tick(3000);
  rmSync(held, { recursive: true });
  t.mock.timers.tick(27000);
  assert.equal(await pending, held);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminations, 1);
});

test('a hung native close cannot hold a released heavy slot', async t => {
  const { directory, workers } = fixture(t, { hangClose: true });
  const held = join(directory, '1');
  mkdirSync(held);
  writeFileSync(join(held, 'pid'), String(process.pid));
  const pending = acquireHeavySlot(directory, 1);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  rmSync(held, { recursive: true });
  workers[0].event('1', 'rename', directory);
  assert.equal(await pending, held);
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.equal(workers[0].terminations, 1);
});

test('checkout write admission survives absent native startup with its existing one-second fallback', async t => {
  const { directory, workers } = fixture(t, { hangStartup: true });
  let release;
  const started = Promise.withResolvers();
  const first = withCheckoutWritePass(
    directory,
    () =>
      new Promise(resolve => {
        release = resolve;
        started.resolve();
      }),
    { directory },
  );
  await started.promise;
  const second = withCheckoutWritePass(directory, async () => 'admitted', { directory });
  release();
  await first;
  t.mock.timers.tick(1000);
  assert.equal(await second, 'admitted');
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminations, 1);
});

test('all native source hints keep fs.watch inside the isolated helper', () => {
  const directWatchImport = /import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/;
  for (const file of readdirSync(new URL('../src/', import.meta.url))) {
    if (!file.endsWith('.ts') || file === 'local-watcher-worker.ts') continue;
    assert.equal(
      directWatchImport.test(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')),
      false,
      file,
    );
  }
});

test('a slot released before asynchronous watcher attachment is acquired at ready without waiting thirty seconds', async t => {
  const { directory } = fixture(t, { startupMs: 500 });
  const held = join(directory, '1');
  mkdirSync(held);
  writeFileSync(join(held, 'pid'), String(process.pid));
  let result;
  const pending = acquireHeavySlot(directory, 1).then(value => {
    result = value;
  });
  rmSync(held, { recursive: true }); // No native subscription exists yet; no event can replay.
  t.mock.timers.tick(500);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  try {
    assert.equal(result, held);
  } finally {
    // Drain even a regressed implementation after retaining the assertion failure.
    t.mock.timers.tick(30000);
    await pending;
  }
});

test('measurement hold survives absent watcher startup and resumes after removal without a native event', async t => {
  const { directory, workers } = fixture(t, { hangStartup: true });
  const hold = join(directory, '.freeze');
  writeFileSync(hold, 'measurement');
  const diagnostics = [];
  t.mock.method(process.stderr, 'write', value => {
    diagnostics.push(String(value));
    return true;
  });
  let settled = false;
  const pending = waitForCliMeasurement(directory).then(() => {
    settled = true;
  });
  t.mock.timers.tick(3000);
  await Promise.resolve();
  assert.equal(settled, false, 'an active hold still gates dispatch');
  assert.equal(readFileSync(hold, 'utf8'), 'measurement');
  const status = diagnostics
    .map(value => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .find(value => value?.category === 'ENVIRONMENT');
  assert.equal(status.code, 'WATCH_WORKER_START_TIMEOUT');
  assert.equal(status.next, 'nforge doctor .');
  rmSync(hold);
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(settled, true);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminations, 1);
});

test('measurement hold removal completes before a hung native close and no hold creates no watcher', async t => {
  const { directory, workers } = fixture(t, { hangClose: true });
  t.mock.method(process.stderr, 'write', () => true);
  await waitForCliMeasurement(directory);
  assert.equal(workers.length, 0);
  const hold = join(directory, '.freeze');
  writeFileSync(hold, 'measurement');
  const pending = waitForCliMeasurement(directory);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  rmSync(hold);
  workers[0].event('.freeze', 'rename', directory);
  await pending;
  t.mock.timers.tick(250);
  await Promise.resolve();
  assert.equal(workers[0].terminations, 1);
});
