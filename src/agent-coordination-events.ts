// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import type { WorkStore } from './work-store.js';
// Same-process delivery complements cross-process filesystem events. No timer or daemon.
const events = new EventEmitter();
events.setMaxListeners(0);
export function publishedOverlap(store: WorkStore) {
  events.emit(store.directory);
}
export function onOverlapPublication(store: WorkStore, listener: () => void) {
  events.on(store.directory, listener);
  return () => {
    events.off(store.directory, listener);
  };
}
