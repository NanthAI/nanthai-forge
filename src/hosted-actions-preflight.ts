// SPDX-License-Identifier: Apache-2.0
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
/** Only the OIDC-authenticated session issues this run-scoped, read-only proof.
 * It inherits the run's lifetime/fence; every use rechecks current authority and
 * cancellation. It grants no source, results, provider IO or signing authority. */
export function actionsPreflightSignature(run: HostedCheckRun, key: string) {
  invariant(key.length, 'RUNNER_UNAVAILABLE', 'Trusted check configuration is unavailable.');
  return bytesToHex(
    hmac(
      sha256,
      utf8ToBytes(key),
      utf8ToBytes(
        canonicalPayload({
          domain: 'forge-actions-preflight-v1',
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
export function verifyActionsPreflight(run: HostedCheckRun, signature: string, key: string) {
  const expected = actionsPreflightSignature(run, key);
  let difference = expected.length ^ signature.length;
  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ (signature.charCodeAt(index) || 0);
  invariant(!difference, 'EVIDENCE_CHANGED', 'Pre-spawn authorization differs from the original session.');
}
