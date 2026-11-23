// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import childProcess, { execFile } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  watcherRuntime,
  watchLocal,
  localWatchingHealth,
  probeLocalWatching,
} from '../dist/local-watcher.js';
import { WATCH_RETRY_MS } from '../dist/local-watcher-runtime.js';
import { FakeWatchWorker } from './local-watcher-fixture.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let time = Date.now();
const nativeFixture = fileURLToPath(new URL('./local-watcher-native-fixture.mjs', import.meta.url));
function clock(t) {
  time += WATCH_RETRY_MS * 2;
  t.mock.method(watcherRuntime, 'now', () => time);
}
function fake(t, options) {
  clock(t);
  const workers = [];
  t.mock.method(watcherRuntime, 'createWorker', () => {
    const worker = new FakeWatchWorker(options);
    workers.push(worker);
    return worker;
  });
  return workers;
}
function nativeFake(t, options) {
  clock(t);
  const workers = [];
  const fork = childProcess.fork;
  t.mock.method(childProcess, 'fork', (_path, args, settings) => {
    const child = fork(nativeFixture, args, {
      ...settings,
      ...(options.helperTemp && {
        env: {
          ...settings.env,
          TMPDIR: options.helperTemp,
          TMP: options.helperTemp,
          TEMP: options.helperTemp,
        },
      }),
      execArgv: options.userlandRecursive ? ['--expose-internals'] : [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child.received = [];
    const observed = message => {
      child.received.push(message);
      child.emit('fixture-message', message);
    };
    child.on('message', observed);
    let buffer = '';
    child.stderr.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.startsWith('{"type":"probe-directory"')) observed(JSON.parse(line));
      }
    });
    child.send(options);
    workers.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await Promise.all(
      workers.map(async worker => {
        if (worker.exitCode !== null || worker.signalCode !== null) return;
        const exited = once(worker, 'exit');
        worker.kill('SIGKILL');
        await exited;
      }),
    );
  });
  return workers;
}
function watching(t, options = {}, listener = () => {}, path = '/synthetic/watch') {
  const watcher = watchLocal(path, { probeMs: 60, closeMs: 25, ...options }, listener);
  t.after(async () => {
    await watcher.close();
    await sleep(0);
  });
  return watcher;
}

test('20 subscriptions use one helper; events and close acknowledgements route by subscription', async t => {
  const workers = fake(t);
  const events = [];
  const watchers = Array.from({ length: 20 }, (_, i) =>
    watching(t, {}, (event, name) => events.push([i, event, name]), `/synthetic/${i}`),
  );
  assert.equal(workers.length, 1);
  assert.ok((await Promise.all(watchers.map(w => w.probe()))).every(h => h.status === 'healthy'));
  workers[0].event('file', 'rename', '/synthetic/7');
  assert.deepEqual(events, [[7, 'rename', 'file']]);
  await Promise.all(watchers.slice(0, 19).map(w => w.close()));
  assert.equal(workers[0].terminations, 0);
  assert.equal(workers[0].subscriptions.size, 1);
  await watchers[19].close();
  assert.equal(workers[0].terminations, 1, 'last close releases the only helper');
});

test('healthy helpers can restart after last close without a backoff penalty', async t => {
  const workers = fake(t);
  await watching(t).close();
  await sleep(0);
  assert.equal((await watching(t).probe()).status, 'healthy');
  assert.equal(workers.length, 2);
});

test('a new subscription waits for the previous helper to exit before allocating its replacement', async t => {
  const workers = fake(t, { hangTerminate: true });
  const first = watching(t);
  await first.probe();
  await first.close();
  watcherRuntime.createWorker.mock.mockImplementation(() => {
    const worker = new FakeWatchWorker();
    workers.push(worker);
    return worker;
  });
  const second = watching(t);
  const pending = second.probe();
  assert.equal(workers.length, 1);
  workers[0].exit();
  assert.deepEqual(await pending, { status: 'healthy' });
  assert.equal(workers.length, 2);
});

