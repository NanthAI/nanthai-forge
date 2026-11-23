// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { watchLocal } from './local-watcher.js';

/** A directory watch plus a deadline, with a read after registration to close the race. */
export function waitForSubmitter(
  done: string,
  hold: string | null,
  ensureSubmitter: () => void,
  budgetMs: number,
): Promise<'SIGINT' | 'SIGTERM' | undefined> {
  if (!budgetMs || existsSync(done)) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (signal?: 'SIGINT' | 'SIGTERM', error?: unknown) => {
      if (finished) return;
      finished = true;
      void watcher.close();
      void holdWatcher?.close();
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', stop);
      if (error) reject(error);
      else resolve(signal);
    };
    const check = () => {
      if (existsSync(done)) finish();
    };
    const interrupt = () => finish('SIGINT');
    const stop = () => finish('SIGTERM');
    const rejoin = () => {
      if (finished) return;
      try {
        ensureSubmitter();
      } catch (error) {
        finish(undefined, error);
      }
    };
    const watcher = watchLocal(dirname(done), { onReady: () => queueMicrotask(check) }, check);
    const holdWatcher = hold
      ? watchLocal(dirname(hold), { onReady: () => queueMicrotask(rejoin) }, (_event, name) => {
          if (name === basename(hold) || name === null) rejoin();
        })
      : undefined;
    const timer = setTimeout(() => {
      rejoin();
      finish();
    }, budgetMs);
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', stop);
    check();
  });
}
