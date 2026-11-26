// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { invariant } from '../src/errors';
import { hostedLandingAttemptSchema, type HostedLandingAttempt } from '../src/hosted-landing';

type Check = NonNullable<HostedLandingAttempt['check']>;
type AttemptValue = { value: string; boundCheck?: Check };

// The original deferred pins also explain where a failed exact check came from.
// This association lives only as long as the hydrated attempt.
export const deferredPins = new WeakMap<HostedLandingAttempt, HostedLandingAttempt>();
export function withBoundCheck(attempt: HostedLandingAttempt, check: Check): HostedLandingAttempt {
  invariant(
    attempt.deferredCheck && !attempt.check && attempt.candidate.head,
    'WORK_OPERATION_CHANGED',
    'Only the first exact check can bind deferred landing pins.',
  );
  const { deferredCheck: _deferred, ...pins } = attempt;
  void _deferred;
  const bound = { ...pins, check };
  deferredPins.set(bound, attempt);
  return bound;
}

export function landingAttemptValue(row: AttemptValue, validate = false): HostedLandingAttempt {
  const value = JSON.parse(row.value) as HostedLandingAttempt;
  const attempt = validate ? hostedLandingAttemptSchema.parse(value) : value;
  if (row.boundCheck === undefined) return attempt;
  const check = validate
    ? hostedLandingAttemptSchema.shape.check.unwrap().parse(row.boundCheck)
    : row.boundCheck;
  return withBoundCheck(attempt, check);
}
