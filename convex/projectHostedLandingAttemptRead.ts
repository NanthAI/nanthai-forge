// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hostedLandingAttemptSchema, type HostedLandingAttempt } from '../src/hosted-landing';
import { invariant } from '../src/errors';
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
) {
  const pins = pinsFor(ctx),
    key = `${input.projectId}:${input.attemptId}`;
  const retained = pins.get(key);
  if (retained) return retained;
  const row = await landingAttemptRow(ctx, input);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original landing attempt is unavailable.');
  const attempt = hostedLandingAttemptSchema.parse(JSON.parse(row.value));
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
