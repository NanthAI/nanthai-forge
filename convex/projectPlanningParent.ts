// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { invariant } from '../src/errors';
import { isLive } from '../src/planning-model';
import type { IndexEntry } from '../src/work-hosted-index';
import type { PlanningItem } from '../src/work-types';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { workChildCount } from './projectWorkRecordWriter';

const shelved = (status?: PlanningItem['status']) => status === 'archived' || status === 'deleted';
export const restoredTopLevelNotice =
  'Restored as a top-level Item because its former parent is now a sub-item.';

/** Existing legacy chains are not rewritten on an ordinary edit. Validate only a changed edge or an Item
 * leaving a shelf. The tally includes hidden, settled and unloaded children, not shelved children. */
export async function planningParent(
  ctx: MutationCtx,
  partition: Id<'projectWorkGenerations'>,
  before: PlanningItem | undefined,
  after: PlanningItem,
  load: (collection: string, key: string) => Promise<IndexEntry | null>,
  verifyInitiative: boolean,
) {
  if (!after.parentId) return;
  const changed = after.parentId !== before?.parentId;
  const restoring = shelved(before?.status) && !shelved(after.status);
  if (!changed && !restoring && !verifyInitiative) return;
  const record =
    (await load('planningSearch', after.parentId)) ?? (await load('planningItems', after.parentId));
  const parent = record ? (JSON.parse(record.value) as PlanningItem) : undefined;
  if (!changed && restoring) {
    if (parent?.parentId) return restoredTopLevelNotice;
    return;
  }
  invariant(
    parent?.kind === 'issue' &&
      !parent.purged &&
      (!changed || (after.id !== after.parentId && !parent.parentId)) &&
      (!verifyInitiative || isLive(parent)),
    'BAD_ARGUMENT',
    'Select a top-level parent Item.',
  );
  if (verifyInitiative)
    invariant(
      (parent.initiativeId ?? null) === (after.initiativeId ?? null),
      'BAD_ARGUMENT',
      'The Item must move to its parent’s Initiative.',
    );
  if (!before || !changed) return;
  const children = await workChildCount(ctx, partition, after.id);
  invariant(
    children !== null,
    'BAD_ARGUMENT',
    'Child tallies are still preparing. Retry once preparation finishes.',
  );
  invariant(children === 0, 'BAD_ARGUMENT', 'An Item with sub-items cannot become a sub-item.');
}
