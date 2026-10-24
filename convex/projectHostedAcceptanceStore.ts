// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { loadLanding, loadLandingAttempt } from './projectHostedLandingStore';
import { hostedWriteProject, readHostedRecord } from './projectHostedRecords';
import { saveObject, sameSaveLane } from './projectHostedSaveStore';
import { hostedLaneSchema } from '../src/hosted-lane';
import { validateComposePage, composeLaneSchema, composeDependencySchema } from '../src/hosted-compose';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { savePin } from '../src/hosted-save';
import { EMPTY_COMPLETION_ROOT, completionPageRoot } from '../src/hosted-acceptance';
import { invariant } from '../src/errors';
export type AcceptanceIdentity = { projectId: Id<'hostedProjects'>; submissionId: string; attemptId: string };
export type ReceiptIdentity = { projectId: Id<'hostedProjects'>; receiptId: string };
export const acceptanceRow = (ctx: QueryCtx | MutationCtx, input: ReceiptIdentity) =>
  ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_receipt', q =>
      q.eq('projectId', input.projectId).eq('receiptId', input.receiptId),
    )
    .unique();
export const acceptancePlan = (ctx: QueryCtx | MutationCtx, input: ReceiptIdentity) =>
  ctx.db
    .query('projectHostedAcceptancePlans')
    .withIndex('by_project_and_receipt', q =>
      q.eq('projectId', input.projectId).eq('receiptId', input.receiptId),
    )
    .unique();
export const acceptancePage = (
  ctx: QueryCtx | MutationCtx,
  input: ReceiptIdentity & { kind: 'inputs' | 'dependencies'; index: number },
) =>
  ctx.db
    .query('projectHostedAcceptancePages')
    .withIndex('by_project_and_receipt_and_kind_and_index', q =>
      q
        .eq('projectId', input.projectId)
        .eq('receiptId', input.receiptId)
        .eq('kind', input.kind)
        .eq('index', input.index),
    )
    .unique();
export async function acceptanceSelection(ctx: QueryCtx | MutationCtx, input: AcceptanceIdentity) {
  const { row, state } = await loadLanding(ctx, input);
  const attempt = await loadLandingAttempt(ctx, input);
  invariant(
    state.attemptId === attempt.id && attempt.submissionId === state.id && attempt.actor.id === state.actor,
    'WORK_STALE',
    'Select the current attempt of this original landing request.',
  );
  await activeProject(ctx, input.projectId, attempt.actor.id);
  return { row, state, attempt };
}
/** Stages immutable inclusion/lifecycle references, never moves a Lane or main.
 * The original attempt's accept UUID is also its retained plan/receipt identity. */
export async function prepareAcceptance(ctx: MutationCtx, input: AcceptanceIdentity) {
  const { attempt } = await acceptanceSelection(ctx, input);
  const key = { projectId: input.projectId, receiptId: attempt.operations.accept };
  const old = await acceptancePlan(ctx, key);
  if (old) return old;
  await hostedWriteProject(ctx, input.projectId, attempt.actor.id, attempt.authorityEpoch);
  invariant(attempt.candidate.head !== null, 'COMPOSITION_CONFLICT', 'A conflicted Candidate cannot land.');
  const id = await ctx.db.insert('projectHostedAcceptancePlans', {
    ...key,
    submissionId: input.submissionId,
    attemptId: attempt.id,
    actor: attempt.actor.id,
    inputsNext: attempt.candidate.inputs,
    dependenciesNext: attempt.candidate.dependencies,
    inputPages: 0,
    dependencyPages: 0,
    lanes: 0,
    root: EMPTY_COMPLETION_ROOT,
    appliedPage: 0,
    appliedEntry: 0,
  });
  return (await ctx.db.get(id))!;
}
export async function stageAcceptance(
  ctx: MutationCtx,
  input: AcceptanceIdentity & {
    kind: 'inputs' | 'dependencies';
    index: number;
    page: unknown;
  },
) {
  const plan = await prepareAcceptance(ctx, input);
  const { attempt } = await acceptanceSelection(ctx, input);
  const page = validateComposePage(input.page),
    pin = savePin(page);
  const key = { projectId: input.projectId, receiptId: plan.receiptId, kind: input.kind, index: input.index };
  const old = await acceptancePage(ctx, key);
  if (old) {
    invariant(
      old.digest === pin.sha256,
      'WORK_OPERATION_CHANGED',
      'Replay the original acceptance metadata page.',
    );
    return plan;
  }
  await hostedWriteProject(ctx, input.projectId, plan.actor, attempt.authorityEpoch);
  const next = input.kind === 'inputs' ? plan.inputsNext : plan.dependenciesNext;
  const index = input.kind === 'inputs' ? plan.inputPages : plan.dependencyPages;
  invariant(
    input.index === index &&
      canonicalPayload(next) === canonicalPayload(pin) &&
      (input.kind === 'inputs' || plan.inputsNext === null),
    'WORK_OPERATION_CHANGED',
    'Stage the next original input/dependency page in order.',
  );
  await saveObject(ctx, input.projectId, pin);
  for (const value of page.entries) {
    if (input.kind === 'inputs') {
      const entry = composeLaneSchema.parse(value);
      // Read the immutable selected version, not a newer save. H08 has already
      // validated the composition; this verifies the completion ledger binding.
      const row = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor: plan.actor,
        kind: 'lane',
        key: entry.laneId,
        version: entry.version,
      });
      invariant(row, 'SOURCE_UNAVAILABLE', 'The exact included Lane version is unavailable.');
      const lane = hostedLaneSchema.parse(JSON.parse(row.value));
      invariant(
        sameSaveLane(lane, entry),
        'EVIDENCE_CHANGED',
        'Included Lane pins differ from the Candidate.',
      );
    } else {
      const entry = composeDependencySchema.parse(value);
      const row = await readHostedRecord(ctx, {
        projectId: input.projectId,
        actor: plan.actor,
        kind: 'candidate',
        key: entry.candidateId,
      });
      invariant(row, 'SOURCE_UNAVAILABLE', 'The exact included dependency is unavailable.');
      const candidate = hostedRecordSchema.parse(JSON.parse(row.value));
      invariant(
        candidate.kind === 'candidate' &&
          candidate.result.status === 'clean' &&
          candidate.result.head === entry.head,
        'EVIDENCE_CHANGED',
        'Included dependency pins differ from the Candidate.',
      );
    }
  }
  const root = completionPageRoot(plan.root, input.kind, input.index, page);
  await ctx.db.insert('projectHostedAcceptancePages', {
    ...key,
    digest: pin.sha256,
    root,
    value: canonicalPayload(page),
  });
  const patch = {
    root,
    ...(input.kind === 'inputs'
      ? { inputsNext: page.next, inputPages: plan.inputPages + 1, lanes: plan.lanes + page.entries.length }
      : { dependenciesNext: page.next, dependencyPages: plan.dependencyPages + 1 }),
  };
  await ctx.db.patch(plan._id, patch);
  return { ...plan, ...patch };
}
