// SPDX-License-Identifier: Apache-2.0
import { drainLandingBatches } from './landing-batch.js';
import type { WorkService } from './work.js';
import { waitingFinishes } from './agent-finish-journal.js';
import type { WorkStore } from './work-store.js';
/** One finite sweep, draining chains made ready by earlier landings in this sweep. */
export async function landReady(
  store: WorkStore,
  dispatch: (command: unknown) => Promise<{ result: unknown }>,
  work?: WorkService,
) {
  if (work) {
    const entries = store.load().landingEntries ?? [];
    for (const channel of new Set(
      entries.filter(entry => ['queued', 'checking'].includes(entry.status)).map(entry => entry.channel),
    ))
      await drainLandingBatches(work, channel);
  }
  let pending = waitingFinishes(store);
  const results = new Map<string, Record<string, unknown>>();
  for (let pass = 0, bound = pending.length; pending.length && pass <= bound; pass++) {
    const waiting: typeof pending = [];
    let progressed = false;
    for (const command of pending) {
      const result = (await dispatch(command)).result as Record<string, unknown>;
      results.set(command.operationId as string, result);
      if (result.status === 'waiting-for-dependency') waiting.push(command);
      if (result.status === 'accepted') progressed = true;
    }
    if (!progressed) break;
    pending = waiting;
  }
  return { revision: store.revision(), result: { finishes: [...results.values()] } };
}
