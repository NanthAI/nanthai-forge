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
/** Batches are an opt-in optimisation (`acceptance.landing: 'batched'`). By
 * default each eligible entry checks alone at the head of the queue. */
export const hostedBatching = (policy: AutonomyPolicy) => policy.acceptance.landing === 'batched';
export const batchComposeSchema = z
  .object({
    members: z.array(z.uuid()).min(2).max(HOSTED_BATCH_MEMBERS),
  })
  .strict();
export const batchDroppedSchema = z
  .array(
    z
      .object({
        candidateId: z.uuid(),
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
