// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

/** Cold capsule pins (Item 411727ba, row 5): the terminal attempt and the acceptance plan, the
 * bulk of the pointer. They are read only on replay (`capsuleAttempt`, `capsulePlan`), so they live
 * in one unindexed body row owned by the 11-copy pointer row. `removalDone`, `attemptPin` and the
 * compact `evidence` chain (read by landing history) stay on the pointer. */
const coldFields = ['attempt', 'plan'] as const;
type Identity = { projectId: Id<'hostedProjects'>; submissionId: string };
type Summary = Record<string, unknown> & { pins?: string };
type Db = QueryCtx['db'];
/** The pointer row kind in projectFinishReadRows (re-exported by projectLandingCapsuleStore). */
export const capsuleKind = 'projectLandingCapsules';

/** Writes the cold fields to a body row and returns the slim summary text for the pointer. */
export async function splitCapsulePins(db: MutationCtx['db'], identity: Identity, summary: Summary) {
  const cold = Object.fromEntries(coldFields.flatMap(key => (key in summary ? [[key, summary[key]]] : [])));
  if (!Object.keys(cold).length) return canonicalPayload(summary);
  const slim: Summary = { ...summary };
  for (const key of coldFields) delete slim[key];
  slim.pins = await db.insert('projectHostedLandingBodies', {
    value: canonicalPayload({ projectId: identity.projectId, submissionId: identity.submissionId, ...cold }),
  });
  return canonicalPayload(slim);
}
async function pinsBody(db: Db, identity: Identity, id: string) {
  const body = await db.get(id as Id<'projectHostedLandingBodies'>);
  invariant(body, 'SOURCE_UNAVAILABLE', 'Original capsule transaction pins are unavailable.');
  const cold = JSON.parse(body.value) as Summary;
  invariant(
    cold.projectId === identity.projectId && cold.submissionId === identity.submissionId,
    'EVIDENCE_CHANGED',
    'Capsule pins belong to another landing.',
  );
  return { body, cold };
}
/** The full summary a pointer had before the split: slim pointers join their body row, older
 * pointers (inline or not yet moved) already carry it. One body read, only on cold readers. */
export async function capsuleSummary(
  db: Db,
  identity: Identity,
  pointer: LandingCapsulePointer,
): Promise<Summary | null> {
  if (!pointer.summary) return null;
  const summary = JSON.parse(pointer.summary) as Summary;
  if (typeof summary.pins !== 'string') return summary;
  const { cold } = await pinsBody(db, identity, summary.pins);
  const full: Summary = { ...summary };
  delete full.pins;
  for (const key of coldFields) if (key in cold) full[key] = cold[key];
  return full;
}
/** Purge and orphan cleanup delete a pointer row's body with it (parent-owned, like ticket bodies). */
export async function deleteCapsulePins(db: MutationCtx['db'], row: Record<string, unknown>) {
  if (row.kind !== capsuleKind || typeof row.value !== 'string') return [];
  const pointer = JSON.parse(row.value) as LandingCapsulePointer;
  const id = pointer.summary ? (JSON.parse(pointer.summary) as Summary).pins : undefined;
  if (typeof id !== 'string') return [];
  const body = await db.get(id as Id<'projectHostedLandingBodies'>);
  if (!body) return []; // A resumed cleanup may already have removed it.
  const cold = JSON.parse(body.value) as Summary;
  invariant(
    cold.projectId === row.projectId && cold.submissionId === row.submissionId,
    'EVIDENCE_CHANGED',
    'Capsule pins belong to another landing.',
  );
  await db.delete(body._id);
  return [body];
}
