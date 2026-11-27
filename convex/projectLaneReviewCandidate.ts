// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { laneLandingRequest } from './projectFailureCauseRead';
import { loadHostedCheck } from './projectHostedCheckStore';
import { landingMessageForReader } from './projectHostedLandingMessageBody';
import { landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { landingAttemptRow, loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { readHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import type { AutonomyPolicy } from '../src/autonomy-policy';
import { protectedPathMatches, type DefinedChecks } from '../src/public-governance';

const protectedReasonPrefixes = [
  'needs owner approval: protected paths ',
  'Waiting for review by a person; protected paths: ',
];

/** The recorded sentence confirms the structured match. It cannot supply file names. */
function matchesHold(reason: string, prefix: string, paths: string[] | null) {
  if (!paths?.length) return false;
  const sentence = prefix + paths.join(', ');
  return reason === sentence || reason.startsWith(sentence + '; approval ');
}

/** Keep scope useful when the independently paged listing cannot show every path. */
function protection(paths: string[] | null) {
  if (!paths) return null;
  const distinct = [...new Set(paths)];
  const shown: string[] = [];
  const encode = new TextEncoder();
  let bytes = 0;
  for (const path of distinct) {
    bytes += encode.encode(JSON.stringify(path)).length + 1;
    if (bytes > 64 * 1024) break;
    shown.push(path);
  }
  return { paths: shown, total: distinct.length };
}

/** Only the review of a submitted change does these bounded point/index reads. No State or check output is read. */
export async function laneReviewCandidate(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    laneId: string;
    intentId: string;
    submission?: string | undefined;
    policy: AutonomyPolicy;
    checkEntries?: string[] | undefined;
  },
) {
  const { projectId, actor, laneId, intentId, submission } = input;
  const request = submission
    ? await landingRow(ctx, { projectId, submissionId: submission })
    : (await laneLandingRequest(ctx, projectId, laneId)).request;
  if (!request || (!submission && (request.phase === 'landed' || request.phase === 'terminal-failed')))
    return null;
  const row = submission ? request : await landingRow(ctx, { projectId, submissionId: request.submissionId });
  if (!row) return null;
  const state = landingStateFromRow(row);
  if (submission) {
    const operationId = state.request.finish?.composeOperationId;
    const selected = operationId
      ? await ctx.db
          .query('projectHostedComposeSelections')
          .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
            q
              .eq('projectId', projectId)
              .eq('actor', state.actor)
              .eq('operationId', operationId)
              .eq('kind', 'inputs')
              .eq('key', laneId),
          )
          .first()
      : null;
    if (!selected) return null;
  }
  const record = await readHostedRecord(ctx, {
    projectId,
    actor,
    kind: 'candidate',
    key: state.request.candidateId,
  });
  if (!record || record.parent !== intentId) return null;
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(record.value));
  if (candidate.result.status !== 'clean' || candidate.result.head !== state.request.expectedHead)
    return null;
  const head = candidate.result.head;
  const [readable, run] = await Promise.all([
    landingMessageForReader(ctx, projectId, state),
    row.runId ? loadHostedCheck(ctx, { projectId, runId: row.runId }, false).then(read => read.run) : null,
  ]);
  const heldForReview =
    state.observation.state === 'pending' && state.observation.pendingReason === 'waiting-for-review';
  const changes = candidate.governance?.paths ?? null;
  const checks: DefinedChecks = [...(run?.check ? [run.check] : []), ...(input.checkEntries ?? [])];
  const matched = protectedPathMatches(input.policy, changes, checks);
  let paths = matched;
  if (heldForReview) {
    paths = null;
    const reason = state.error?.message ?? '';
    const prefix = protectedReasonPrefixes.find(prefix => reason.startsWith(prefix));
    if (prefix && changes) {
      const ambiguous = changes.some(path => path.includes(', ') || path.includes(';'));
      if (!ambiguous && matchesHold(reason, prefix, matched)) paths = matched;
      else {
        // Formatting two names can produce the same sentence as formatting one name with
        // a delimiter. Use the original policy when the sentence cannot confirm current scope.
        const key = { projectId, attemptId: state.attemptId };
        const pinned = await landingAttemptRow(ctx, key);
        if (pinned) {
          const attempt = await loadLandingAttempt(ctx, key, pinned);
          if (
            attempt.submissionId === state.id &&
            attempt.candidate.id === candidate.id &&
            attempt.candidate.head === head
          ) {
            const original = protectedPathMatches(attempt.policy, changes, checks);
            if (matchesHold(reason, prefix, original)) paths = original;
          }
        }
      }
    }
  }
  return {
    submissionId: state.id,
    candidateId: candidate.id,
    base: candidate.base.head,
    head,
    files: record.candidateFiles ?? null,
    summary: (readable.request.message ?? readable.message)?.trim() || null,
    notVerified: state.request.notVerified ?? null,
    check:
      run?.request.expectedHead === head && run.request.candidateId === candidate.id
        ? run.status
        : state.request.check
          ? null
          : ('not-run' as const),
    ...(heldForReview ? { heldForReview: true as const } : {}),
    protection: protection(paths),
  };
}
