// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { batchRow, batchSchema } from './projectHostedLandingBatchState';
import { composeStateSchema } from './projectHostedComposeStore';
import { landingAttemptRow, loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { capsuleAttempt } from './projectLandingCapsuleStore';
import { invariant } from '../src/errors';
import { saveObjectSchema } from '../src/hosted-save';
import type { HostedLandingAttempt } from '../src/hosted-landing';

const LANE_PAGE = 32;
type Project = Id<'hostedProjects'>;
type Candidate = HostedLandingAttempt['candidate'];
const composePinSchema = composeStateSchema.pick({ candidateId: true, request: true, status: true });

function composeForCandidate(ctx: QueryCtx, projectId: Project, candidateId: string) {
  return ctx.db
    .query('projectHostedComposes')
    .withIndex('by_project_and_candidate', q => q.eq('projectId', projectId).eq('candidateId', candidateId))
    .unique();
}

function selectionManifest(value: string, candidateId: string, candidate: Candidate) {
  const { candidateId: id, request, status } = composePinSchema.strip().parse(JSON.parse(value));
  const matches = (root: Candidate['inputs'], pin: Candidate['inputs']) =>
    root.sha256 === pin.sha256 && root.size === pin.size;
  return id === candidateId &&
    status === 'completed' &&
    matches(request.inputs.root, candidate.inputs) &&
    matches(request.dependencies.root, candidate.dependencies)
    ? request
    : null;
}

async function candidateSelection(
  ctx: QueryCtx,
  projectId: Project,
  { candidate, submissionId }: HostedLandingAttempt,
  afterLaneId?: string,
) {
  const ownCompose = await composeForCandidate(ctx, projectId, candidate.id);
  let candidateId = candidate.id;
  if (!ownCompose && candidate.head === null) {
    // A rejected cohort member gets a new Candidate ID without a compose row.
    // Its submission can identify the original selection, but both roots must match.
    const row = await landingRow(ctx, { projectId, submissionId }, false);
    if (row) candidateId = row.candidateId ?? landingStateFromRow(row).request.candidateId;
  }
  const compose =
    ownCompose ??
    (candidateId === candidate.id ? null : await composeForCandidate(ctx, projectId, candidateId));
  if (!compose) return null;
  const manifest = selectionManifest(compose.value, candidateId, candidate);
  if (!ownCompose && !manifest) return null;
  invariant(manifest, 'EVIDENCE_CHANGED', 'The retained composition differs from the Candidate input pins.');
  const { inputs, dependencies } = manifest;
  const counts = { inputCount: inputs.count, dependencyCount: dependencies.count };
  if (inputs.count === 0) return { ...counts, lanes: [], nextAfterLaneId: null };
  // Solo recomposition reuses the original Candidate's exact roots and indexed Lane selection.
  const originalId = compose.selectionCandidateId;
  const original = originalId ? await composeForCandidate(ctx, projectId, originalId) : compose;
  if (!original) return { ...counts, lanes: null, nextAfterLaneId: null };
  if (originalId)
    invariant(
      selectionManifest(original.value, originalId, candidate),
      'EVIDENCE_CHANGED',
      'The original composition differs from the Candidate input pins.',
    );
  const indexed = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q => {
      const range = q
        .eq('projectId', projectId)
        .eq('actor', original.actor)
        .eq('operationId', original.operationId)
        .eq('kind', 'inputs');
      return afterLaneId === undefined ? range : range.gt('key', afterLaneId);
    })
    .take(LANE_PAGE + 1);
  return {
    ...counts,
    lanes:
      indexed.length || afterLaneId !== undefined
        ? indexed.slice(0, LANE_PAGE).map(row => ({
            laneId: z.uuid().parse(row.key),
            head: row.head === undefined ? null : saveObjectSchema.shape.sha256.parse(row.head),
          }))
        : null,
    nextAfterLaneId: indexed.length > LANE_PAGE ? indexed[LANE_PAGE - 1]!.key : null,
  };
}

/** Exact evidence selectors share the same project access check as attempt history. */
export async function landingSelectionRead(
  ctx: QueryCtx,
  projectId: Project,
  selection: { batchId: string } | { submissionId: string; attemptId: string; afterLaneId?: string },
) {
  if ('batchId' in selection) {
    const row = await batchRow(ctx, { projectId, batchId: selection.batchId });
    invariant(row, 'NOT_FOUND', 'Hosted landing batch not found.');
    const batch = batchSchema.parse(JSON.parse(row.value));
    invariant(batch.id === selection.batchId, 'EVIDENCE_CHANGED', 'The retained batch identity differs.');
    return {
      batch: {
        id: batch.id,
        phase: batch.phase,
        parentId: batch.parentId ?? null,
        runId: batch.runId ?? null,
        members: batch.members.map(member => ({
          submissionId: member.submissionId,
          candidateId: member.candidate.id,
          head: member.candidate.head,
        })),
      },
    };
  }
  const { attemptId, submissionId, afterLaneId } = selection;
  const key = { projectId, attemptId };
  const row = await landingAttemptRow(ctx, key);
  const attempt = row ? await loadLandingAttempt(ctx, key, row) : await capsuleAttempt(ctx, key);
  invariant(attempt?.submissionId === submissionId, 'NOT_FOUND', 'Hosted landing attempt not found.');
  const { candidate } = attempt;
  return {
    submissionId,
    attemptId,
    main: attempt.main,
    candidate: {
      id: candidate.id,
      head: candidate.head,
      inputs: candidate.inputs,
      dependencies: candidate.dependencies,
    },
    selection: await candidateSelection(ctx, projectId, attempt, afterLaneId),
  };
}