test('a helper that never starts has a distinct bounded startup result', async t => {
  const workers = fake(t, { hangStartup: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watcher = watching(t);
  const pending = watcher.probe();
  t.mock.timers.tick(3000);
  assert.deepEqual(await pending, { status: 'degraded', code: 'WATCH_WORKER_START_TIMEOUT' });
  assert.equal(workers[0].terminations, 1);
  t.mock.timers.reset();
});

test('startup time does not consume the event deadline', async t => {
  fake(t, { startupMs: 120 });
  const watcher = watching(t, { probeMs: 30 });
  assert.deepEqual(await watcher.probe(), { status: 'healthy' });
});

test('hung helper is killed once; all subscriptions degrade and replacement waits for the backoff', async t => {
  const workers = fake(t, { silent: true });
  let events = 0;
  const watchers = Array.from({ length: 20 }, () => watching(t, {}, () => events++));
  assert.ok((await Promise.all(watchers.map(w => w.probe()))).every(h => h.code === 'WATCH_PROBE_TIMEOUT'));
  await sleep(0);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminations, 1);
  time += WATCH_RETRY_MS - 1;
  await Promise.all(watchers.map(w => w.probe()));
  assert.equal(workers.length, 1);
  time++;
  watcherRuntime.createWorker.mock.mockImplementation(() => {
    const worker = new FakeWatchWorker();
    workers.push(worker);
    return worker;
  });
  assert.ok((await Promise.all(watchers.map(w => w.probe()))).every(h => h.status === 'healthy'));
  assert.equal(workers.length, 2);
  workers[0].emit('message', { id: workers[0].messages[0].id, type: 'event', event: 'change', name: 'late' });
});

test('unresolved termination never allocates another process, even after the backoff', async t => {
  const workers = fake(t, { silent: true, hangTerminate: true });
  const watcher = watching(t);
  assert.equal((await watcher.probe()).code, 'WATCH_PROBE_TIMEOUT');
  time += WATCH_RETRY_MS * 2;
  assert.equal((await watcher.probe()).status, 'degraded');
  const another = watching(t);
  assert.equal((await another.probe()).status, 'degraded');
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminations, 1);
  // Release this synthetic process slot after proving the unresolved-exit fence.
  await watcher.close();
  await another.close();
  // Release the synthetic slot only after its subscriptions close.
  workers[0].exit();
  await sleep(0);
});

for (const code of ['EMFILE', 'ENOSPC', 'EPERM'])
  test(`${code} degrades without rejecting, waking a consumer or retrying automatically`, async t => {
    const workers = fake(t, { code });
    let wakes = 0;
    const watcher = watching(t, {}, () => wakes++);
    assert.deepEqual(await watcher.probe(), { status: 'degraded', code });
    assert.equal(wakes, 0);
    assert.deepEqual(localWatchingHealth(), watcher.health);
    assert.deepEqual(await probeLocalWatching(), watcher.health);
    await sleep(20);
    assert.equal(workers.length, 1);
  });

test('a hung close returns in the bound and degrades remaining subscriptions', async t => {
  const workers = fake(t, { hangClose: true });
  const one = watching(t),
    two = watching(t);
  await Promise.all([one.probe(), two.probe()]);
  const before = performance.now();
  await one.close();
  assert.ok(performance.now() - before < 250);
  assert.deepEqual(one.health, { status: 'degraded', code: 'WATCH_CLOSE_TIMEOUT' });
  assert.deepEqual(two.health, one.health);
  assert.equal(workers[0].terminations, 1);
  assert.ok(workers[0].unrefs > 0);
  await one.close();
});

async function messageFrom(worker, type) {
  const received = worker.received.find(m => m.type === type);
  if (received) return received;
  return new Promise((resolve, reject) => {
    const bound = setTimeout(() => reject(new Error(`missing ${type}`)), 1500);
    const listen = message => {
      if (message.type !== type) return;
      clearTimeout(bound);
      worker.off('fixture-message', listen);
      resolve(message);
    };
    worker.on('fixture-message', listen);
  });
}

function whenProbeRootRemoved(t, directory) {
  const rm = fsPromises.rm;
  const { promise, resolve } = Promise.withResolvers();
  t.mock.method(fsPromises, 'rm', async (path, options) => {
    await rm(path, options);
    if (path === directory) resolve();
  });
  syncBuiltinESMExports();
  return promise;
}

test(
  'private probes canonicalize tmp paths, write private files, and remove them on cancellation',
  { timeout: 10_000 },
  async t => {
    const workers = nativeFake(t, { silent: true });
    const watcher = watching(t, { probeMs: 1000 });
    const pending = watcher.probe();
    const { directory } = await messageFrom(workers[0], 'probe-directory');
    await messageFrom(workers[0], 'probe-written');
    assert.equal(directory, realpathSync(directory));
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, 'signal')).mode & 0o777, 0o600);
    assert.equal(directory.startsWith('/synthetic/watch'), false);
    const cleanup = whenProbeRootRemoved(t, dirname(directory));
    await watcher.close();
    await pending;
    await cleanup;
    assert.equal(existsSync(directory), false);
  },
);

