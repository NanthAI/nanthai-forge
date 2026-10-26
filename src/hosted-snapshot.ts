// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './portable-hash.js';
import { snapshotPageBody, type HostedRecordRef } from './hosted-records.js';
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const hostedSnapshotPlanSchema = z
  .object({
    projectId: z.string().min(1),
    actor: z.string().min(1),
    operationId: z.uuid(),
    snapshotId: z.uuid(),
    authorityEpoch: number,
    expectedSnapshotId: z.uuid().nullable(),
    journalSequence: number,
    seedCheckpoint: z.object({ sha256: hash, size: number }).strict(),
    source: z.object({ head: hash, receiptId: z.string().min(1) }).strict(),
    pageCount: number,
    recordCount: number,
    root: hash,
  })
  .strict();
export const HOSTED_SNAPSHOT_EMPTY_ROOT = digest('forge-hosted-snapshot-v1');
export const hostedSnapshotPageRoot = (previousRoot: string, page: number, refs: HostedRecordRef[]) =>
  digest(canonicalPayload({ previousRoot, page, body: snapshotPageBody(refs) }));
