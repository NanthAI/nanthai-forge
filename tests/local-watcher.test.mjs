// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fork, execFile } from 'node:child_process';
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let time = Date.now();
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
  t.mock.method(watcherRuntime, 'createWorker', () => {
    const child = fork(fileURLToPath(new URL('./local-watcher-native-fixture.mjs', import.meta.url)), [], {
      execArgv: options.userlandRecursive ? ['--expose-internals'] : [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.received = [];
    child.on('message', message => child.received.push(message));
    child.send(options);
    const unref = child.unref.bind(child),
      ref = child.ref.bind(child);
    const worker = Object.assign(child, {
      unref() {
        child.channel?.unref();
        unref();
      },
      ref() {
        child.channel?.ref();
        ref();
      },
      postMessage(message) {
        if (child.connected) child.send(message, () => {});
      },
      terminate() {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        if (child.connected) child.disconnect();
        return exited;
      },
    });
    workers.push(worker);
    return worker;
  });
  t.after(async () => {
    await Promise.all(workers.map(w => w.terminate()));
    await sleep(0);
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
      worker.off('message', listen);
      resolve(message);
    };
    worker.on('message', listen);
  });
}

test('private probes canonicalize tmp paths, write private files, and remove them on cancellation', async t => {
  const workers = nativeFake(t, { silent: true });
  const watcher = watching(t, { probeMs: 1000 });
  const pending = watcher.probe();
  const { directory } = await messageFrom(workers[0], 'probe-directory');
  await messageFrom(workers[0], 'probe-written');
  assert.equal(directory, realpathSync(directory));
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'signal')).mode & 0o777, 0o600);
  assert.equal(directory.startsWith('/synthetic/watch'), false);
  await watcher.close();
  await pending;
  assert.equal(existsSync(directory), false);
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
  const watcher = watching(t, { probeMs: 500, closeMs: 50 });
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
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let resolveEvent;
    const event = new Promise(resolve => {
      resolveEvent = resolve;
    });
    const watcher = watching(
      t,
      { probeMs: 3000, recursive: true },
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
    assert.equal(existsSync(workers[0].received.find(m => m.type === 'probe-directory').directory), false);
  });

test('20 real subscriptions share a healthy probe and cancelling its first subscriber preserves the others', async t => {
  const workers = nativeFake(t, { real: true });
  const directory = realpathSync(mkdtempSync('/tmp/forge-watcher-many-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const watchers = Array.from({ length: 20 }, (_, i) => {
    const path = join(directory, String(i));
    mkdirSync(path);
    return watching(t, { probeMs: 3000, recursive: true }, () => {}, path);
  });
  const probes = watchers.map(w => w.probe());
  await messageFrom(workers[0], 'probe-directory');
  await watchers[0].close();
  assert.ok((await Promise.all(probes.slice(1))).every(h => h.status === 'healthy'));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].received.filter(m => m.type === 'probe-directory').length, 1);
  await Promise.all(watchers.map(w => w.close()));
});

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
