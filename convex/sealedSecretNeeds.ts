// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The project's sealed-secrets needs-you counter (Item 41a0df87, slice 4): the sum of its sets' `needs`, kept on the
// project row by the same writes that change a marker, a proposal or a rotate row. The top bar's Needs me read already
// holds the project row, so the counter adds no read to a project load, and nothing runs while the project is idle.
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { storedNeeds, type StoredSealedSet } from './sealedSecretGate';

/** Moves the project's counter by `delta`. One point read and, only when it changes, one patch of the project row.
 * `project` is the row a caller already read in this mutation (its counter is current there). */
export async function moveSecretsNeeds(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  delta: number,
  project?: Pick<Doc<'hostedProjects'>, 'secretsNeeds'> | null,
) {
  if (!delta) return;
  const row = project ?? (await ctx.db.get(projectId));
  if (!row) return;
  const secretsNeeds = Math.max(0, (row.secretsNeeds ?? 0) + delta);
  await ctx.db.patch(projectId, { secretsNeeds: secretsNeeds || undefined });
  if (project) project.secretsNeeds = secretsNeeds || undefined;
}

/** Patches a set row and keeps its `needs` and the project counter in step in the same mutation. The needs total
 * is worked out from the patched row (one decode of its payload); a row stored before slice 4 is measured first. */
export async function patchSetKeepingNeeds(
  ctx: MutationCtx,
  set: Doc<'sealedSecretSets'>,
  patch: Partial<Doc<'sealedSecretSets'>>,
) {
  const next = { ...set, ...patch } as StoredSealedSet;
  const before = set.needs ?? storedNeeds(set as StoredSealedSet);
  const after = storedNeeds(next);
  await ctx.db.patch(set._id, { ...patch, needs: after || undefined });
  await moveSecretsNeeds(ctx, set.projectId, after - before);
}
