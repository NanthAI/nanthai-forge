// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './portable-hash.js';
import { invariant } from './errors.js';
import { sourceJobControlSchema } from './hosted-source-job.js';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const object = z.object({ sha256: hash, size: version }).strict();
const common = { id: z.uuid(), version, at: z.iso.datetime() };
const main = z.object({ head: hash, receiptId: z.string().min(1) }).strict();
export const hostedRecordSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('intent'),
      outcome: z.string().trim().min(1).max(500),
      constraints: z.string().max(4000),
      creatorAccountId: z.string().min(1),
      assigneeAccountIds: z.array(z.string().min(1)),
      base: main,
      status: z.enum(['active', 'ready', 'completed', 'abandoned']),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('lane'),
      intentId: z.uuid(),
      actor: z.string().min(1),
      base: main,
      head: hash,
      sourceVersion: version,
      lifecycleVersion: version,
      state: z.enum(['active', 'completed', 'abandoned']),
      authorityEpoch: version,
      resolution: z
        .object({
          candidateId: z.uuid().nullable(),
          conflicts: object,
          left: hash,
          right: hash,
          draftHead: hash,
          status: z.enum(['pending', 'resolved']),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('save'),
      laneId: z.uuid(),
      actor: z.string().min(1),
      operationId: z.uuid(),
      expectedHead: hash,
      expectedSourceVersion: version,
      head: hash,
      sourceVersion: version,
      changes: object,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('candidate'),
      intentId: z.uuid(),
      base: main,
      // Immutable page roots preserve ordered inputs/dependencies without a growing document.
      inputs: object,
      dependencies: object,
      algorithm: z.string().min(1),
      result: z.discriminatedUnion('status', [
        z.object({ status: z.literal('clean'), head: hash }).strict(),
        z.object({ status: z.literal('conflict'), conflicts: object }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('job'),
      operationId: z.uuid(),
      jobKind: z.enum(['save', 'compose', 'sync', 'register-state']),
      input: object,
      inputDigest: hash,
      authorityEpoch: version,
      attempt: version,
      fence: version,
      status: z.enum(['pending', 'dispatching', 'running', 'completed', 'failed', 'cancelled']),
      executionId: z.string().nullable(),
      output: object.nullable(),
      control: sourceJobControlSchema.optional(),
    })
    .strict(),
]);
export type HostedRecord = z.infer<typeof hostedRecordSchema>;
export type HostedRecordKind = HostedRecord['kind'];
export const hostedRecordRefSchema = z
  .object({
    kind: z.enum(['intent', 'lane', 'save', 'candidate', 'job']),
    key: z.uuid(),
    version,
    digest: hash,
    bytes: version,
  })
  .strict();
export type HostedRecordRef = z.infer<typeof hostedRecordRefSchema>;
export function hostedRecordIndex(record: HostedRecord) {
  switch (record.kind) {
    case 'intent':
      return { parent: record.creatorAccountId, status: record.status };
    case 'lane':
      return { parent: record.intentId, status: record.state };
    case 'save':
      return { parent: record.laneId, status: 'saved' };
    case 'candidate':
      return { parent: record.intentId, status: record.result.status };
    case 'job':
      return { parent: record.operationId, status: record.status };
  }
}
export function hostedRecordRef(record: HostedRecord): HostedRecordRef {
  record = hostedRecordSchema.parse(record);
  return {
    kind: record.kind,
    key: record.id,
    version: record.version,
    digest: digest(canonicalPayload(record)),
    bytes: new TextEncoder().encode(canonicalPayload(record)).length,
  };
}

// Transport windows, never total project/history limits. Callers keep requesting pages.
export const HOSTED_RECORD_PAGE_ROWS = 100;
export const HOSTED_RECORD_PAGE_BYTES = 128 * 1024;
export const recordRefOrder = (ref: HostedRecordRef) =>
  `${ref.kind}\0${ref.key}\0${String(ref.version).padStart(16, '0')}`;
export function snapshotPageBody(refs: HostedRecordRef[]) {
  return canonicalPayload(refs.map(ref => hostedRecordRefSchema.parse(ref)));
}
export const snapshotPageBytes = (refs: HostedRecordRef[]) =>
  new TextEncoder().encode(snapshotPageBody(refs)).length + refs.reduce((total, ref) => total + ref.bytes, 0);
export function* hostedSnapshotPages(refs: Iterable<HostedRecordRef>) {
  let page: HostedRecordRef[] = [];
  for (const ref of refs) {
    const next = [...page, ref];
    if (
      page.length &&
      (next.length > HOSTED_RECORD_PAGE_ROWS || snapshotPageBytes(next) > HOSTED_RECORD_PAGE_BYTES)
    ) {
      yield page;
      page = [];
    }
    page.push(hostedRecordRefSchema.parse(ref));
  }
  if (page.length) yield page;
}
export function validateSnapshotPage(refs: HostedRecordRef[], previousKey: string | null) {
  const body = snapshotPageBody(refs);
  invariant(
    refs.length > 0 &&
      refs.length <= HOSTED_RECORD_PAGE_ROWS &&
      (snapshotPageBytes(refs) <= HOSTED_RECORD_PAGE_BYTES || refs.length === 1),
    'BAD_ARGUMENT',
    'Continue snapshot metadata in bounded transport pages.',
  );
  let key = previousKey;
  for (const ref of refs) {
    const next = recordRefOrder(ref);
    invariant(
      key === null || next > key,
      'WORK_OPERATION_CHANGED',
      'Snapshot references must be unique and ordered across pages.',
    );
    key = next;
  }
  return { body, lastKey: key! };
}
