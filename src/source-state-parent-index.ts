// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { IndexEntry } from './work-hosted-index.js';
/** Share exact parent cache rows across complete, streamed and incremental projections. */
export function stateParentEntries(head: string, parents: readonly string[]): IndexEntry[] {
  const chunks = Math.ceil(parents.length / 1000);
  return [
    {
      collection: 'sourceStateParents',
      key: head,
      parent: '',
      position: 0,
      value: JSON.stringify(parents.length <= 1000 ? { parents } : { chunks }),
    },
    ...(parents.length <= 1000
      ? []
      : Array.from({ length: chunks }, (_, i) => ({
          collection: 'sourceStateParentChunks',
          key: `${head}:${i}`,
          parent: head,
          position: i,
          value: JSON.stringify({ parents: parents.slice(i * 1000, (i + 1) * 1000) }),
        }))),
  ];
}
