// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { bindLineInputs } from './projectLiveLineSubmission';
import { journalLaneSourcePins } from './projectJournalStore';
import { capsuleAcceptancePage } from './projectLandingCapsuleLedger';
import { capsulePlan } from './projectLandingCapsuleStore';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { z } from 'zod';
import { activeProject } from './projectAuthority';
import { loadLanding, loadLandingAttempt } from './projectHostedLandingStore';
import {
  hostedWriteProject,
  readHostedRecord,
  recordVersion,
  hostedRecordBody,
} from './projectHostedRecords';
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
export const acceptancePlan = async (ctx: QueryCtx | MutationCtx, input: ReceiptIdentity) =>
  (await ctx.db
    .query('projectHostedAcceptancePlans')
    .withIndex('by_project_and_receipt', q =>
      q.eq('projectId', input.projectId).eq('receiptId', input.receiptId),
    )
    .unique()) ?? capsulePlan(ctx, input);
export const acceptancePage = async (
  ctx: QueryCtx | MutationCtx,
  input: ReceiptIdentity & { kind: 'inputs' | 'dependencies'; index: number },
) =>
  (await ctx.db
    .query('projectHostedAcceptancePages')
    .withIndex('by_project_and_receipt_and_kind_and_index', q =>
      q
        .eq('projectId', input.projectId)
        .eq('receiptId', input.receiptId)
        .eq('kind', input.kind)
        .eq('index', input.index),
    )
    .unique()) ?? capsuleAcceptancePage(ctx, input);
export async function acceptanceSelection(ctx: QueryCtx | MutationCtx, input: AcceptanceIdentity) {
  const { row, state } = await loadLanding(ctx, input);
  invariant(
    state.attemptId === input.attemptId,
    'WORK_STALE',
    'Select the current attempt of this original landing request.',
  );
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
    inputsNext: (attempt.memberCandidate ?? attempt.candidate).inputs,
    dependenciesNext: (attempt.memberCandidate ?? attempt.candidate).dependencies,
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
  const { attempt, state } = await acceptanceSelection(ctx, input);
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
  const laneActors: Record<string, string> = {};
  const feedLanes: { laneId: string; actor?: string }[] = [];
  for (const value of page.entries) {
    if (input.kind === 'inputs') {
      const entry = composeLaneSchema.parse(value);
      let latest: z.infer<typeof hostedLaneSchema> | null = null;
      if (state.request.agent && state.request.finish) {
        const current = await readHostedRecord(ctx, {
          projectId: input.projectId,
          actor: plan.actor,
          kind: 'lane',
          key: entry.laneId,
        });
        latest = current ? hostedLaneSchema.parse(JSON.parse(current.value)) : null;
        invariant(
          !latest || latest.head === entry.head,
          'LANDING_SUPERSEDED',
          `Lane ${entry.laneId} desired head ${entry.head} was superseded by ${latest?.head}.`,
        );
      }
      // Read the immutable selected version, not a newer save. H08 has already
      // validated the composition; this verifies the completion ledger binding.
      const row = await recordVersion(ctx, input.projectId, 'lane', entry.laneId, entry.version);
      invariant(row, 'SOURCE_UNAVAILABLE', 'The exact included Lane version is unavailable.');
      const pins = journalLaneSourcePins(row);
      const lane = pins ? null : hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, row)));
      invariant(
        sameSaveLane(pins ?? lane!, entry),
        'EVIDENCE_CHANGED',
        'Included Lane pins differ from the Candidate.',
      );
      const actor =
        latest?.holder?.actor ??
        latest?.actor ??
        lane?.holder?.actor ??
        lane?.actor ??
        row.journalLane?.holderActor ??
        plan.actor;
      const recipient = actor === plan.actor ? undefined : actor;
      if (recipient) laneActors[entry.laneId] = recipient;
      feedLanes.push({ laneId: entry.laneId, ...(recipient ? { actor: recipient } : {}) });
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
  if (input.kind === 'inputs' && !state.request.finish?.composeOperationId)
    await bindLineInputs(
      ctx,
      state,
      page.entries.map(value => composeLaneSchema.parse(value)),
      input.index,
    );
  const root = completionPageRoot(plan.root, input.kind, input.index, page);
  await ctx.db.insert('projectHostedAcceptancePages', {
    ...key,
    digest: pin.sha256,
    root,
    value: canonicalPayload(page),
    ...(Object.keys(laneActors).length ? { laneActors } : {}),
  });
  const patch = {
    root,
    ...(input.kind === 'inputs'
      ? {
          inputsNext: page.next,
          inputPages: plan.inputPages + 1,
          lanes: plan.lanes + page.entries.length,
          ...(plan.inputPages === 0 && page.next === null ? { feedLanes } : {}),
        }
      : { dependenciesNext: page.next, dependencyPages: plan.dependencyPages + 1 }),
  };
  await ctx.db.patch(plan._id, patch);
  return { ...plan, ...patch };
}
