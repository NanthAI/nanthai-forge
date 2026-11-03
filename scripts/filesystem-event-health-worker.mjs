// SPDX-License-Identifier: Apache-2.0
import { watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FILESYSTEM_EVENT_DEADLINE_MS } from './filesystem-event-health.mjs';

/** Measure from the write, excluding native stream arming. Injectable for deterministic tests. */
export function watchAttempt(
  directory,
  {
    open = watch,
    write = writeFileSync,
    now = () => performance.now(),
    later = setTimeout,
    cancel = clearTimeout,
  } = {},
) {
  return new Promise(resolve => {
    let watcher,
      timer,
      armTimer,
      started,
      settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      cancel(timer);
      cancel(armTimer);
      // Resolve before native close; the parent's deadline also bounds a wedged close.
      resolve(result);
      watcher?.close();
    };
    try {
      watcher = open(directory, { persistent: false }, (_event, name) => {
        if (started === undefined || (name != null && String(name) !== 'signal')) return;
        const latencyMs = now() - started;
        finish({
          latencyMs,
          reason: latencyMs > FILESYSTEM_EVENT_DEADLINE_MS ? 'late filesystem event' : null,
        });
      });
      watcher.on('error', error =>
        finish({ latencyMs: null, reason: `fs.watch failed (${error.code ?? 'unknown'})` }),
      );
      // FSEvents streams arm asynchronously; Linux inotify needs no recursive subscription.
      armTimer = later(() => {
        started = now();
        timer = later(
          () => finish({ latencyMs: null, reason: 'no filesystem event within 1000 ms' }),
          FILESYSTEM_EVENT_DEADLINE_MS,
        );
        try {
          write(join(directory, 'signal'), 'probe');
        } catch (error) {
          finish({ latencyMs: null, reason: `probe write failed (${error.code ?? 'unknown'})` });
        }
      }, 100);
    } catch (error) {
      finish({ latencyMs: null, reason: `fs.watch failed (${error.code ?? 'unknown'})` });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(await watchAttempt(process.argv[2])));
}
