// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { watchLocal, watcherRuntime } from '../dist/local-watcher.js';
import { startLocalWatcher } from '../dist/local-watcher-worker.js';

function helper(
  t,
  { missingClose = false, holdHealthy = false, holdCleanup = false, failProbeOnce = false } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const messages = [],
    streams = [],
    pending = [],
    cleanup = [];
  let directory,
    removed = false,
    failedProbe = false;
  const before = new Set(process.listeners('exit'));
  const receive = startLocalWatcher(
    (message, done) => {
      messages.push(message);
      if (message.type === 'probe-directory') directory = message.directory;
      if (message.type === 'healthy' && holdHealthy) pending.push(done);
      else done();
    },
    {
      watch(path, _options, listener) {
        if (failProbeOnce && !failedProbe && path.includes('forge-watch-probe-')) {
          failedProbe = true;
          throw Object.assign(new Error('synthetic probe allocation failure'), { code: 'EMFILE' });
        }
        const stream = new EventEmitter();
        stream.path = path;
        stream.event = () => listener('change', 'signal');
        stream.close = () => {
          stream.closed = true;
          if (!missingClose) stream.emit('close');
        };
        streams.push(stream);
        return stream;
      },
      async remove(path, options) {
        if (!failedProbe)
          assert.ok(
            messages.some(m => m.type === 'healthy'),
            'close acknowledgement precedes cleanup',
          );
        if (holdCleanup) await new Promise(resolve => cleanup.push(resolve));
        // Deterministically model cleanup taking longer than the unchanged close deadline.
        t.mock.timers.tick(300);
        removed = true;
        rmSync(path, options);
      },
      setImmediate,
    },
  );
  t.after(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    for (const listener of process.listeners('exit'))
      if (!before.has(listener)) process.off('exit', listener);
  });
  const command = (id, type, extra = {}) =>
    receive({ id, type, path: '/synthetic', recursive: true, probe: 1, ...extra });
  return { command, messages, streams, pending, cleanup, removed: () => removed };
}

test('native close acknowledgement is flushed before slow cleanup can expire the parent close deadline', async t => {
  const h = helper(t, { holdHealthy: true });
  h.command(1, 'open');
  h.command(1, 'probe');
  t.mock.timers.tick(100);
  h.streams[1].event();
  t.mock.timers.tick(0);
  assert.equal(h.streams[1].closed, true);
  assert.deepEqual(
    h.messages.filter(m => m.type === 'healthy').map(m => m.id),
    [1],
  );
  assert.equal(h.removed(), false, 'cleanup waits for transport flush');
  h.pending.shift()();
  await Promise.resolve();
  assert.equal(h.removed(), true);
});

test('late subscribers queue behind failed-probe cleanup and receive a fresh healthy generation', async t => {
  const h = helper(t, { failProbeOnce: true, holdCleanup: true });
  h.command(1, 'open');
  h.command(1, 'probe');
  await Promise.resolve();
  h.command(2, 'open');
  h.command(2, 'probe');
  assert.equal(h.streams.length, 1);
  assert.ok(h.messages.some(m => m.id === 1 && m.type === 'degraded' && m.code === 'EMFILE'));
  h.cleanup.shift()();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(h.streams.length, 2, 'late subscriber receives a newly initialized probe');
  t.mock.timers.tick(100);
  h.streams[1].event();
  t.mock.timers.tick(0);
  assert.deepEqual(
    h.messages.filter(m => m.type === 'healthy').map(m => m.id),
    [2],
  );
  await Promise.resolve();
  h.cleanup.shift()();
  for (let i = 0; i < 4; i++) await Promise.resolve();
});

test('closing the first subscriber preserves the shared probe and acknowledges every remaining generation', t => {
  const h = helper(t);
  for (let id = 1; id <= 20; id++) {
    h.command(id, 'open');
    h.command(id, 'probe', { probe: id });
  }
  h.command(1, 'close');
  assert.equal(h.streams[0].closed, undefined, 'shared target still belongs to remaining subscribers');
  t.mock.timers.tick(100);
  h.streams[1].event();
  t.mock.timers.tick(0);
  assert.deepEqual(
    h.messages.filter(m => m.type === 'healthy').map(m => [m.id, m.probe]),
    Array.from({ length: 19 }, (_, i) => [i + 2, i + 2]),
  );
  assert.equal(h.streams.length, 2, 'one native target and one shared probe');
});

test('missing native close never reports healthy or cleans a live probe', t => {
  const h = helper(t, { missingClose: true });
  h.command(1, 'open');
  h.command(1, 'probe');
  t.mock.timers.tick(100);
  h.streams[1].event();
  t.mock.timers.tick(0);
  assert.equal(h.streams[1].closed, true);
  assert.equal(
    h.messages.some(m => m.type === 'healthy'),
    false,
  );
  assert.equal(h.removed(), false);
});

test('first-subscriber cancellation and slow cleanup cannot degrade remaining healthy parents', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  const transport = new EventEmitter();
  const streams = [],
    messages = [];
  let directory;
  const before = new Set(process.listeners('exit'));
  const receive = startLocalWatcher(
    (message, done) => {
      if (message.type === 'probe-directory') directory = message.directory;
      messages.push(message);
      transport.emit('message', message);
      done();
    },
    {
      watch(_path, _options, listener) {
        const stream = new EventEmitter();
        stream.event = () => listener('change', 'signal');
        stream.close = () => stream.emit('close');
        streams.push(stream);
        return stream;
      },
      async remove(path, options) {
        t.mock.timers.tick(300); // Above production's 250 ms bound and the test's 25 ms.
        rmSync(path, options);
      },
      setImmediate,
    },
  );
  Object.assign(transport, {
    postMessage: receive,
    ref() {},
    unref() {},
    terminate: () => Promise.resolve(),
  });
  t.mock.method(watcherRuntime, 'createWorker', () => transport);
  const watchers = [
    watchLocal('/synthetic/first', { closeMs: 25 }, () => {}),
    watchLocal('/synthetic/one', { closeMs: 25 }, () => {}),
    watchLocal('/synthetic/two', { closeMs: 25 }, () => {}),
  ];
  t.after(async () => {
    await Promise.all(watchers.map(w => w.close()));
    if (directory) rmSync(directory, { recursive: true, force: true });
    for (const listener of process.listeners('exit'))
      if (!before.has(listener)) process.off('exit', listener);
  });
  transport.emit('message', { type: 'ready' });
  const pending = Promise.all(watchers.slice(1).map(w => w.probe()));
  await watchers[0].close();
  t.mock.timers.tick(100);
  streams[1].event();
  t.mock.timers.tick(0);
  assert.deepEqual(await pending, [{ status: 'healthy' }, { status: 'healthy' }]);
  assert.deepEqual(
    messages.filter(m => ['closed', 'probe-event', 'healthy'].includes(m.type)).map(m => m.type),
    ['closed', 'probe-event', 'probe-event', 'healthy', 'healthy'],
  );
});

test('pending private-directory deletion never blocks target close acknowledgements', async t => {
  const h = helper(t, { holdCleanup: true });
  h.command(1, 'open');
  h.command(1, 'probe');
  t.mock.timers.tick(100);
  h.streams[1].event();
  t.mock.timers.tick(0);
  await Promise.resolve();
  assert.equal(h.removed(), false);
  h.command(1, 'close');
  assert.ok(h.messages.some(m => m.id === 1 && m.type === 'closed'));
  assert.equal(h.removed(), false);
  h.cleanup.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.removed(), true);
});
