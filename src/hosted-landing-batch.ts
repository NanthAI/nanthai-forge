// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { governanceReason } from './public-governance.js';
import type { AcceptanceActor, AutonomyPolicy } from './autonomy-policy.js';
import type { HostedRecord } from './hosted-records.js';

/** Transaction/compose window, never an admission limit. Remaining work stays queued. */
export const HOSTED_BATCH_MEMBERS = 8;
/** A train with no member checking holds later deferred entries this long after
 * its newest compose or selection; then the queue drops it and moves on. A healthy
 * compose takes about 90 s; a dead one must never stop the queue. */
export const HOSTED_TRAIN_HOLD_MS = 5 * 60_000;
// Six speculative groups match the observed merge-queue runner capacity while
// bounding wasted checks after a failed predecessor. This is execution width,
// never an admission limit; projects can use their existing concurrency setting.
export const HOSTED_PIPELINE_GROUPS = 6;
export const hostedPipelineWidth = (policy: AutonomyPolicy) =>
  Math.min(policy.checks?.concurrency ?? HOSTED_PIPELINE_GROUPS, 16);
/** Existing automatic-accept projects inherit grouping without a policy rewrite. */
export const hostedBatching = (policy: AutonomyPolicy) =>
  policy.acceptance.mode === 'auto-on-pass' &&
  (policy.acceptance.landing === undefined || policy.acceptance.landing === 'batched');
export const batchComposeSchema = z
  .object({
    members: z.array(z.uuid()).min(1).max(HOSTED_BATCH_MEMBERS),
  })
  .strict();
export const batchDroppedSchema = z
  .array(
    z
      .object({
        candidateId: z.uuid(),
        /** Worker proved this rejection against the outer base, without cohort members. */
        againstMain: z.literal(true).optional(),
        paths: z.array(z.string()).max(10).optional(),
        more: z.number().int().nonnegative().optional(),
        conflicts: z
          .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() })
          .strict(),
      })
      .strict(),
  )
  .max(HOSTED_BATCH_MEMBERS);
export function batchEligible(
  project: { owner: string; visibility?: string },
  policy: AutonomyPolicy,
  actor: AcceptanceActor,
  candidate: Extract<HostedRecord, { kind: 'candidate' }>,
) {
  return (
    actor.kind === 'agent' &&
    actor.id === project.owner &&
    policy.acceptance.mode === 'auto-on-pass' &&
    candidate.result.status === 'clean' &&
    candidate.governance?.ownerInputs === true &&
    governanceReason(project, policy, actor, candidate.governance.paths, true) === null
  );
}

export type BatchDropped = z.infer<typeof batchDroppedSchema>;
