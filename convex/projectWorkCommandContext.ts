// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { workHead } from './projectWorkHead';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { invariant } from '../src/errors';

/** One close or Undo transaction holds a single authorized project, Work head and selection.
 * Only ordinary Work writes advance this head; the next command sees the new revision. */
export async function planningWriteContext(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const [selected, head] = await Promise.all([selectedGeneration(ctx, project), workHead(ctx, project._id)]);
  invariant(selected, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index before writing.');
  const backup = await ctx.db.get(selected.backupId);
  invariant(
    backup?.projectId === project._id && backup.status === 'stored',
    'PROJECT_UNAVAILABLE',
    'Select this project’s stored source.',
  );
  const partition = recordPartition(selected);
  const rows = new Map<string, ReturnType<typeof record>>();
  const keyOf = (collection: string, key: string) => JSON.stringify([collection, key]);
  return {
    project,
    selected,
    backup,
    head,
    get generation() {
      return this.head?.backupId === selected.backupId
        ? { ...selected, revision: this.head.revision, metadata: this.head.metadata ?? selected.metadata }
        : selected;
    },
    get revision() {
      return this.head?.backupId === project.work?.backupId ? this.head?.revision : project.work?.revision;
    },
    record(collection: string, key: string) {
      const encoded = keyOf(collection, key);
      let row = rows.get(encoded);
      if (!row) {
        row = record(ctx, partition, collection, key);
        rows.set(encoded, row);
      }
      return row;
    },
    invalidate(collection: string, key: string) {
      rows.delete(keyOf(collection, key));
    },
  };
}

export type PlanningWriteContext = Awaited<ReturnType<typeof planningWriteContext>>;
