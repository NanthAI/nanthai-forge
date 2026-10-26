// SPDX-License-Identifier: Apache-2.0
import { watchLocal } from '../../dist/local-watcher.js';

/** Observe durable fixture state; a watcher hint never drives the worker. */
export function waitForState(store, read, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let watcher,
      deadline,
      fallback,
      scheduled,
      settled = false;
    const close = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(fallback);
      clearImmediate(scheduled);
      void watcher?.close();
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(value);
    };
    const aborted = () => close(signal.reason);
    const check = () => {
      try {
        const value = read();
        if (value) close(undefined, value);
      } catch (error) {
        if (error.code !== 'SOURCE_CHANGED') close(error);
      }
    };
    try {
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      watcher = watchLocal(store.directory, {}, () => {
        if (settled || scheduled) return;
        scheduled = setImmediate(() => {
          scheduled = undefined;
          check();
        });
      });
      // Native hints can miss initial attachment. Preserve a bounded fallback,
      // without decoding complete Work twenty to fifty times per second.
      fallback = setInterval(check, 250);
      deadline = setTimeout(() => {
        check();
        if (!settled)
          close(Object.assign(new Error('Fixture state deadline expired'), { code: 'TEST_STATE_TIMEOUT' }));
      }, timeoutMs);
      check();
    } catch (error) {
      close(error);
    }
  });
}
