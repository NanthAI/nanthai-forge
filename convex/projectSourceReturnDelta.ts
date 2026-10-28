// SPDX-License-Identifier: Apache-2.0
'use node';
import { digest } from '../src/portable-hash';
import { selectedTreeHeads } from '../src/owner-derived';
import type { Doc } from './_generated/dataModel';
import {
  materializeWork,
  indexedRecord,
  type IndexEntry,
  type IndexMetadata,
} from '../src/work-hosted-index';
import { viewReadModels, viewContributors } from '../src/view-read-model';
import type { WorkData } from '../src/work-types';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import type { z } from 'zod';
export { stateParentEntries } from '../src/source-state-parent-index';
export type Snapshot = {
  data: WorkData;
  manifest: z.infer<typeof sourceManifestSchema>;
  backup: Doc<'projectBackups'>;
};
export type Delta = {
  entries: IndexEntry[];
  removed: { collection: string; key: string }[];
  views: number[];
  summaries: number[];
  newViews?: string[];
  unchangedViewFiles?: string[];
  positions: Record<string, number>;
  stopParents: string[];
  trees?: string[];
  readBytes: number;
  payloadReplacements: number;
  partial?: boolean;
  outputRefs?: import('./projectSourceReturnMetadata').MetadataRef[];
  staged?: boolean;
};
const identity = (row: { collection: string; key: string }) => JSON.stringify([row.collection, row.key]);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const derivedCollections = ['viewDetails', 'viewFiles', 'laneViews', 'viewAcceptances'];
/** Plan metadata replacements; all byte-derived display rows come from the owner. */
export function prepareDelta(
  previous: Snapshot,
  next: Snapshot,
  generation: Doc<'projectWorkGenerations'>,
  partial = false,
) {
  const before = materializeWork(
    previous.data,
    previous.manifest,
    [],
    previous.backup.transport,
    new Map(),
    true,
    false,
    true,
  );
  const after = materializeWork(
    next.data,
    next.manifest,
    [],
    next.backup.transport,
    new Map(),
    true,
    false,
    true,
  );
  const old = new Map(before.entries.map(row => [identity(row), row]));
  const entries: IndexEntry[] = [];
  for (const row of after.entries) {
    const key = identity(row),
      prior = old.get(key);
    old.delete(key);
    const normalize = (entry: IndexEntry | undefined) => {
      if (!entry) return entry;
      if (['lanes', 'views', 'runs'].includes(entry.collection)) {
        const value = JSON.parse(entry.value);
        delete value.main;
        return { ...entry, value: JSON.stringify(value) };
      }
      return entry;
    };
    const immutable = row.collection === 'sourceBlobs' || row.collection === 'sourcePins';
    if (
      !equal(
        normalize(prior && immutable ? { ...prior, position: 0 } : prior),
        normalize(immutable ? { ...row, position: 0 } : row),
      )
    )
      entries.push(row);
  }
  // Source descriptors already carry immutable identity; avoid materializing
  // both complete blob indexes merely to discover their small difference.
  const oldBlobs = new Map(
    previous.manifest.files
      .filter(file => /^objects\/[a-f0-9]{64}$/.test(file.path))
      .map(file => [file.sha256, file]),
  );
  let position = 0;
  for (const file of next.manifest.files)
    if (/^objects\/[a-f0-9]{64}$/.test(file.path)) {
      const prior = oldBlobs.get(file.sha256);
      oldBlobs.delete(file.sha256);
      if (!prior || prior.size !== file.size)
        entries.push(
          ...indexedRecord('sourceBlobs', file.sha256, '', position, {
            sha256: file.sha256,
            size: file.size,
          }),
        );
      position++;
    }
  const removedBlobs = [...oldBlobs.keys()].map(key => ({ collection: 'sourceBlobs', key }));
  const oldModels = new Map(viewReadModels(previous.data).map(model => [model.viewId, model]));
  const oldViews = new Map(previous.data.views.map(view => [view.id, view]));
  const fingerprint = (data: WorkData, view: WorkData['views'][number]) => [
    view,
    viewContributors(data, view).map(c => ({
      ...c,
      outcome: data.intents.find(i => i.id === data.lanes.find(l => l.id === c.laneId)?.intentId)?.outcome,
    })),
  ];
  const views: number[] = [],
    summaries: number[] = [];
  viewReadModels(next.data).forEach((model, index) => {
    const view = next.data.views[index]!,
      prior = oldViews.get(view.id);
    if (!prior || !equal(fingerprint(previous.data, prior), fingerprint(next.data, view))) views.push(index);
    else if (!equal(oldModels.get(model.viewId), model)) summaries.push(index);
  });
  // Immutable source caches survive returns. Counts for mutable derived summaries
  // are adjusted from actual selected rows when their replacements are staged.
  const removedLanes: { collection: string; key: string }[] = [];
  const newModels = new Map(viewReadModels(next.data).map(m => [m.viewId, m]));
  for (const [id, model] of oldModels)
    for (const lane of model.inputs)
      if (!newModels.get(id)?.inputs.some(i => i.laneId === lane.laneId))
        removedLanes.push({ collection: 'laneViews', key: `${lane.laneId}:${id}` });
  const currentMetadata = JSON.parse(generation.metadata) as IndexMetadata;
  const counts = currentMetadata.counts;
  if (partial) {
    // Unrelated source returns leave the shared workspace's decision cache valid.
    const beforeRecords = JSON.stringify(previous.data.decisions ?? []);
    const afterRecords = JSON.stringify(next.data.decisions ?? []);
    if (beforeRecords !== afterRecords)
      after.metadata.decisionVersion = digest(
        JSON.stringify([currentMetadata.decisionVersion, beforeRecords, afterRecords]),
      );
    else if (currentMetadata.decisionVersion)
      after.metadata.decisionVersion = currentMetadata.decisionVersion;
    else delete after.metadata.decisionVersion;
  }
  if (partial)
    for (const name of new Set([...Object.keys(counts), ...Object.keys(after.metadata.counts)])) {
      after.metadata.counts[name] =
        name === 'sourcePins'
          ? (counts[name] ?? 0)
          : (counts[name] ?? 0) + (after.metadata.counts[name] ?? 0) - (before.metadata.counts[name] ?? 0);
    }
  for (const [name, count] of Object.entries(counts))
    if (
      name.startsWith('sourceAncestry') ||
      name.startsWith('sourceStateParent') ||
      name.startsWith('sourceTree') ||
      name === 'diffstats' ||
      name.endsWith(':payload') ||
      derivedCollections.includes(name)
    )
      after.metadata.counts[name] = count;
  after.metadata.counts.laneViews = (after.metadata.counts.laneViews ?? 0) - removedLanes.length;
  return {
    delta: {
      entries: [],
      removed: [...old.values()]
        .filter(row => !partial || row.collection !== 'sourcePins')
        .map(({ collection, key }) => ({ collection, key }))
        .concat(removedLanes, removedBlobs),
      views,
      newViews: views.filter(i => !oldViews.has(next.data.views[i]!.id)).map(i => next.data.views[i]!.id),
      // File keys depend on immutable base/head trees and conflict status, not
      // contributor labels or queue metadata that can change their payloads.
      unchangedViewFiles: next.data.views
        .filter(view => {
          const prior = oldViews.get(view.id);
          return (
            prior &&
            prior.base === view.base &&
            prior.head === view.head &&
            (prior.status === 'conflict') === (view.status === 'conflict')
          );
        })
        .map(view => view.id),
      summaries,
      positions: { ...counts },
      stopParents: [],
      trees: selectedTreeHeads(next.data).filter(head => !selectedTreeHeads(previous.data).includes(head)),
      readBytes: [...old.values()].reduce(
        (sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 2048,
        0,
      ),
      payloadReplacements: 0,
      ...(partial ? { partial: true } : {}),
    } satisfies Delta,
    entries,
    metadata: after.metadata,
  };
}
export const deltaFits = (delta: Delta, finalBytes = 0) =>
  delta.entries.length + delta.removed.length <= 5000 &&
  delta.payloadReplacements <= 100 &&
  Buffer.byteLength(JSON.stringify(delta)) < 7 * 1024 * 1024 &&
  Buffer.byteLength(JSON.stringify(delta)) + delta.readBytes + finalBytes < 10 * 1024 * 1024;
