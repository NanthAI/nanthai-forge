// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filesystemDiagnosticDirectory,
  FILESYSTEM_EVENT_DEADLINE_MS,
  FILESYSTEM_EVENT_CLOSE_DEADLINE_MS,
  probeFilesystemEvents,
  filesystemEventAttempt,
  filesystemEventRefusal,
  fseventsdStats,
} from '../scripts/filesystem-event-health.mjs';
import { nativePaths } from '../dist/source-paths.js';
import { watchAttempt } from '../scripts/filesystem-event-health-worker.mjs';

const noStats = async () => ({ fseventsdRssMb: null, fseventsdCpuPercent: null });
const event = latencyMs => ({ latencyMs, reason: null });

test('health uses two of three 1000 ms deadlines, tolerating one transient failure', async () => {
  assert.equal(FILESYSTEM_EVENT_DEADLINE_MS, 1000);
  for (const [latencies, ok] of [
    [[10, 213, 20], true],
    [[null, 10, 20], true],
    [[1000, 1000, null], true],
    [[null, null, 10], false],
    [[1001, 1200, 10], false],
    [[null, null, null], false],
  ]) {
    let calls = 0;
    const result = await probeFilesystemEvents('/target-volume', {
      attempt: async target => {
        assert.equal(target, '/target-volume');
        return event(latencies[calls++]);
      },
      stats: noStats,
    });
    assert.equal(calls, 3);
    assert.equal(result.ok, ok, JSON.stringify(latencies));
    assert.equal(result.attempts.length, 3);
    assert.equal(result.fseventsdRssMb, null);
    if (!ok) assert.match(result.reason, /[23]\/3 attempts.*1000 ms/);
    else assert.equal(result.reason, null);
  }
});

