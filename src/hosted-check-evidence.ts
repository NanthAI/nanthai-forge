// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalPayload } from './hosted-source-operation.js';
import {
  checkHash,
  checkNumber,
  checkObject,
  hostedCheckCostSchema,
  hostedCheckTerminal,
  type HostedCheckRun,
} from './hosted-check.js';
import { invariant } from './errors.js';

export const hostedCheckShardSchema = z
  .object({
    index: checkNumber,
    attempt: checkNumber,
    executionId: z.string().min(1),
    status: z.enum(['running', 'passed', 'failed', 'cancelled', 'interrupted']),
    exitCode: z.number().int().nullable(),
    output: checkObject.nullable(),
  })
  .strict();
export const hostedCheckCallbackSchema = z
  .object({
    schema: z.literal(1),
    eventId: z.uuid(),
    projectId: z.string().min(1),
    runId: z.uuid(),
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    fence: checkNumber,
    provider: z.enum(['modal', 'github-actions', 'mac']),
    executionId: z.string().min(1),
    head: checkHash,
    definition: checkHash,
    configuration: checkHash,
    environmentFingerprint: checkHash,
    runtime: checkHash,
    planDigest: checkHash,
    lockfile: checkHash,
    selection: checkObject,
    result: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('shard'), shard: hostedCheckShardSchema }).strict(),
      z
        .object({
          kind: z.literal('complete'),
          status: z.enum(['passed', 'failed', 'cancelled', 'interrupted', 'runner-unavailable', 'unknown']),
          exitCode: z.number().int().nullable(),
          output: checkObject.nullable(),
          cost: hostedCheckCostSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export type HostedCheckCallback = z.infer<typeof hostedCheckCallbackSchema>;
export function signHostedCheckCallback(callback: HostedCheckCallback, secret: string) {
  invariant(secret.length > 0, 'RUNNER_UNAVAILABLE', 'Trusted check callback key is unavailable.');
  return bytesToHex(
    hmac(
      sha256,
      utf8ToBytes(secret),
      utf8ToBytes(
        canonicalPayload({
          domain: 'forge-hosted-check-provider-v1',
          callback,
        }),
      ),
    ),
  );
}
export function verifyHostedCheckCallback(callback: HostedCheckCallback, signature: string, secret: string) {
  const expected = signHostedCheckCallback(callback, secret);
  let difference = expected.length ^ signature.length;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
  invariant(difference === 0, 'EVIDENCE_CHANGED', 'Trusted provider signature is invalid.');
}
export function exactHostedCheckEvidence(
  run: HostedCheckRun,
  pins: {
    candidateId: string;
    head: string;
    checkId: string;
    definition: string;
    configuration: string;
    environment: string;
    authorityEpoch: number;
  },
) {
  const r = run.request;
  invariant(
    hostedCheckTerminal(run) &&
      run.status === 'passed' &&
      run.terminalDigest &&
      run.executionId &&
      run.plan &&
      run.counts.completed === run.plan.shardCount &&
      run.counts.passed === run.plan.shardCount &&
      run.counts.failed === 0 &&
      run.exitCode === 0 &&
      r.candidateId === pins.candidateId &&
      r.expectedHead === pins.head &&
      r.checkId === pins.checkId &&
      r.expectedDefinition === pins.definition &&
      r.expectedConfiguration === pins.configuration &&
      r.expectedEnvironment === pins.environment &&
      r.authorityEpoch === pins.authorityEpoch,
    'EVIDENCE_CHANGED',
    'A passing provider run for these exact Candidate, definition, environment and authority pins is required.',
  );
  return run;
}
