// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { watchLocal, probeLocalWatching, watcherRuntime } from '../dist/local-watcher.js';
import { startLocalWatcher } from '../dist/local-watcher-worker.js';

// Real mode uses the OS backend; userlandRecursive also exercises Node's
// recursive-watch implementation (and its synchronous close) on macOS.
if (process.connected)
  process.once('message', configuration => {
    if (configuration.userlandRecursive) {
      const require = createRequire(import.meta.url);
      const { FSWatcher } = require('internal/fs/recursive_watch');
      const { kFSWatchStart } = require('internal/fs/watchers');
      const watch = fs.watch;
      fs.watch = (path, options, listener) => {
        if (!options.recursive) return watch(path, options, listener);
        const watcher = new FSWatcher(options);
        watcher[kFSWatchStart](path);
        watcher.on('change', listener);
        return watcher;
      };
      syncBuiltinESMExports();
    }
    if (!configuration.real) {
      fs.watch = (path, _options, listener) => {
        if (configuration.failure)
          throw Object.assign(new Error('synthetic'), { code: configuration.failure });
        const watcher = new EventEmitter();
        watcher.close = () => {
          if (!path.includes('forge-watch-probe-') && configuration.hangClose)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          else if (!configuration.missingClose) queueMicrotask(() => watcher.emit('close'));
        };
        if (path.includes('forge-watch-probe-') && !configuration.silent) {
          // Test-only event substitution observes the actual private signal write.
          const tick = setInterval(() => {
            if (!fs.existsSync(`${path}/signal`)) return;
            clearInterval(tick);
            listener('change', 'signal');
          }, 5);
        }
        return watcher;
      };
      syncBuiltinESMExports();
    }
    startLocalWatcher();
  });
else if (process.argv.includes('--probe') || process.argv.includes('--measure')) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'forge-watch-native-')));
  const workers = [];
  const create = watcherRuntime.createWorker;
  watcherRuntime.createWorker = () => {
    const child = create();
    workers.push(child);
    return child;
  };
  const subscriptions = [];
  try {
    if (process.argv.includes('--probe')) {
      const health = await probeLocalWatching();
      console.log(JSON.stringify({ nativeProbe: health }));
      if (health.status !== 'healthy') process.exitCode = 1;
    } else {
      for (const count of [1, 20]) {
        while (subscriptions.length < count) {
          const path = join(directory, String(subscriptions.length));
          fs.mkdirSync(path);
          subscriptions.push(watchLocal(path, { recursive: true }, () => {}));
        }
        const health = await Promise.all(subscriptions.map(w => w.probe()));
        if (health.some(h => h.status !== 'healthy')) throw new Error(JSON.stringify(health));
        const helpers = workers.filter(w => w.exitCode === null && w.signalCode === null);
        const rows = execFileSync(
          'ps',
          ['-o', 'pid=,rss=', '-p', [process.pid, ...helpers.map(w => w.pid)].join(',')],
          { encoding: 'utf8' },
        )
          .trim()
          .split('\n')
          .map(row => row.trim().split(/\s+/).map(Number));
        console.log(
          JSON.stringify({
            subscriptions: count,
            helpers: helpers.length,
            helperRssKiB: rows.filter(([pid]) => pid !== process.pid).reduce((sum, [, rss]) => sum + rss, 0),
            parentRssKiB: rows.find(([pid]) => pid === process.pid)[1],
          }),
        );
      }
    }
  } finally {
    await Promise.all(subscriptions.map(w => w.close()));
    // Only observe exit here; do not kill a helper to make the assertion pass.
    await Promise.all(
      workers.map(w =>
        w.exitCode !== null || w.signalCode !== null
          ? undefined
          : new Promise((resolve, reject) => {
              const bound = setTimeout(() => reject(new Error('helper did not exit after last close')), 1000);
              w.once('exit', () => {
                clearTimeout(bound);
                resolve();
              });
            }),
      ),
    );
    console.log(
      JSON.stringify({
        helpersAfterClose: workers.filter(w => w.exitCode === null && w.signalCode === null).length,
      }),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
