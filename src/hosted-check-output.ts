// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { checkHash, checkNumber, checkObject, checkPin, type HostedCheckRun } from './hosted-check.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';

export const outputStreamSchema = z
  .object({
    identity: checkHash.optional(),
    kind: z.enum(['summary', 'local-log']).optional(),
    expiresAt: z.number().finite().optional(),
    shard: checkNumber,
    attempt: checkNumber,
    executionId: z.string().min(1),
    stream: z.enum(['stdout', 'stderr', 'artifact']),
    // Portable, collector-redacted display name; never used as an object-store path.
    name: z.string(),
  })
  .strict();
export type OutputStream = z.infer<typeof outputStreamSchema>;
export const outputChunkSchema = z
  .object({
    stream: outputStreamSchema,
    sequence: checkNumber,
    offset: checkNumber,
    object: checkObject.refine(o => o.size > 0),
  })
  .strict();
export type OutputChunk = z.infer<typeof outputChunkSchema>;
export const outputSealSchema = z
  .object({
    stream: outputStreamSchema,
    chunks: checkNumber,
    bytes: checkNumber,
    sha256: checkHash,
    failureSummary: z.string().max(4096).optional(),
  })
  .strict();
export type OutputSeal = z.infer<typeof outputSealSchema>;
export const outputRootSchema = z
  .object({
    schema: z.literal(1),
    runId: z.uuid(),
    executionId: z.string().min(1),
    revision: checkNumber,
    chain: checkHash,
    streams: checkNumber,
    chunks: checkNumber,
    bytes: checkNumber,
  })
  .strict();
export type OutputRoot = z.infer<typeof outputRootSchema>;
export const outputMessageSchema = z
  .object({
    schema: z.literal(1),
    projectId: z.string().min(1),
    runId: z.uuid(),
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    fence: checkNumber,
    executionId: z.string().min(1),
    head: checkHash,
    planDigest: checkHash,
    body: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('chunk'), chunk: outputChunkSchema }).strict(),
      z.object({ kind: z.literal('seal'), seal: outputSealSchema }).strict(),
      z.object({ kind: z.literal('final'), root: outputRootSchema }).strict(),
    ]),
  })
  .strict();
export type OutputMessage = z.infer<typeof outputMessageSchema>;
export function outputMessage(run: HostedCheckRun, body: OutputMessage['body']): OutputMessage {
  return outputMessageSchema.parse({
    schema: 1,
    projectId: run.projectId,
    runId: run.id,
    operationId: run.request.operationId,
    authorityEpoch: run.request.authorityEpoch,
    fence: run.fence,
    executionId: run.executionId,
    head: run.request.expectedHead,
    planDigest: run.planDigest,
    body,
  });
}
export function signOutput(message: OutputMessage, secret: string) {
  invariant(secret.length > 0, 'RUNNER_UNAVAILABLE', 'Trusted output key is unavailable.');
  return bytesToHex(
    hmac(
      sha256,
      utf8ToBytes(secret),
      utf8ToBytes(
        canonicalPayload({
          domain: 'forge-hosted-check-output-v1',
          message: outputMessageSchema.parse(message),
        }),
      ),
    ),
  );
}
export function verifyOutput(message: OutputMessage, signature: string, secret: string) {
  const expected = signOutput(message, secret);
  let difference = expected.length ^ signature.length;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
  invariant(difference === 0, 'EVIDENCE_CHANGED', 'Trusted output signature is invalid.');
}
export const outputStreamId = (stream: OutputStream) => checkPin(outputStreamSchema.parse(stream));
export const outputInitialChain = checkPin({ domain: 'forge-hosted-check-output-index-v1' });
export const outputRootObject = (root: OutputRoot) => {
  const bytes = utf8ToBytes(canonicalPayload(outputRootSchema.parse(root)));
  return { sha256: bytesToHex(sha256(bytes)), size: bytes.length };
};
/** Separate namespace: check output is never project source/object authority. */
export function outputKey(projectId: string, runId: string, pin: { sha256: string }) {
  return `v1/p/${projectId}/checks/${runId}/${pin.sha256}`;
}
export const outputMessageObject = (message: OutputMessage) =>
  message.body.kind === 'chunk'
    ? message.body.chunk.object
    : message.body.kind === 'final'
      ? outputRootObject(message.body.root)
      : null;
