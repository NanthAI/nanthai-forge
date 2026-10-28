// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { Cursor } from './projectSourceReturnStep';
import type { WorkData } from '../src/work-types';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import type { z } from 'zod';
import { exchangeObjectReader } from './projectExchangeReader';
import { readOwnerDerived, ownerDerivedRows } from './projectOwnerDerived';
import { workSourcePins } from '../src/work-archive-metadata';
import { selectedTreeHeads, ownerDerivedSchema } from '../src/owner-derived';
import { materializeWork, indexBatches } from '../src/work-hosted-index';
/** Cold indexes from complete current publications use owner facts too. Legacy
 * reads (including incomplete old publications) retain their read-only builder. */
export async function ownerProjection(
  ctx: ActionCtx,
  snapshot: {
    backup: Doc<'projectBackups'>;
    data: WorkData;
    manifest: z.infer<typeof sourceManifestSchema>;
  },
  owner: string,
) {
  const pin = snapshot.backup.ownerDerived;
  if (!pin) return;
  const reader = exchangeObjectReader(ctx, false, 0);
  const value = await readOwnerDerived(
    pin,
    async () => (await reader.read(snapshot.backup.projectId, owner, [pin]))[0]!,
    pins => reader.read(snapshot.backup.projectId, owner, pins),
  );
  const parsed = ownerDerivedSchema.safeParse(value);
  if (!parsed.success || parsed.data.schema !== 3 || !parsed.data.complete) return;
  const projection = materializeWork(
    snapshot.data,
    snapshot.manifest,
    [],
    snapshot.backup.transport,
    new Map(),
    true,
  );
  const summaries = projection.entries.filter(
    row => row.collection === 'lanes' || row.collection === 'views',
  );
  const c = {
    snapshot,
    final: {
      command: JSON.stringify({
        workSha256: snapshot.manifest.files.find(p => p.path === 'work.json')?.sha256,
      }),
    },
    pending: workSourcePins(snapshot.data),
    parents: [],
    heads: workSourcePins(snapshot.data),
    diffstats: { records: summaries },
    delta: {
      stopParents: [],
      views: snapshot.data.views.map((_, i) => i),
      trees: selectedTreeHeads(snapshot.data),
    },
  } as unknown as Cursor;
  const supplied = ownerDerivedRows(c, value);
  if ('reason' in supplied) return; // Existing hosted reads preserve their compatibility path.
  const entries = [
    ...projection.entries.filter(row => row.collection !== 'lanes' && row.collection !== 'views'),
    ...supplied.rows,
  ];
  const counts: Record<string, number> = {};
  for (const row of entries) {
    if (['viewDetails', 'laneViews', 'viewAcceptances'].includes(row.collection))
      row.position = counts[row.collection] ?? 0;
    counts[row.collection] = (counts[row.collection] ?? 0) + 1;
  }
  projection.metadata.counts = counts;
  return {
    metadata: projection.metadata,
    batches: async function* () {
      yield* indexBatches(entries);
    },
  };
}
