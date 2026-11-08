// SPDX-License-Identifier: Apache-2.0
import type { LandingIO } from './hosted-landing-client';
import type { LandingRead } from './landing-model';
type Held = Pick<LandingRead, 'request' | 'attempt'>;
/** The exact attempt the owner sees: submission and attempt ids come from the read, never typed. */
export const ownerApprove = (io: LandingIO, read: Held) =>
  io.mutation('projectHostedAcceptance:approve', {
    submissionId: read.request.id,
    attemptId: read.attempt.id,
  });
export const ownerDecline = (io: LandingIO, read: Held, operationId: string, reason: string) =>
  io.mutation('projectHostedOwnerReview:decline', {
    submissionId: read.request.id,
    attemptId: read.attempt.id,
    operationId,
    ...(reason.trim() ? { reason: reason.trim() } : {}),
  });
