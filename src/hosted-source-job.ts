// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './portable-hash.js';
import { invariant } from './errors.js';

export const jobHash = z.string().regex(/^[0-9a-f]{64}$/);
export const jobNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const jobObject = z.object({ sha256: jobHash, size: jobNumber }).strict();
export const sourceJobControlSchema = z
  .object({
    actor: z.string().min(1),
    provider: z.string().min(1),
    worker: z.string().min(1),
    runtime: jobHash,
    keyId: z.string().regex(/^[A-Z0-9_]+$/),
    dispatchKey: jobHash,
    dispatch: z.enum(['unstarted', 'ambiguous', 'accepted', 'rejected']),
    dispatches: jobNumber,
    recoveryUsed: z.boolean(),
    emptyLookups: z.array(z.uuid()).max(2),
    lease: z.object({ owner: z.uuid(), token: jobNumber, until: jobNumber }).strict().nullable(),
    workerLeaseMs: jobNumber.refine(n => n > 0),
    workerUntil: jobNumber,
    heartbeat: jobNumber,
    callbackDigest: jobHash.nullable(),
    providerReservation: z.object({ input: jobHash, token: z.uuid() }).strict().optional(),
    failureCode: z.string().nullable(),
  })
  .strict();
export type SourceJobControl = z.infer<typeof sourceJobControlSchema>;

/** Signed by the trusted source process, never project code. No source bytes,
 * source URLs, account credentials or arbitrary output claims cross this seam. */
export const sourceJobCallbackSchema = z
  .object({
    schema: z.literal(1),
    projectId: z.string().min(1),
    jobId: z.uuid(),
    operationId: z.uuid(),
    attempt: jobNumber,
    fence: jobNumber,
    authorityEpoch: jobNumber,
    inputDigest: jobHash,
    provider: z.string().min(1),
    worker: z.string().min(1),
    runtime: jobHash,
    executionId: z.string().min(1),
    result: z.discriminatedUnion('status', [
      z.object({ status: z.literal('completed'), output: jobObject }).strict(),
      z.object({ status: z.literal('failed'), code: z.string().min(1) }).strict(),
      z.object({ status: z.literal('heartbeat'), sequence: jobNumber }).strict(),
    ]),
  })
  .strict();
export type SourceJobCallback = z.infer<typeof sourceJobCallbackSchema>;
export function signSourceJobCallback(callback: SourceJobCallback, secret: string) {
  invariant(secret.length > 0, 'SOURCE_WORKER_UNAVAILABLE', 'Trusted source callback key is unavailable.');
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(canonicalPayload(callback))));
}
export function verifySourceJobCallback(callback: SourceJobCallback, signature: string, secret: string) {
  const expected = signSourceJobCallback(callback, secret);
  let difference = expected.length ^ signature.length;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
  invariant(difference === 0, 'SOURCE_CALLBACK_INVALID', 'Trusted source callback signature is invalid.');
}
export const sourceDispatchKey = (projectId: string, jobId: string, operationId: string) =>
  digest(canonicalPayload({ projectId, jobId, operationId }));

export type SourceDispatch = {
  schema: 1;
  projectId: string;
  jobId: string;
  operationId: string;
  jobKind: 'save' | 'compose' | 'sync' | 'register-state';
  attempt: number;
  fence: number;
  authorityEpoch: number;
  input: z.infer<typeof jobObject>;
  inputDigest: string;
  provider: string;
  worker: string;
  runtime: string;
  dispatchKey: string;
};
export type SourceDispatchResult =
  { status: 'accepted'; executionId: string } | { status: 'rejected' } | { status: 'unknown' };
export type SourceLookup =
  { status: 'found'; executionId: string } | { status: 'empty'; authoritative: true } | { status: 'unknown' };
/** Adapters must submit idempotently by dispatchKey, including concurrent/lost
 * replies. An eventually consistent empty search is UNKNOWN, never authoritative
 * absence. Adapters may not retry a non-idempotent paid request underneath this API. */
export interface SourceJobProvider {
  readonly id: string;
  dispatch(input: SourceDispatch): Promise<SourceDispatchResult>;
  lookup(input: SourceDispatch): Promise<SourceLookup>;
}
