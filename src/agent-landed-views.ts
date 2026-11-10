// SPDX-License-Identifier: Apache-2.0
import { allRecords } from './agent-lifecycle.js';
import type { LandingEntry } from './landing-batch-types.js';
import type { WorkStore } from './work-store.js';

export function noopLandingViews(store: WorkStore, channel: string) {
  const records = store.readRecords();
  const entries = records
    ? records.manifest.collections.landingEntries
      ? allRecords<LandingEntry>(store, 'landingEntries')
      : []
    : (store.load().landingEntries ?? []);
  return entries.flatMap(entry => {
    if (entry.channel !== channel || entry.status !== 'accepted' || !entry.alreadyOnMain) return [];
    const view = store.select('views', entry.viewId);
    return view?.status === 'clean' && view.head === entry.head ? [{ view, main: entry.alreadyOnMain }] : [];
  });
}
