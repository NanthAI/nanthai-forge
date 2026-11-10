// SPDX-License-Identifier: Apache-2.0
import { needsFixSchema } from './culprit-bisect.js';
import { semanticPayload } from './semantic-payload.js';
import { semanticPlanSchema } from './intent-semantic-conflict.js';
import { intentTestContractSchema } from './intent-test-contract.js';
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import { sourceJobControlSchema } from './hosted-source-job.js';
import { docsMergeSchema } from './docs-resolution.js';
import { planningItemSchema, planningCommentSchema } from './work-planning-types.js';

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
      needsFix: needsFixSchema.optional(),
      recoveryRunId: z.uuid().optional(),
      testContracts: z.array(intentTestContractSchema).optional(),
      outcome: z.string().trim().min(1).max(500),
      constraints: z.string().max(4000),
      creatorAccountId: z.string().min(1),
      assigneeAccountIds: z.array(z.string().min(1)),
      /** A receipt means a hosted Lane pinned this Intent's execution; hosted paths then own its status.
       * An Intent copied from the Work journal has no receipt (web Intents), or no base before any Lane. */
      base: z
        .object({ head: hash, receiptId: z.string().min(1).optional() })
        .strict()
        .optional(),
      status: z.enum(['proposed', 'active', 'ready', 'completed', 'abandoned']),
      /** The journal Intent's other attributes, kept verbatim (flip 5); notes and lifecycle are records. */
      journal: z.looseObject({}).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('lane'),
      restoreBase: hash.optional(),
      stack: z
        .object({
          laneId: z.uuid(),
          head: hash,
          entryId: z.uuid().optional(),
          detached: z.boolean().optional(),
        })
        .strict()
        .optional(),
      intentId: z.uuid(),
      actor: z.string().min(1),
      base: main,
      head: hash,
      sourceVersion: version,
      lifecycleVersion: version,
      state: z.enum(['active', 'completed', 'abandoned']),
      /** Owner pin: cleanup (complete-merged, completeOnAccept, prune, cache GC) never completes or deletes it. Absent when unpinned. */
      pinned: z.literal(true).optional(),
      authorityEpoch: version,
      revert: z.object({ receiptId: z.uuid(), previous: hash, accepted: hash }).strict().optional(),
      resolution: z
        .object({
          candidateId: z.uuid().nullable(),
          conflicts: object,
          left: hash,
          right: hash,
          draftHead: hash,
          mergeBase: hash.optional(),
          /** The conflicted Lane this resolves; landing the resolution completes it at this exact source. */
          origin: z.object({ laneId: z.uuid(), head: hash, sourceVersion: version }).strict().optional(),
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
      durationMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('candidate'),
      governance: z
        .object({ version: z.literal(1), paths: z.array(z.string()), ownerInputs: z.boolean() })
        .strict()
        .optional(),
      semanticPlan: semanticPlanSchema.optional(),
      /** Markdown-only conflicts the compose merged with native finish's docs rule. */
      docs: docsMergeSchema.optional(),
      intentId: z.uuid(),
      base: main,
      // Immutable page roots preserve ordered inputs/dependencies without a growing document.
      inputs: object,
      dependencies: object,
      algorithm: z.string().min(1),
      result: z.discriminatedUnion('status', [
        z.object({ status: z.literal('clean'), head: hash }).strict(),
        z
          .object({
            status: z.literal('conflict'),
            conflicts: object,
          })
          .strict(),
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
  // Flip 5 Work store: one Issue or Initiative version (its planning version) and one insert-only
  // comment (a planning comment or an Intent note; an Issue id is also its Intent id). The journal
  // row is kept exactly as its schema reads it, so a copy compares by digest.
  z
    .object({
      id: z.uuid(),
      version,
      at: z.string().min(1),
      kind: z.literal('issue'),
      item: planningItemSchema,
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      version: z.literal(0),
      at: z.string().min(1),
      kind: z.literal('comment'),
      parent: z.uuid(),
      /** Note order within its Intent; planning comments order by `at`. */
      position: version,
      comment: planningCommentSchema.optional(),
      // The full note schema lives in work-types, which imports modules that import this one; the
      // Work store mapper (work-store-records) validates a note with it before it is encoded here.
      note: z
        .looseObject({ kind: z.enum(['comment', 'decision']), text: z.string(), at: z.string() })
        .optional(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      version: z.literal(0),
      at: z.string().min(1),
      kind: z.literal('lifecycle'),
      /** The Intent whose status moved; position is the move's order within it. */
      parent: z.uuid(),
      position: version,
      entry: z.looseObject({ from: z.string(), to: z.string(), at: z.string() }),
    })
    .strict(),
]);
export type HostedRecord = z.infer<typeof hostedRecordSchema>;
export type HostedRecordKind = HostedRecord['kind'];
export const hostedRecordRefSchema = z
  .object({
    kind: z.enum(['intent', 'lane', 'save', 'candidate', 'job', 'issue', 'comment', 'lifecycle']),
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
      // A journal-owned Intent (no Lane pinned it) keeps its status apart, so head-only readers of hosted
      // execution state (Issue states, completion) never take a planning status for one.
      return {
        parent: record.creatorAccountId,
        status: record.base?.receiptId ? record.status : `journal:${record.status}`,
      };
    case 'lane':
      return { parent: record.intentId, status: record.state, ...(record.pinned ? { pinned: true } : {}) };
    case 'save':
      return { parent: record.laneId, status: 'saved' };
    case 'candidate':
      return { parent: record.intentId, status: record.result.status };
    case 'job':
      return { parent: record.operationId, status: record.status };
    case 'issue':
      return { parent: record.item.initiativeId ?? '', status: record.item.status };
    case 'comment':
      // Notes and planning comments share an Issue's id as parent; the status keeps the two pages apart.
      return { parent: record.parent, status: record.note ? 'note' : 'comment' };
    case 'lifecycle':
      return { parent: record.parent, status: record.entry.to };
  }
}
/** Validate and encode once when both the body and its immutable reference are needed. */
export function hostedRecordValue(input: unknown) {
  const record = hostedRecordSchema.parse(input),
    value = semanticPayload(record, true);
  const ref: HostedRecordRef = {
    kind: record.kind,
    key: record.id,
    version: record.version,
    digest: digest(value),
    bytes: new TextEncoder().encode(value).length,
  };
  return { record, value, ref };
}
export function hostedRecordRef(record: HostedRecord): HostedRecordRef {
  return hostedRecordValue(record).ref;
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
