// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { landingPositions } from './landing-records-index.js';
import type { WorkStore } from './work-store.js';

type StoreAccess = Pick<WorkStore, 'directory' | 'load' | 'readRecords'>;

export function readSemanticConflicts(store: StoreAccess, candidateId: string) {
  const tx = store.readRecords();
  try {
    if (!tx)
      return (store.load().landingEntries ?? [])
        .flatMap(entry => entry.semanticConflicts ?? [])
        .filter(conflict => conflict.candidateId === candidateId);
    const conflicts = [];
    for (const position of landingPositions(store, tx, 'landingEntries', ['conflict']))
      for (const conflict of tx.at('landingEntries', position).semanticConflicts ?? [])
        if (conflict.candidateId === candidateId) conflicts.push(conflict);
    return conflicts;
  } finally {
    tx?.dispose();
  }
}
