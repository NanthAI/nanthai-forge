// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { directResultSchema } from './hosted-actions-direct.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { HostedCheckRun } from './hosted-check.js';
import { invariant } from './errors.js';

// Same metadata window as the direct HTTP result path. Pages stay below a Convex string value.
export const resultSlotBytes = 512 * 1024;
export const resultPageBytes = 768 * 1024;
export const resultBatchIndex = -2;
export const resultEnvelopeSchema = z
  .object({
    result: directResultSchema,
    packed: z.literal(true).optional(),
    logBytes: z
      .string()
      .max(Math.ceil((64 * 1024) / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .optional(),
  })
  .strict();
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;
const putTarget = z.object({ url: z.url(), headers: z.record(z.string(), z.string()) });
const legacyResultBatchTargetsSchema = z
  .object({
    slots: z
      .array(
        z.object({
          put: putTarget,
          get: z.url(),
          head: z.url(),
          log: z.object({ put: putTarget, get: z.url() }),
        }),
      )
      .min(1),
    list: z.url(),
    coordinator: z.object({ put: putTarget, get: z.url() }),
  })
  .strict();
export const resultBatchTargetsSchema = z.union([
  z
    .object({
      packed: z.literal(true),
      slots: z.array(z.object({ put: putTarget, get: z.url(), head: z.url() })).min(1),
      coordinator: z.object({ put: putTarget, get: z.url() }),
    })
    .strict(),
  legacyResultBatchTargetsSchema,
]);
export type ResultBatchTargets = z.infer<typeof resultBatchTargetsSchema>;
export const resultBatchPrefix = (run: HostedCheckRun) =>
  `v1/p/${run.projectId}/check-results/${run.id}/${run.fence}/${run.executionId}/`;
export const resultSlotKey = (run: HostedCheckRun, index: number | 'coordinator' | `log-${number}`) =>
  `${resultBatchPrefix(run)}${index}`;

/** An immutable slot is the original supervisor result. Lost PUT replies compare exact bytes. */
export async function uploadResultSlot(
  target: { put: { url: string; headers: Record<string, string> }; get: string },
  body: string,
  request: (url: string, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
) {
  const response = await request(target.put.url, {
    method: 'PUT',
    headers: target.put.headers,
    body,
    signal: signal ?? null,
    redirect: 'error',
  });
  if (response.status === 412) {
    const prior = await request(target.get, { signal: signal ?? null, redirect: 'error' });
    invariant(
      prior.ok &&
        (await readResultSlot(prior, new TextEncoder().encode(body).length > resultSlotBytes)) === body,
      'WORK_OPERATION_CHANGED',
      'Retry the original immutable shard result.',
    );
    return false;
  }
  invariant(response.ok, 'R2_VERIFY_FAILED', 'Result upload failed.');
  await response.body?.cancel();
  return true;
}
/** Bound the stream, even when the storage service omits or lies about Content-Length. */
export async function readResultSlot(response: Response, packed = false) {
  invariant(response.body, 'R2_VERIFY_FAILED', 'Result bytes are unavailable.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > resultSlotBytes + (packed ? Math.ceil((64 * 1024) / 3) * 4 + 64 : 0)) {
      await reader.cancel();
      invariant(false, 'BAD_ARGUMENT', 'Result exceeds the existing metadata window.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export const resultEnvelopeBody = (envelope: ResultEnvelope) => {
  const body = canonicalPayload(resultEnvelopeSchema.parse(envelope));
  invariant(
    new TextEncoder().encode(body).length <=
      resultSlotBytes + (envelope.packed ? Math.ceil((64 * 1024) / 3) * 4 + 64 : 0) &&
      new TextEncoder().encode(canonicalPayload(envelope.result)).length <= resultSlotBytes,
    'BAD_ARGUMENT',
    'Result exceeds the existing metadata window.',
  );
  return body;
};

/** One discovery pass over required slots only. Each shard owns its marker bytes, so a lost
 * create reply can reconcile without letting a different shard send a second notification.
 * `request` retries infrastructure failures with the same immutable request. The signed
 * workflow completion remains recovery if the elected supervisor dies before notifying. */
export async function notifyPackedResultBatch(
  targets: Extract<ResultBatchTargets, { packed: true }>,
  index: number,
  request: (url: string, init?: RequestInit) => Promise<Response>,
  notify: () => Promise<unknown>,
) {
  for (let other = 0; other < targets.slots.length; other++) {
    if (other === index) continue;
    const response = await request(targets.slots[other]!.head, { method: 'HEAD', redirect: 'error' });
    await response.body?.cancel();
    if (response.status === 404) return;
    invariant(response.ok, 'R2_VERIFY_FAILED', 'Read required result inbox membership.');
  }
  const body = `collect:${index}`;
  const response = await request(targets.coordinator.put.url, {
    method: 'PUT',
    headers: targets.coordinator.put.headers,
    body,
    redirect: 'error',
  });
  await response.body?.cancel();
  invariant(response.ok || response.status === 412, 'R2_VERIFY_FAILED', 'Elect the result collector.');
  if (response.status === 412) {
    const prior = await request(targets.coordinator.get, { redirect: 'error' });
    invariant(prior.ok, 'R2_VERIFY_FAILED', 'Read the result collector election.');
    if ((await readResultSlot(prior)) !== body) return;
  }
  await notify();
}