for (const shared of [false, true])
  test(
    `SIGKILL immediately after ${shared ? 'shared' : 'private'} probe allocation removes its directory`,
    { timeout: 10_000 },
    async t => {
      const root = temporaryDirectory(t);
      const helperTemp = shared
        ? realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'forge-test-')))
        : undefined;
      if (helperTemp) t.after(() => rmSync(helperTemp, { recursive: true, force: true }));
      const workers = nativeFake(t, { hangAllocation: true, helperTemp });
      if (shared) mkdirSync(join(root, '.forge', 'work'), { recursive: true });
      const watcher = watching(t, { probeMs: 3000 }, () => {}, root);
      const health = watcher.probe();
      await Promise.resolve(); // Shared helpers defer election until after subscription listeners attach.
      // The helper is blocked inside mkdtempSync, before it can return the path or open the probe.
      const { directory } = await messageFrom(workers[0], 'probe-directory');
      assert.equal(existsSync(directory), true);
      const lifetimeDirectory = dirname(directory);
      if (shared) {
        assert.equal(dirname(lifetimeDirectory), helperTemp, 'helper really uses a different temp root');
      }
      const cleanup = whenProbeRootRemoved(t, lifetimeDirectory);
      const exited = once(workers[0], 'exit');
      workers[0].kill('SIGKILL');
      assert.deepEqual(await exited, [null, 'SIGKILL']);
      assert.deepEqual(await health, { status: 'degraded', code: 'WATCH_WORKER_EXITED' });
      await cleanup;
      assert.equal(existsSync(directory), false);
      assert.equal(existsSync(lifetimeDirectory), false, 'the helper lifetime directory is reclaimed');
      assert.equal(existsSync(root), true, 'the watched user directory remains');
    },
  );

