// SPDX-License-Identifier: Apache-2.0
'use node';
import { selectedTreeHeads } from '../src/owner-derived';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { materializeWork, type IndexEntry } from '../src/work-hosted-index';
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
  positions: Record<string, number>;
  stopParents: string[];
  trees?: string[];
  readBytes: number;
  payloadReplacements: number;
  partial?: boolean;
};
const identity = (row: { collection: string; key: string }) => JSON.stringify([row.collection, row.key]);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const derivedCollections = ['viewDetails', 'viewFiles', 'laneViews', 'viewAcceptances'];
/** Metadata must still be validated in full; source derivation follows only changed pins. */
export function prepareDelta(
  previous: Snapshot,
  next: Snapshot,
  generation: Doc<'projectWorkGenerations'>,
  partial = false,
) {
  const before = materializeWork(previous.data, previous.manifest, [], 'objects', new Map(), true);
  const after = materializeWork(next.data, next.manifest, [], 'objects', new Map(), true);
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
  const counts = JSON.parse(generation.metadata).counts as Record<string, number>;
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
      name === 'diffstats' ||
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
        .concat(removedLanes),
      views,
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
export async function cachedParents(
  ctx: ActionCtx,
  snapshot: Snapshot,
  owner: string,
  generationId: Doc<'projectWorkGenerations'>['_id'],
  heads: string[],
) {
  const parents: [string, string[]][] = [];
  for (let i = 0; i < heads.length; i += 100) {
    const rows = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
      projectId: snapshot.backup.projectId,
      owner,
      generationId,
      keys: heads.slice(i, i + 100).map(key => ({ collection: 'sourceStateParents', key })),
    });
    for (const row of rows)
      if (row) {
        const value = JSON.parse(row.value);
        if (value.parents) parents.push([row.key, value.parents]);
        else {
          const all: string[] = [];
          let complete = true;
          for (let offset = 0; offset < value.chunks; offset += 100) {
            const chunks = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
              projectId: snapshot.backup.projectId,
              owner,
              generationId,
              keys: Array.from({ length: Math.min(100, value.chunks - offset) }, (_, i) => ({
                collection: 'sourceStateParentChunks',
                key: `${row.key}:${offset + i}`,
              })),
            });
            for (const chunk of chunks)
              if (chunk) all.push(...JSON.parse(chunk.value).parents);
              else complete = false;
          }
          if (complete) parents.push([row.key, all]);
        }
      }
  }
  return parents;
}
/** Complete immutable closures avoid a quadratic table of individual pairs.
 * Each chunk is below 70 KiB, independently of retained history size. */
export function ancestryEntries(head: string, parents: ReadonlyMap<string, readonly string[]>): IndexEntry[] {
  const pending = [head],
    seen = new Set<string>();
  let complete = true;
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const list = parents.get(next);
    if (list) pending.push(...list);
    else complete = false;
  }
  const ancestors = [...seen],
    chunks = Math.ceil(ancestors.length / 1000);
  return [
    {
      collection: 'sourceAncestryClosure',
      key: head,
      parent: '',
      position: 0,
      value: JSON.stringify({ head, chunks, complete }),
    },
    ...Array.from({ length: chunks }, (_, i) => ({
      collection: 'sourceAncestryChunk',
      key: `${head}:${i}`,
      parent: head,
      position: i,
      value: JSON.stringify({
        ancestors: ancestors.slice(i * 1000, (i + 1) * 1000),
        boundaries: ancestors.slice(i * 1000, (i + 1) * 1000).filter(head => !parents.has(head)),
      }),
    })),
  ];
}
export const deltaFits = (delta: Delta, finalBytes = 0) =>
  delta.entries.length + delta.removed.length <= 5000 &&
  delta.payloadReplacements <= 100 &&
  Buffer.byteLength(JSON.stringify(delta)) < 7 * 1024 * 1024 &&
  Buffer.byteLength(JSON.stringify(delta)) + delta.readBytes + finalBytes < 10 * 1024 * 1024;
