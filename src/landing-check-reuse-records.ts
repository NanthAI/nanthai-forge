// SPDX-License-Identifier: Apache-2.0
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { readFragment } from './work-records.js';
import { assertLandingWorkerActive } from './landing-worker-context.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';

type Index = { pages: string; keys: Map<string, string | undefined>; positions: Map<string, number[]> };
const indexes = new WeakMap<WorkStore, Index>();
/** Passed status and reuse keys locate candidates; fully validate only matches.
 * A changed active run cannot force rehydration of retained passed histories. */
export async function passedReuseCandidates(store: WorkStore, key: string) {
  const tx = store.readRecords();
  if (!tx) return store.load().runs.filter(run => run.status === 'passed' && run.reuseKey === key);
  try {
    const pages = JSON.stringify(tx.manifest.collections.runs?.pages ?? []),
      previous = indexes.get(store);
    let index = previous;
    if (!index || index.pages !== pages) {
      const keys = new Map<string, string | undefined>(),
        positions = new Map<string, number[]>();
      let turn = performance.now();
      for (const position of tx.positions('runs', 'passed', 'status')) {
        const hash = tx.versionAt('runs', position);
        let reuseKey = previous?.keys.get(hash);
        if (!previous?.keys.has(hash)) {
          const fields = readFragment(store.directory, hash).fields;
          invariant(
            fields.status === 'passed',
            'INVALID_WORK_STORE',
            'Passed-run lookup differs from its record.',
          );
          reuseKey = typeof fields.reuseKey === 'string' ? fields.reuseKey : undefined;
        }
        keys.set(hash, reuseKey);
        if (reuseKey) {
          const found = positions.get(reuseKey) ?? [];
          found.push(position);
          positions.set(reuseKey, found);
        }
        if (performance.now() - turn >= 8) {
          await yieldTurn();
          assertLandingWorkerActive();
          turn = performance.now();
        }
      }
      indexes.set(store, (index = { pages, keys, positions }));
    }
    return (index.positions.get(key) ?? []).map(position => {
      const run = tx.at('runs', position);
      invariant(
        run.status === 'passed' && run.reuseKey === key,
        'INVALID_WORK_STORE',
        'Reuse lookup differs from its selected record.',
      );
      return run;
    });
  } finally {
    tx.dispose();
  }
}