test('normal parent exit reclaims an allocated probe even if the helper is wedged', async t => {
  const root = temporaryDirectory(t);
  const watcherModule = new URL('../dist/local-watcher.js', import.meta.url).href;
  const script = `
    import childProcess from 'node:child_process';
    import { writeSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createInterface } from 'node:readline';
    import { watchLocal } from ${JSON.stringify(watcherModule)};
    const fork = childProcess.fork;
    childProcess.fork = (_file, args, settings) => {
      const child = fork(${JSON.stringify(nativeFixture)}, args, {
        ...settings, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      createInterface({ input: child.stderr }).once('line', line => {
        writeSync(1, line);
        process.exit(0);
      });
      child.send({ hangAllocation: true });
      return child;
    };
    syncBuiltinESMExports();
    watchLocal(${JSON.stringify(root)}, {}, () => {});
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5000,
  });
  const { directory, type } = JSON.parse(stdout);
  assert.equal(type, 'probe-directory');
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(dirname(directory)), false);
  assert.equal(existsSync(root), true);
});

test('close cancels an in-flight probe and stale events or probe acknowledgements are ignored', async t => {
  const workers = fake(t, { silent: true });
  let events = 0;
  const watcher = watching(t, { probeMs: 1000 }, () => events++);
  const pending = watcher.probe();
  await sleep(0);
  const probe = workers[0].messages.find(m => m.type === 'probe');
  workers[0].emit('message', { id: probe.id, probe: probe.probe - 1, type: 'healthy' });
  assert.equal(watcher.health.status, 'probing');
  await watcher.close();
  await pending;
  workers[0].emit('message', { id: probe.id, type: 'event', event: 'change', name: 'late' });
  assert.equal(events, 0);
});

test('degraded mode retains no recurring timers, consumer wakes or network calls', async t => {
  const workers = fake(t, { code: 'EMFILE' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    throw new Error('network forbidden');
  });
  const watcher = watching(t, {}, () => calls++);
  await watcher.probe();
  await sleep(100);
  assert.equal(workers.length, 1);
  assert.equal(calls, 0);
  assert.equal(workers[0].messages.filter(m => m.type === 'probe').length, 0);
});

test('a synchronous native close hang is isolated in the shared helper', async t => {
  nativeFake(t, { hangClose: true });
  // Product close bound: under load the probe's close acknowledgement can pass 50 ms.
  const watcher = watching(t, { probeMs: 500, closeMs: 250 });
  assert.deepEqual(await watcher.probe(), { status: 'healthy' });
  await watcher.close();
  assert.deepEqual(watcher.health, { status: 'degraded', code: 'WATCH_CLOSE_TIMEOUT' });
});
for (const options of [{ failure: 'EMFILE' }, { silent: true }, { missingClose: true }])
  test(`native protocol handles ${JSON.stringify(options)}`, async t => {
    nativeFake(t, options);
    const watcher = watching(t, { probeMs: 250 });
    assert.deepEqual(await watcher.probe(), {
      status: 'degraded',
      code: options.failure ?? (options.missingClose ? 'WATCH_PROBE_CLOSE_TIMEOUT' : 'WATCH_PROBE_TIMEOUT'),
    });
  });

for (const userlandRecursive of [false, true])
  test(`real recursive watcher (userland=${userlandRecursive}) delivers events and last close exits helper`, async t => {
    const workers = nativeFake(t, { real: true, userlandRecursive });
    const directory = realpathSync(mkdtempSync('/tmp/forge-watcher-real-'));
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    let resolveEvent;
    const event = new Promise(resolve => {
      resolveEvent = resolve;
    });
    // Product close bound (250 ms): these waits need real timers, and a loaded
    // machine's native close plus acknowledgement exceeds the 25 ms test default.
    const watcher = watching(
      t,
      { probeMs: 3000, closeMs: 250, recursive: true },
      (_event, name) => {
        if (name === 'source.txt') resolveEvent();
      },
      directory,
    );
    assert.deepEqual(await watcher.probe(), { status: 'healthy' });
    writeFileSync(join(directory, 'source.txt'), 'native');
    await Promise.race([
      event,
      sleep(3000).then(() => {
        throw new Error('missing real source event');
      }),
    ]);
    const { directory: probe } = await messageFrom(workers[0], 'probe-directory');
    const cleanup = whenProbeRootRemoved(t, dirname(probe));
    await watcher.close();
    await new Promise((resolve, reject) => {
      if (workers[0].exitCode !== null || workers[0].signalCode !== null) {
        resolve();
        return;
      }
      const bound = setTimeout(() => reject(new Error('helper retained after last close')), 1000);
      workers[0].once('exit', () => {
        clearTimeout(bound);
        resolve();
      });
    });
    await cleanup;
    assert.equal(existsSync(probe), false);
  });

// Sharing and cancellation are the claims here, not deadlines (fake-helper tests cover
// those). Parent timers are held, so a loaded machine's close acknowledgement (68 ms
// seen, 25 ms test bound, 250 ms product bound) cannot degrade the shared helper; a
// lost probe fails on the test timeout. Timers are released before fixture teardown.
test(
  '20 real subscriptions share a healthy probe and cancelling its first subscriber preserves the others',
  { timeout: 10_000 },
  async t => {
    t.after(() => t.mock.timers.reset());
    const workers = nativeFake(t, { real: true });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const directory = realpathSync(mkdtempSync('/tmp/forge-watcher-many-'));
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const watchers = Array.from({ length: 20 }, (_, i) => {
      const path = join(directory, String(i));
      mkdirSync(path);
      return watching(t, { probeMs: 3000, recursive: true }, () => {}, path);
    });
    const probes = watchers.map(w => w.probe());
    await messageFrom(workers[0], 'probe-directory');
    await watchers[0].close();
    assert.deepEqual(await Promise.all(probes.slice(1)), Array(19).fill({ status: 'healthy' }));
    assert.equal(workers.length, 1);
    assert.equal(workers[0].received.filter(m => m.type === 'probe-directory').length, 1);
    await Promise.all(watchers.map(w => w.close()));
  },
);

test('doctor reports finite real native watching as healthy', async t => {
  clock(t);
  assert.deepEqual(await probeLocalWatching(), { status: 'healthy' });
  await sleep(50);
});

test('doctor reports close failure and removes its subscription', async t => {
  fake(t, { hangClose: true });
  assert.deepEqual(await probeLocalWatching(), { status: 'degraded', code: 'WATCH_CLOSE_TIMEOUT' });
  assert.deepEqual(localWatchingHealth(), { status: 'healthy' });
  await sleep(0);
});

test('unrefed watching does not retain the parent or IPC channel', async () => {
  const script = `import {watchLocal} from ${JSON.stringify(new URL('../dist/local-watcher.js', import.meta.url).href)};watchLocal('/synthetic/watch', {}, () => {}).unref();`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 2000,
  });
  assert.equal(result.stderr, '');
});

test('doctor reports unavailable private temporary storage as degraded', async t => {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = '/nonexistent-forge-synthetic-temp/child';
  t.after(() => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  });
  assert.deepEqual(await probeLocalWatching(), { status: 'degraded', code: 'ENOENT' });
});

test('fake missing probe close expires exactly once, degrades peers, and recovers only on a later explicit probe', async t => {
  const workers = fake(t, { missingProbeClose: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const one = watching(t),
    two = watching(t);
  const pending = Promise.all([one.probe(), two.probe()]);
  // Flush startup/open/probe IPC without advancing any deadline.
  for (let i = 0; i < 6; i++) await Promise.resolve();
  t.mock.timers.tick(24);
  assert.equal(one.health.status, 'probing');
  t.mock.timers.tick(1);
  assert.ok((await pending).every(h => h.code === 'WATCH_PROBE_CLOSE_TIMEOUT'));
  await Promise.resolve();
  assert.equal(workers[0].terminations, 1);
  time += WATCH_RETRY_MS;
  watcherRuntime.createWorker.mock.mockImplementation(() => {
    const worker = new FakeWatchWorker();
    workers.push(worker);
    return worker;
  });
  assert.ok((await Promise.all([one.probe(), two.probe()])).every(h => h.status === 'healthy'));
  assert.equal(workers.length, 2);
  t.mock.timers.reset();
});
