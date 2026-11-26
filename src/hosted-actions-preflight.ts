// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { HostedCheckRun } from './hosted-check.js';
import { invariant } from './errors.js';

export const actionsPreflightTicketSchema = z
  .object({
    endpoint: z.url(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ActionsPreflightTicket = z.infer<typeof actionsPreflightTicketSchema>;
/** The fields already covered by the supervisor's ticket, needed to prove
 * authority before a shard-start mutation reads the check record. */
export const actionsPreflightBindingSchema = z
  .object({
    projectId: z.string(),
    id: z.uuid(),
    actor: z.string(),
    request: z.object({ authorityEpoch: z.number().int().nonnegative() }).strict(),
    fence: z.number().int().nonnegative(),
    executionId: z.string().nullable(),
    dispatchKey: z.string().regex(/^[a-f0-9]{64}$/),
    keyId: z.string().regex(/^[A-Z0-9_]+$/),
  })
  .strict();
type ActionsPreflightBinding = z.infer<typeof actionsPreflightBindingSchema>;
export function actionsPreflightBinding(run: HostedCheckRun): ActionsPreflightBinding {
  const { projectId, id, actor, request, fence, executionId, dispatchKey, keyId } = run;
  return {
    projectId,
    id,
    actor,
    request: { authorityEpoch: request.authorityEpoch },
    fence,
    executionId,
    dispatchKey,
    keyId,
  };
}
/** Only the OIDC-authenticated session issues this run-scoped preflight proof.
 * It inherits the run's lifetime/fence; every use rechecks current authority and
 * cancellation. It can record the first shard start and grants no source,
 * results, provider IO or signing authority. */
function signatureFor(run: ActionsPreflightBinding, key: string, domain: string) {
  invariant(key.length, 'RUNNER_UNAVAILABLE', 'Trusted check configuration is unavailable.');
  return bytesToHex(
    hmac(
      sha256,
      utf8ToBytes(key),
      utf8ToBytes(
        canonicalPayload({
          domain,
          projectId: run.projectId,
          runId: run.id,
          actor: run.actor,
          epoch: run.request.authorityEpoch,
          fence: run.fence,
          executionId: run.executionId,
          dispatchKey: run.dispatchKey,
        }),
      ),
    ),
  );
}
export const actionsPreflightSignature = (run: ActionsPreflightBinding, key: string) =>
  signatureFor(run, key, 'forge-actions-preflight-v1');
/** Write-only optional proof capability, separate from the preflight ticket. */
export const landingProofSignature = (run: HostedCheckRun, key: string) =>
  signatureFor(run, key, 'forge-landing-proof-v1');
export function verifyActionsPreflight(run: ActionsPreflightBinding, signature: string, key: string) {
  const expected = actionsPreflightSignature(run, key);
  let difference = expected.length ^ signature.length;
  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ (signature.charCodeAt(index) || 0);
  invariant(!difference, 'EVIDENCE_CHANGED', 'Pre-spawn authorization differs from the original session.');
}
