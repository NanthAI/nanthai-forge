// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { checkNumber, checkPin } from './hosted-check.js';
import { invariant } from './errors.js';

export const hostedMacRuntime = checkPin({ kind: 'forge-mac-runner', version: 1 });
export const macHeartbeatSchema = z
  .object({
    projectId: z.string().min(1),
    runId: z.uuid(),
    eventId: z.uuid(),
    owner: z.uuid(),
    token: checkNumber,
    fence: checkNumber,
  })
  .strict();
export type MacHeartbeat = z.infer<typeof macHeartbeatSchema>;
export function signMacHeartbeat(value: MacHeartbeat, key: string) {
  invariant(key.length, 'RUNNER_UNAVAILABLE', 'Trusted runner callback key is unavailable.');
  return bytesToHex(
    hmac(
      sha256,
      utf8ToBytes(key),
      utf8ToBytes(
        canonicalPayload({
          domain: 'forge-mac-runner-heartbeat-v1',
          callback: macHeartbeatSchema.parse(value),
        }),
      ),
    ),
  );
}
export function verifyMacHeartbeat(value: MacHeartbeat, signature: string, key: string) {
  const expected = signMacHeartbeat(value, key);
  let difference = expected.length ^ signature.length;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
  invariant(!difference, 'EVIDENCE_CHANGED', 'Trusted runner heartbeat signature is invalid.');
}
