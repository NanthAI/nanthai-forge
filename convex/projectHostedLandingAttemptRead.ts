// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { capsuleAttempt } from './projectLandingCapsuleStore';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import { deferredPins, landingAttemptValue } from './projectHostedLandingAttemptValue';
import { invariant } from '../src/errors';
import { HOSTED_PLATFORM_RETRIES } from '../src/hosted-landing-admission';
import { LANDINGS_ATTEMPTS } from '../src/hosted-landings-view';

/** The earliest attempt pins shared by the queue view and landing receipts. */
export const landingAttemptPrefix = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, submissionId: string) =>
  ctx.db
    .query('projectHostedLandingAttempts')
    .withIndex('by_project_and_submission_and_number', q =>
      q.eq('projectId', projectId).eq('submissionId', submissionId),
    )
    .order('asc')
    .take(LANDINGS_ATTEMPTS);
export const landingAttemptRow = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; attemptId: string },
) =>
  ctx.db
    .query('projectHostedLandingAttempts')
    .withIndex('by_project_and_attempt', q =>
      q.eq('projectId', input.projectId).eq('attemptId', input.attemptId),
    )
    .unique();
// Immutable pins may be read repeatedly while one bounded cohort transition
// installs or invalidates attempts. Progress remains a fresh separate row read.
// The cache is scoped to this invocation, never authority or a later event.
const attemptPins = new WeakMap<QueryCtx | MutationCtx, Map<string, HostedLandingAttempt>>();
export function pinsFor(ctx: QueryCtx | MutationCtx) {
  let pins = attemptPins.get(ctx);
  if (!pins) attemptPins.set(ctx, (pins = new Map()));
  return pins;
}
export async function loadLandingAttempt(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; attemptId: string },
  known?: Doc<'projectHostedLandingAttempts'> | null,
) {
  const pins = pinsFor(ctx),
    key = `${input.projectId}:${input.attemptId}`;
  const retained = pins.get(key);
  if (retained) return retained;
  const row = known === undefined ? await landingAttemptRow(ctx, input) : known;
  if (!row) {
    const stored = await capsuleAttempt(ctx, input);
    invariant(stored, 'SOURCE_UNAVAILABLE', 'The original landing attempt is unavailable.');
    pins.set(key, stored);
    return stored;
  }
  const attempt = landingAttemptValue(row, true);
  invariant(
    attempt.projectId === row.projectId &&
      attempt.id === row.attemptId &&
      attempt.submissionId === row.submissionId &&
      attempt.number === row.number,
    'SOURCE_UNAVAILABLE',
    'Landing attempt identity differs from its record.',
  );
  pins.set(key, attempt);
  return attempt;
}

/** The deferred attempt an exact check came from (Item 687d1eda): its nearest deferred parent,
 * past the platform retries of that same check (each one a child of the previous check attempt,
 * at most HOSTED_PLATFORM_RETRIES), or null. A deferred attempt may itself carry a retry count
 * (the stale-check re-queue keeps it), so the walk stops at the first deferred parent and only
 * continues upward from a retry. Failure path only: at most three attempt reads. */
export async function deferredOrigin(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  attempt: HostedLandingAttempt,
) {
  let current = attempt;
  for (let hop = 0; hop <= HOSTED_PLATFORM_RETRIES; hop++) {
    const own = deferredPins.get(current);
    if (own) return own;
    if (!current.parentAttemptId) break;
    const parent = await loadLandingAttempt(ctx, { projectId, attemptId: current.parentAttemptId });
    if (parent.deferredCheck && !parent.check) return parent;
    if (!current.platformRetries) return null;
    current = parent;
  }
  return null;
}
