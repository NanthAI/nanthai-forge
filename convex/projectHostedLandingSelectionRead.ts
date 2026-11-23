// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { batchRow, batchSchema } from './projectHostedLandingBatchState';
import { composeStateSchema } from './projectHostedComposeStore';
import { landingAttemptRow, loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { capsuleAttempt, landingCapsulePointer } from './projectLandingCapsuleStore';
import { capsuleHistoryContext } from './projectLandingCapsuleContext';
import { readMetricAttemptPins } from './projectMetricReadProjection';
import { ForgeError, invariant } from '../src/errors';
import { saveObjectSchema } from '../src/hosted-save';
import { hostedLandingAttemptSchema, type HostedLandingAttempt } from '../src/hosted-landing';
import type { LandingCapsule } from '../src/landing-capsule';
import type { CrossHeadProof } from '../src/hosted-cross-head-proof';
import { LANDINGS_OUTPUT_BYTES } from '../src/hosted-landings-view';
import { canonicalPayload } from '../src/hosted-source-operation';

const LANE_PAGE = 32;
type Project = Id<'hostedProjects'>;
type Candidate = HostedLandingAttempt['candidate'];
const composePinSchema = composeStateSchema.pick({ candidateId: true, request: true, status: true });

function reuseProofPins(proof: CrossHeadProof) {
  const {
    algorithm,
    checked,
    checkedBase,
    main,
    head,
    runId,
    terminalDigest,
    planDigest,
    checkedSelection,
    cleanComposition,
    audit,
  } = proof;
  return {
    algorithm,
    checked,
    checkedBase,
    main,
    head,
    runId,
    terminalDigest,
    planDigest,
    checkedSelection,
    cleanComposition,
    audit,
    ...('checkedScope' in proof ? { checkedScope: proof.checkedScope } : {}),
    ...('riskRule' in proof ? { riskRule: proof.riskRule } : {}),
    ...('testedDocsRule' in proof ? { testedDocsRule: proof.testedDocsRule } : {}),
    ...('relaxed' in proof ? { relaxed: proof.relaxed } : {}),
  };
}

type ReusePins = {
  parentAttemptId: string | null;
  runId: string | null;
  recheckReason: string | null;
  forkReason: string | null;
  scopedFallback: string | null;
};

type SelectedAttempt = { submissionId: string; attemptId: string };
export type ArchivedSelection = SelectedAttempt & {
  number: number;
  mainHead: string | null;
  candidateHead: string | null;
  checkReuse: ReusePins;
};

function reusePins(attempt: HostedLandingAttempt): ReusePins {
  return {
    parentAttemptId: attempt.parentAttemptId,
    runId: attempt.check?.runId ?? null,
    recheckReason: attempt.recheckReason ?? null,
    forkReason: attempt.forkReason ?? null,
    scopedFallback: attempt.scopedFallback ?? null,
  };
}

function selectedProof(attempt: HostedLandingAttempt) {
  const proof = attempt.crossHeadProof;
  invariant(
    !proof ||
      (proof.runId === attempt.check?.runId &&
        proof.head === attempt.candidate.head &&
        proof.main.head === attempt.main.head &&
        proof.main.receiptId === attempt.main.receiptId),
    'EVIDENCE_CHANGED',
    'The retained proof differs from the selected check, Candidate, or base.',
  );
  return proof;
}

function selectedAttemptReply(reply: object, checkReuse: ReusePins, proof?: CrossHeadProof) {
  const encoder = new TextEncoder();
  const encode = (proofStatus: 'retained' | 'unavailable' | 'byte-omitted', fields: object = {}) => {
    // Paths can look like embedded JSON. Keep those literal bytes through the public person mapper.
    const reuse = { ...checkReuse, proofStatus, ...fields };
    const bytes = encoder.encode(JSON.stringify(reuse));
    if (Math.ceil(bytes.length / 3) * 4 > LANDINGS_OUTPUT_BYTES) return null;
    // MCP embeds the decoded result as JSON text. Escaped path names can cost more than base64.
    const decoded = JSON.stringify({ ...reply, checkReuse: reuse });
    if (encoder.encode(JSON.stringify(decoded)).length > LANDINGS_OUTPUT_BYTES) return null;
    const text = JSON.stringify({ ...reply, checkReuseBase64: btoa(String.fromCharCode(...bytes)) });
    return encoder.encode(JSON.stringify(text)).length <= LANDINGS_OUTPUT_BYTES ? text : null;
  };
  if (proof) {
    const full = encode('retained', { crossHeadProof: proof });
    if (full) return full;
    const pins = encode('byte-omitted', { proofPins: reuseProofPins(proof) });
    if (pins) return pins;
  }
  const bounded = encode(proof ? 'byte-omitted' : 'unavailable');
  invariant(bounded, 'SOURCE_UNAVAILABLE', 'The retained attempt selection exceeds the reply budget.');
  return bounded;
}

function compactSelectionReply(
  { submissionId, attemptId, checkReuse }: ArchivedSelection,
  proof?: CrossHeadProof,
) {
  return selectedAttemptReply(
    { submissionId, attemptId, main: null, candidate: null, selection: null },
    checkReuse,
    proof,
  );
}

/** The action opens only the capsule chosen by the authorized query for this compact row. */
export function archivedSelectedAttempt(capsule: LandingCapsule | null, selected: ArchivedSelection) {
  const { submissionId, attemptId, number, mainHead, candidateHead, checkReuse } = selected;
  let selectedRow: Doc<'projectHostedLandingAttempts'> | undefined;
  for (const text of capsule?.tables.projectHostedLandingAttempts ?? []) {
    const row = JSON.parse(text) as Doc<'projectHostedLandingAttempts'>;
    if (row.attemptId !== attemptId) continue;
    invariant(
      !selectedRow && row.projectId === capsule?.projectId && row.submissionId === submissionId,
      'EVIDENCE_CHANGED',
      'The capsule repeats the selected attempt or assigns it to another landing.',
    );
    selectedRow = row;
  }
  if (!selectedRow) return compactSelectionReply(selected);
  let attempt: HostedLandingAttempt;
  try {
    attempt = hostedLandingAttemptSchema.parse(JSON.parse(selectedRow.value));
  } catch {
    throw new ForgeError('EVIDENCE_CHANGED', 'The selected capsule attempt record is invalid.');
  }
  invariant(
    attempt.projectId === selectedRow.projectId &&
      attempt.submissionId === submissionId &&
      attempt.id === attemptId &&
      attempt.number === selectedRow.number &&
      attempt.number === number &&
      attempt.main.head === mainHead &&
      attempt.candidate.head === candidateHead &&
      canonicalPayload(reusePins(attempt)) === canonicalPayload(checkReuse),
    'EVIDENCE_CHANGED',
    'The capsule attempt differs from its selected identity or compact pins.',
  );
  return compactSelectionReply(selected, selectedProof(attempt));
}

async function selectArchivedAttempt(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  { submissionId, attemptId }: SelectedAttempt,
  protocol: 1 | undefined,
) {
  const projectId = project._id;
  const row = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_attempt', q =>
      q.eq('kind', 'projectHostedLandingAttempts').eq('projectId', projectId).eq('attemptId', attemptId),
    )
    .unique();
  invariant(row?.submissionId === submissionId, 'NOT_FOUND', 'Hosted landing attempt not found.');
  const pins = readMetricAttemptPins(row);
  invariant(
    pins.id === attemptId && pins.submissionId === submissionId && pins.selection.projectId === projectId,
    'EVIDENCE_CHANGED',
    'The retained attempt identity differs.',
  );
  const { parentAttemptId, mainHead, runId, recheckReason, forkReason, scopedFallback } = pins;
  const { number, candidateHead } = pins.selection;
  const selectedAttempt: ArchivedSelection = {
    submissionId,
    attemptId,
    number,
    mainHead,
    candidateHead,
    checkReuse: { parentAttemptId, runId, recheckReason, forkReason, scopedFallback },
  };
  // A stored reuse proof always names its check. Leave compact attempts without one query-only.
  if (protocol && runId) {
    const key = { projectId, submissionId };
    const pointer = (await landingCapsulePointer(ctx, key)) ?? (await landingRow(ctx, key, false))?.capsule;
    if (pointer)
      return capsuleHistoryContext(ctx, project, pointer, protocol, submissionId, { selectedAttempt });
  }
  return compactSelectionReply(selectedAttempt);
}

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
  project: Doc<'hostedProjects'>,
  selection: { batchId: string } | (SelectedAttempt & { afterLaneId?: string; capsuleProtocol?: 1 }),
) {
  const projectId = project._id;
  if ('batchId' in selection) {
    const row = await batchRow(ctx, { projectId, batchId: selection.batchId });
    invariant(row, 'NOT_FOUND', 'Hosted landing batch not found.');
    const batch = batchSchema.parse(JSON.parse(row.value));
    invariant(batch.id === selection.batchId, 'EVIDENCE_CHANGED', 'The retained batch identity differs.');
    return JSON.stringify({
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
    });
  }
  const { attemptId, submissionId, afterLaneId } = selection;
  const key = { projectId, attemptId };
  const row = await landingAttemptRow(ctx, key);
  const attempt = row ? await loadLandingAttempt(ctx, key, row) : await capsuleAttempt(ctx, key);
  if (!attempt) return selectArchivedAttempt(ctx, project, selection, selection.capsuleProtocol);
  invariant(attempt.submissionId === submissionId, 'NOT_FOUND', 'Hosted landing attempt not found.');
  const { candidate } = attempt;
  return selectedAttemptReply(
    {
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
    },
    reusePins(attempt),
    selectedProof(attempt),
  );
}
