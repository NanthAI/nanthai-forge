// SPDX-License-Identifier: Apache-2.0
import type { WorkData } from './work-types.js';
import { indexedRecord, type IndexEntry } from './work-hosted-index.js';
import { viewReadModels } from './view-read-model.js';
import { provenancePlan, type ProvenanceFile } from './view-provenance-plan.js';
/** Built once per publication; reads select a View/file/Lane through indexed keys. */
export function viewIndexEntries(
  data: WorkData,
  states?: ReadonlyMap<string, readonly ProvenanceFile[]>,
  selection?: {
    index: number;
    positions: Map<string, number>;
    cachedProvenance?: { fileCount: number | null; provenanceAvailable: boolean };
  },
) {
  const entries: IndexEntry[] = [],
    fileMaps = new Map<string, Map<string, ProvenanceFile>>(),
    positions = selection?.positions ?? new Map<string, number>();
  const add = (collection: string, key: string, parent: string, value: unknown) => {
    const position = positions.get(collection) ?? 0;
    positions.set(collection, position + 1);
    entries.push(...indexedRecord(collection, key, parent, position, value));
  };
  for (const [offset, model] of viewReadModels(data, selection?.index).entries()) {
    const view = data.views[selection?.index ?? offset]!;
    const files = states ? provenancePlan(data, view, states, fileMaps) : null;
    add('viewDetails', view.id, view.intentId, {
      ...model,
      fileCount: view.status === 'conflict' ? null : (files?.length ?? null),
      provenanceAvailable: view.status !== 'conflict' && files !== null,
      ...selection?.cachedProvenance,
    });
    for (const input of model.inputs) add('laneViews', `${input.laneId}:${view.id}`, input.laneId, model);
    for (const accepted of [...model.accepted].sort((a, b) => a.at.localeCompare(b.at)))
      add('viewAcceptances', accepted.id, view.id, accepted);
    for (const file of files ?? []) add('viewFiles', `${view.id}:${file.path}`, view.id, file);
  }
  return entries;
}