test('attempt errors count as environment failures, even when an event latency exists', async () => {
  let calls = 0;
  const result = await probeFilesystemEvents('.', {
    attempt: async () => {
      if (++calls === 1) throw Object.assign(Error(), { code: 'EMFILE' });
      return { latencyMs: 15, reason: 'watcher close failed' };
    },
    stats: noStats,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /EMFILE/);
  assert.match(
    filesystemEventRefusal(result, 'darwin'),
    /ENVIRONMENT FILESYSTEM_EVENTS_UNHEALTHY.*fseventsd.*sudo killall fseventsd.*rerun/,
  );
  assert.match(filesystemEventRefusal(result, 'linux'), /local filesystem watcher resources/);
  assert.equal(filesystemEventRefusal({ ok: true }), null);
});

/** Virtual time proves timer/event behavior without depending on the host's watcher health. */
function simulatedWatch({
  latency,
  error,
  writeError,
  closeLatency = 0,
  missingClose = false,
  closeError,
  requireCloseAck = false,
} = {}) {
  let clock = 0,
    callback,
    closed = 0,
    next = 0;
  const timers = new Map();
  const later = (fn, delay) => {
    const id = ++next;
    timers.set(id, { fn, at: clock + delay });
    return id;
  };
  const watcher = new EventEmitter();
  watcher.close = () => {
    closed++;
    if (closeError) throw Object.assign(Error(), { code: closeError });
    clock += closeLatency;
    if (!missingClose) watcher.emit('close');
  };
  const promise = watchAttempt('/synthetic', {
    requireCloseAck,
    now: () => clock,
    later,
    cancel: id => timers.delete(id),
    open: (_directory, _options, cb) => {
      if (error) throw Object.assign(Error(), { code: error });
      callback = cb;
      return watcher;
    },
    write: file => {
      assert.equal(file, '/synthetic/signal');
      if (writeError) throw Object.assign(Error(), { code: writeError });
      // Unrelated/pre-write events cannot satisfy the diagnostic.
      callback('rename', 'unrelated');
      if (latency !== undefined) {
        clock += latency;
        callback('rename', 'signal');
      }
    },
  });
  while (timers.size) {
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    clock = timer.at;
    timer.fn();
  }
  return { promise, closed: () => closed, timers };
}

test('native attempt: healthy, late, no event, allocation and write failures clean up', async () => {
  for (const [options, expected] of [
    [{ latency: 10 }, event(10)],
    [{ latency: 1001 }, { latencyMs: 1001, reason: 'late filesystem event' }],
    [{}, { latencyMs: null, reason: 'no filesystem event within 1000 ms' }],
    [{ error: 'EMFILE' }, { latencyMs: null, reason: 'fs.watch failed (EMFILE)' }],
    [{ writeError: 'EACCES' }, { latencyMs: null, reason: 'probe write failed (EACCES)' }],
  ]) {
    const simulation = simulatedWatch(options);
    assert.deepEqual(await simulation.promise, expected);
    assert.equal(simulation.closed(), options.error ? 0 : 1);
    assert.equal(simulation.timers.size, 0);
  }
});

test('worker deadlines kill native hangs and clean the private directory on the target volume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-event-health-test-'));
  try {
    const result = await filesystemEventAttempt(root, {
      execute: async (executable, args, options) => {
        assert.equal(executable, process.execPath);
        assert.match(
          args[1],
          new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.forge-event-probe-`),
        );
        assert.equal(options.timeout, 2000);
        assert.equal(options.killSignal, 'SIGKILL');
        assert.equal(options.env.NODE_OPTIONS, undefined);
        throw Object.assign(Error(), { killed: true });
      },
    });
    assert.deepEqual(result, { latencyMs: null, reason: 'watcher process timed out' });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('macOS process metrics use only rss/cpu/command, Linux and unavailable ps return null', async () => {
  let calls = 0;
  const execute = async (command, args) => {
    calls++;
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-axo', 'rss=,pcpu=,comm=']);
    return {
      stdout:
        ' 2048 66.5 /System/Library/Frameworks/fseventsd\n1024 1.0 fseventsd\n8192 2.0 another-process\n',
    };
  };
  assert.deepEqual(await fseventsdStats({ platform: 'darwin', execute }), {
    fseventsdRssMb: 3,
    fseventsdCpuPercent: 67.5,
  });
  assert.deepEqual(await fseventsdStats({ platform: 'linux', execute }), await noStats());
  assert.equal(calls, 1);
  assert.deepEqual(
    await fseventsdStats({
      platform: 'darwin',
      execute: async () => {
        throw Error();
      },
    }),
    await noStats(),
  );
});

test('slow, missing and failed native close acknowledgements are environment failures despite prompt events', async () => {
  assert.equal(FILESYSTEM_EVENT_CLOSE_DEADLINE_MS, 250);
  for (const [options, reason] of [
    [{ closeLatency: 251 }, 'late watcher close'],
    [{ missingClose: true }, 'watcher close did not acknowledge within 250 ms'],
    [{ closeError: 'EIO' }, 'watcher close failed (EIO)'],
  ]) {
    const simulation = simulatedWatch({ latency: 10, requireCloseAck: true, ...options });
    const result = await simulation.promise;
    assert.deepEqual(result, { latencyMs: 10, reason });
    assert.equal(simulation.timers.size, 0);
    const health = await probeFilesystemEvents('/synthetic', { attempt: async () => result, stats: noStats });
    assert.equal(health.ok, false);
    assert.equal(health.attempts.length, 3);
  }
  assert.deepEqual(
    await simulatedWatch({ latency: 10, closeLatency: 250, requireCloseAck: true }).promise,
    event(10),
  );
});

test('benchmark delivery policy remains unchanged; ordinary diagnostics explicitly request close health', async () => {
  for (const requireCloseAck of [undefined, false, true]) {
    const extended = requireCloseAck === true;
    const optionsSeen = [];
    const health = await probeFilesystemEvents('/synthetic', {
      requireCloseAck,
      attempt: async (_target, options) => {
        optionsSeen.push(options.requireCloseAck);
        return simulatedWatch({ latency: 10, closeLatency: 500, requireCloseAck: options.requireCloseAck })
          .promise;
      },
      stats: noStats,
    });
    assert.deepEqual(optionsSeen, [extended, extended, extended]);
    assert.equal(health.ok, !extended);
  }
});

test('native attempt forwards the optional close-health mode to the isolated child only when requested', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-event-health-mode-'));
  try {
    for (const requireCloseAck of [false, true]) {
      await filesystemEventAttempt(root, {
        requireCloseAck,
        execute: async (_executable, args, options) => {
          assert.equal(args.includes('--watcher-close-health'), requireCloseAck);
          assert.equal(options.timeout, 2000);
          return { stdout: JSON.stringify(event(10)) };
        },
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary diagnostic pulses remain outside source capture on the target volume', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-private-event-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;');
  const directory = await filesystemDiagnosticDirectory(root);
  assert.equal(directory, join(root, '.forge'));
  const health = await probeFilesystemEvents(directory, {
    stats: noStats,
    attempt: async target => {
      const pulse = join(target, 'in-flight-pulse');
      mkdirSync(pulse);
      writeFileSync(join(pulse, 'signal'), 'probe');
      assert.deepEqual(nativePaths(root), ['source.ts']);
      rmSync(pulse, { recursive: true });
      return event(10);
    },
  });
  assert.equal(health.ok, true);
  assert.deepEqual(readdirSync(directory), []);
});

test('ordinary diagnostic never follows a metadata symlink to another directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-private-event-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, '.forge'));
  await assert.rejects(filesystemDiagnosticDirectory(root), { code: 'UNSAFE_PATH' });
  assert.deepEqual(readdirSync(outside), []);
});
