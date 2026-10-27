// SPDX-License-Identifier: Apache-2.0
'use node';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { WorkData } from '../src/work-types';
import type { z } from 'zod';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import type { IndexEntry } from '../src/work-hosted-index';
import { internal } from './_generated/api';
import { reviewPaths } from '../src/native-source-review';
type ProvenanceFile = { path: string; blob: string; mode: 'file' | 'executable' | 'symlink' };
import { invariant } from '../src/errors';
export type ChangedStates = {
  before: ProvenanceFile[];
  after: ProvenanceFile[];
  paths: string[];
  states?: { head: string; files: ProvenanceFile[] }[];
};
export type Pin = { sha256: string; size: number };
export type Stats = { files: number; add?: number; del?: number };
export const compareFiles = makeFunctionReference<
  'action',
  {
    projectId: Doc<'projectBackups'>['projectId'];
    actor: string;
    files: { before?: Pin; after?: Pin }[];
  },
  { add: number; del: number; exact: boolean; storageReads?: number; storageBytes?: number }
>('projectDiffstats:compare');

/** Reuse immutable pair totals from the selected index. Only new base/head pairs
 * read source, with changed-file batches; no saves or ancestry are scanned. */
export async function addDiffstats(
  ctx: ActionCtx,
  snapshot: {
    backup: Doc<'projectBackups'>;
    manifest: z.infer<typeof sourceManifestSchema>;
    data: WorkData;
  },
  owner: string,
  entries: IndexEntry[],
  changedStates?: ReadonlyMap<string, ChangedStates>,
  preparedStats?: ReadonlyMap<string, Stats>,
  sourcePins?: ReadonlyMap<string, Pin>,
) {
  if (snapshot.backup.transport !== 'objects' || snapshot.manifest.kind !== 'forge-native-work-backup')
    return;
  const current: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
    internal.projectWorkIndexStore.current,
    { projectId: snapshot.backup.projectId, owner },
  );
  const pins =
    sourcePins ??
    new Map(snapshot.manifest.files.map(file => [file.sha256, { sha256: file.sha256, size: file.size }]));
  const pin = (hash: string) => {
    const selected = pins.get(hash);
    invariant(selected, 'SOURCE_UNAVAILABLE', 'Diffstat source is unavailable.');
    return selected;
  };
  const cache = new Map<string, Stats>();
  const records = entries.filter(entry => entry.collection === 'lanes' || entry.collection === 'views');
  for (const entry of records) {
    const value = JSON.parse(entry.value) as { base: string; head?: string; status?: string };
    if (!value.head || value.status === 'conflict') continue;
    const key = `${value.base}:${value.head}`;
    try {
      let stats = cache.get(key) ?? preparedStats?.get(key);
      if (!stats && current) {
        const rows = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
          projectId: snapshot.backup.projectId,
          owner,
          generationId: current._id,
          keys: [{ collection: 'diffstats', key }],
        });
        if (rows[0]) stats = JSON.parse(rows[0].value) as Stats;
      }
      if (!stats) {
        const changed: ChangedStates =
          changedStates?.get(key) ??
          (await ctx.runAction(internal.projectWorkAncestry.changedStates, {
            projectId: snapshot.backup.projectId,
            actor: owner,
            before: pin(value.base),
            after: pin(value.head),
          }));
        const paths = reviewPaths(changed.before, changed.after).filter(file => file.status !== 'unchanged');
        let add = 0,
          del = 0,
          exact = true;
        for (let i = 0; i < paths.length; i += 50) {
          const result = await ctx.runAction(compareFiles, {
            projectId: snapshot.backup.projectId,
            actor: owner,
            files: paths.slice(i, i + 50).map(file => ({
              ...(file.before ? { before: pin(file.before.blob) } : {}),
              ...(file.after ? { after: pin(file.after.blob) } : {}),
            })),
          });
          add += result.add;
          del += result.del;
          exact &&= result.exact;
        }
        stats = { files: paths.length, ...(exact ? { add, del } : {}) };
      }
      if (!cache.has(key)) {
        cache.set(key, stats);
        entries.push({
          collection: 'diffstats',
          key,
          parent: '',
          position: cache.size - 1,
          value: JSON.stringify(stats),
        });
      }
      entry.value = JSON.stringify({ ...value, changes: stats });
    } catch {
      // Missing source stays unknown, and will be retried on a later materialization.
    }
  }
  // Cache hits still passed the current index's authority check; source reads check
  // authority independently. Do not turn a revocation into a successful projection.
  await ctx.runQuery(internal.projectBackups.get, { id: snapshot.backup._id, owner });
}
