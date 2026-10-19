// SPDX-License-Identifier: Apache-2.0
'use node';
import { archiveChannels } from '../src/work-archive-metadata';
import { sourceTreeEntries } from '../src/source-tree-index';
import { exchangeObjectReader } from './projectExchangeReader';
import { parseNativeState } from '../src/native-source';
import { addDiffstats } from './projectDiffstatProjection';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { WorkData } from '../src/work-types';
import type { z } from 'zod';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import { sourceParents } from './projectWorkAncestry';
import { internal } from './_generated/api';
import { viewContributors } from '../src/view-read-model';
import { viewIndexEntries } from '../src/view-hosted-index';
import type { ProvenanceFile } from '../src/view-provenance-plan';
import { materializeWork, indexBatches } from '../src/work-hosted-index';
import { invariant } from '../src/errors';

type Snapshot = {
  backup: Doc<'projectBackups'>;
  manifest: z.infer<typeof sourceManifestSchema>;
  data: WorkData;
};
const derived = new Set(['viewDetails', 'viewFiles', 'laneViews', 'viewAcceptances']);

/** Source bytes live for one State read, not for the retained project closure.
 * Only a View's changed paths survive into save provenance. */
export async function viewStates(ctx: ActionCtx, snapshot: Snapshot, owner: string, index: number) {
  const { backup, manifest, data } = snapshot,
    view = data.views[index]!,
    pins = new Map(manifest.files.map(file => [file.path, file]));
  function pin(head: string) {
    const selected = pins.get(`objects/${head}`);
    invariant(selected?.sha256 === head, 'SOURCE_UNAVAILABLE', 'A View State is not retained.');
    return { sha256: selected.sha256, size: selected.size };
  }
  const states = new Map<string, readonly ProvenanceFile[]>();
  if (!view.head || view.status === 'conflict') return states;
  const changed: { before: ProvenanceFile[]; after: ProvenanceFile[]; paths: string[] } = await ctx.runAction(
    internal.projectWorkAncestry.changedStates,
    {
      projectId: backup.projectId,
      actor: owner,
      before: pin(view.base),
      after: pin(view.head),
    },
  );
  states.set(view.base, changed.before);
  states.set(view.head, changed.after);
  const pending = [
    ...new Set(
      viewContributors(data, view).flatMap(c => [
        c.head,
        ...c.saves.flatMap(({ save }) => [save.parent, save.head]),
      ]),
    ),
  ].filter(head => !states.has(head));
  while (pending.length) {
    const selected: { sha256: string; size: number }[] = [];
    let bytes = 0;
    while (pending.length && selected.length < 100) {
      const next = pin(pending[0]!);
      if (selected.length && bytes + next.size > 2 * 1024 * 1024) break;
      pending.shift();
      selected.push(next);
      bytes += next.size;
    }
    try {
      const summaries: { head: string; files?: ProvenanceFile[] }[] = await ctx.runAction(
        internal.projectWorkAncestry.stateBatch,
        {
          projectId: backup.projectId,
          actor: owner,
          pins: selected,
          paths: changed.paths,
        },
      );
      for (const summary of summaries) if (summary.files) states.set(summary.head, summary.files);
    } catch {
      // Retain the existing incomplete-provenance result for unavailable States.
    }
  }
  return states;
}

/** Batches have deterministic positions and boundaries, so a persisted nextBatch
 * is a resumable cursor. No array of all historical State file lists or View
 * provenance rows is retained. Work/manifest metadata remains fully validated. */
export async function workProjection(ctx: ActionCtx, snapshot: Snapshot, owner: string) {
  const streamed =
    snapshot.backup.transport === 'objects' && snapshot.manifest.kind === 'forge-native-work-backup';
  const parents = await sourceParents(
      ctx,
      snapshot.backup,
      snapshot.manifest,
      snapshot.data,
      owner,
      !streamed,
    ),
    projection = materializeWork(snapshot.data, snapshot.manifest, [], snapshot.backup.transport, parents);
  await addDiffstats(ctx, snapshot, owner, projection.entries);
  const diffstats = projection.entries.filter(entry => entry.collection === 'diffstats').length;
  if (diffstats) projection.metadata.counts.diffstats = diffstats;
  if (!streamed)
    return {
      metadata: projection.metadata,
      batches: async function* () {
        yield* indexBatches(projection.entries);
      },
    };
  const entries = projection.entries.filter(
    entry =>
      !derived.has(entry.collection) && ![...derived].some(name => entry.collection === `${name}:payload`),
  );
  projection.entries.length = 0;
  const positions = new Map<string, number>();
  for (const name of derived) projection.metadata.counts[name] = 0;
  return {
    metadata: projection.metadata,
    batches: async function* () {
      // The common Code tree is published with the same generation as Work.
      const treeHeads = new Set([
        snapshot.manifest.head,
        ...archiveChannels(snapshot.manifest, snapshot.data)
          .filter(c => c.name === 'main')
          .map(c => c.head),
        ...(snapshot.data.hostedChannelMoves ?? [])
          .filter(c => c.channel === 'main')
          .slice(-1)
          .map(c => c.head),
      ]);
      for (const head of treeHeads) {
        const treePin = snapshot.manifest.files.find(file => file.sha256 === head);
        if (!treePin) continue;
        try {
          const reader = exchangeObjectReader(ctx, false, 0);
          const [bytes] = await reader.read(snapshot.backup.projectId, owner, [treePin]);
          entries.push(...sourceTreeEntries(head, parseNativeState(bytes!).files));
        } catch {
          // Optional tree optimization: the exact source reader remains available.
          // Publication still checks current authority in the staging transaction.
        }
      }
      yield* indexBatches(entries);
      entries.length = 0;
      for (let index = 0; index < snapshot.data.views.length; index++) {
        let states: Map<string, readonly ProvenanceFile[]> | undefined;
        try {
          states = await viewStates(ctx, snapshot, owner, index);
        } catch {
          /* unavailable remains explicit */
        }
        const rows = viewIndexEntries(snapshot.data, states, { index, positions });
        for (const name of derived)
          projection.metadata.counts[name]! += rows.filter(row => row.collection === name).length;
        yield* indexBatches(rows);
      }
    },
  };
}
