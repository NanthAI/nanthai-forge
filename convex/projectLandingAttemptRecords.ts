// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { landingAttemptValue } from './projectHostedLandingAttemptValue';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { invariant } from '../src/errors';
import { hostedLandingProgressSchema } from '../src/hosted-landing';
import { sanitizeFailureMessage } from './projectFailureLog';
import { readMetricAttemptPins } from './projectMetricReadProjection';

type AttemptRow = Doc<'projectHostedLandingAttempts'>;
const PAGE_ROWS = 16;
const PAGE_BYTES = 48 * 1024;
const ATTEMPT_KIND = 'projectHostedLandingAttempts';

function attemptRecord(row: AttemptRow, detail = false) {
  const attempt = landingAttemptValue(row);
  const { parentAttemptId, number } = attempt;
  const progress = row.progress ? hostedLandingProgressSchema.parse(JSON.parse(row.progress)) : null;
  invariant(
    attempt.projectId === row.projectId &&
      attempt.submissionId === row.submissionId &&
      attempt.id === row.attemptId &&
      attempt.number === row.number,
    'SOURCE_UNAVAILABLE',
    'Landing attempt identity differs from its record.',
  );
  return {
    id: attempt.id,
    submissionId: attempt.submissionId,
    parentAttemptId,
    number,
    at: attempt.at,
    main: attempt.main,
    candidate: { id: attempt.candidate.id, head: attempt.candidate.head },
    runId: attempt.check?.runId ?? null,
    ...(detail ? { check: attempt.check } : {}),
    checkCause: attempt.checkCause ?? null,
    recheckReason: attempt.recheckReason ?? null,
    scopedFallback: attempt.scopedFallback ?? null,
    forkReason: attempt.forkReason ?? null,
    platformRetries: attempt.platformRetries ?? null,
    deferredCheck: attempt.deferredCheck ?? null,
    progress: progress
      ? {
          phase: progress.phase,
          timing: progress.timing ?? null,
          settled: progress.settled,
          errorCode: progress.error?.code ?? null,
          ...(detail && progress.error
            ? { errorMessage: sanitizeFailureMessage(progress.error.message) }
            : {}),
          receiptId: progress.acceptance?.receiptId ?? null,
        }
      : null,
    replay: row.replay ?? null,
  };
}

function retainedRecord(row: Doc<'projectFinishReadRows'>) {
  const pins = readMetricAttemptPins(row);
  const { selection, inputPin: _inputPin, ...facts } = pins;
  void _inputPin;
  invariant(
    selection.projectId === row.projectId &&
      pins.id === row.attemptId &&
      pins.submissionId === row.submissionId,
    'SOURCE_UNAVAILABLE',
    'Retained landing attempt identity differs from its record.',
  );
  return { ...facts, number: selection.number, candidateHead: selection.candidateHead, retained: true };
}

/** One requested page, with no per-attempt joins or capsule hydration. */
export async function landingAttemptRecords(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  selection: {
    collection: 'landing-attempts' | 'retained-landing-attempts';
    parentId?: string | undefined;
    id?: string | undefined;
    cursor: string | null;
  },
) {
  const project = await accessibleProject(ctx, projectId, actor);
  invariant(
    await readProjectRole(ctx, project, actor),
    'NOT_FOUND',
    'Hosted landing attempt records are unavailable.',
  );
  const { collection, id, parentId, cursor } = selection;
  const options = { cursor, numItems: PAGE_ROWS, maximumRowsRead: PAGE_ROWS, maximumBytesRead: PAGE_BYTES };
  if (id !== undefined) {
    const row = await ctx.db
      .query(ATTEMPT_KIND)
      .withIndex('by_project_and_attempt', q => q.eq('projectId', projectId).eq('attemptId', id))
      .unique();
    if (row) return { collection, record: attemptRecord(row, true) };
    const retained = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_attempt', q =>
        q.eq('kind', ATTEMPT_KIND).eq('projectId', projectId).eq('attemptId', id),
      )
      .unique();
    invariant(retained, 'NOT_FOUND', 'Hosted landing attempt record not found on this project.');
    return { collection, record: retainedRecord(retained) };
  }
  if (collection === 'retained-landing-attempts') {
    const rows = ctx.db.query('projectFinishReadRows');
    const range = parentId
      ? rows.withIndex('by_kind_and_project_and_submission', q =>
          q.eq('kind', ATTEMPT_KIND).eq('projectId', projectId).eq('submissionId', parentId),
        )
      : rows.withIndex('by_kind_and_project_and_source_time', q =>
          q.eq('kind', ATTEMPT_KIND).eq('projectId', projectId),
        );
    const page = await range.order('desc').paginate(options);
    return {
      collection,
      items: page.page.map(retainedRecord),
      nextCursor: page.isDone ? null : page.continueCursor,
      coverage:
        'Indexed attempt facts, including relocated rows. Submission attempt history has more detail.',
    };
  }
  const rows = ctx.db.query(ATTEMPT_KIND);
  const range = parentId
    ? rows.withIndex('by_project_and_submission_and_number', q =>
        q.eq('projectId', projectId).eq('submissionId', parentId),
      )
    : rows.withIndex('by_project', q => q.eq('projectId', projectId));
  const page = await range.order('desc').paginate(options);
  return {
    collection,
    items: page.page.map(row => attemptRecord(row)),
    nextCursor: page.isDone ? null : page.continueCursor,
    coverage: 'Live attempt rows. Use retained-landing-attempts for indexed facts including relocated rows.',
  };
}
