// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { archiveChannels } from '../src/work-archive-metadata';
import { sourceTreeEntries } from '../src/source-tree-index';
import { exchangeObjectReader } from './projectExchangeReader';
import { indexReadFailure } from './projectWorkIndexRetry';
import { parseNativeState } from '../src/native-source';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { WorkData } from '../src/work-types';
import type { z } from 'zod';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import { sourceParents } from './projectWorkAncestry';
import { viewIndexEntries } from '../src/view-hosted-index';
import { materializeWork, indexBatches } from '../src/work-hosted-index';
import { ownerProjection } from './projectOwnerProjection';

type Snapshot = {
  backup: Doc<'projectBackups'>;
  manifest: z.infer<typeof sourceManifestSchema>;
  data: WorkData;
};
const derived = 'viewAcceptances';

/** Batches have deterministic positions and boundaries, so a persisted nextBatch
 * is a resumable cursor. No array of all historical State file lists or View
 * provenance rows is retained. Work/manifest metadata remains fully validated. */
export async function workProjection(ctx: ActionCtx, snapshot: Snapshot, owner: string) {
  const supplied = await ownerProjection(ctx, snapshot, owner);
  if (supplied) return supplied;
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
  if (!streamed)
    return {
      metadata: projection.metadata,
      batches: async function* () {
        yield* indexBatches(projection.entries);
      },
    };
  const entries = projection.entries.filter(
    entry => entry.collection !== derived && entry.collection !== `${derived}:payload`,
  );
  projection.entries.length = 0;
  const positions = new Map<string, number>();
  projection.metadata.counts[derived] = 0;
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
        } catch (error) {
          if (indexReadFailure(ctx, error)) throw error;
          // Optional tree optimization: the exact source reader remains available.
          // Publication still checks current authority in the staging transaction.
        }
      }
      yield* indexBatches(entries);
      entries.length = 0;
      for (let index = 0; index < snapshot.data.views.length; index++) {
        const rows = viewIndexEntries(snapshot.data, { index, positions });
        projection.metadata.counts[derived]! += rows.filter(row => row.collection === derived).length;
        yield* indexBatches(rows);
      }
    },
  };
}
