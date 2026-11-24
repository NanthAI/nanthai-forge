// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { WorkData } from './work-types.js';
import { indexedRecord, type IndexEntry } from './work-hosted-index.js';
import { viewReadModels } from './view-read-model.js';
/** View collections with no reader, still sent by older CLIs and still in old caches. The server
 * and the CLI cache drop them. Remove by 2026-12-31 with the minimum-CLI bump (Item c0af6cfa F13). */
export const isLegacyViewCollection = (collection: string) =>
  /^(viewDetails|viewFiles|laneViews)(:payload)?$/.test(collection);
/** Built once per publication. Only View acceptances are indexed (projectWorkIndexSummary reads
 * them); legacy View detail, Lane-View and file-provenance rows had no reader (Item c0af6cfa F1). */
export function viewIndexEntries(
  data: WorkData,
  selection?: { index: number; positions: Map<string, number> },
) {
  const entries: IndexEntry[] = [],
    positions = selection?.positions ?? new Map<string, number>();
  for (const [offset, model] of viewReadModels(data, selection?.index).entries()) {
    const view = data.views[selection?.index ?? offset]!;
    for (const accepted of [...model.accepted].sort((a, b) => a.at.localeCompare(b.at))) {
      const position = positions.get('viewAcceptances') ?? 0;
      positions.set('viewAcceptances', position + 1);
      entries.push(...indexedRecord('viewAcceptances', accepted.id, view.id, position, accepted));
    }
  }
  return entries;
}
