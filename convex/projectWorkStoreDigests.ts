// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Compact, independently maintained journal fingerprints. These are disposable index metadata, not Work.
import { writeFingerprint as put } from './projectWorkStoreFingerprintWrites';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { hostedRecordValue } from '../src/hosted-records';
import { journalRow, workStoreRecord, type WorkStoreSource } from '../src/work-store-records';
import { record as indexed } from './projectWorkIndexStore';
import { hostedRecordBody, recordHead, recordVersion } from './projectHostedRecords';

const sourceCollection = (collection: string) => `_workStoreDigests:${collection}`;
const headsCollection = (kind: string) => `_workStoreHeads:${kind}`;
export const workReadDigest = (value: unknown) => digest(canonicalPayload(value));
type Identity = { id?: string; version?: number; intentId?: string; index?: number };

/** Updated in the same transaction as each journal projection, before a compare can observe it. */
export async function fingerprintSource(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
  owner: string,
  collection: string,
  key: string,
  position: number,
  value: unknown,
) {
  const source = collection === 'planningItems' ? 'planningVersions' : (collection as WorkStoreSource);
  const head = source === 'intents' ? await recordHead(ctx, projectId, 'intent', key) : null;
  let encoded;
  try {
    encoded = hostedRecordValue(workStoreRecord(source, value, { owner, version: head?.version ?? 0 }));
  } catch {
    await put(ctx, projectId, partition, sourceCollection(collection), key, position, { key, invalid: true });
    return;
  }
  const raw = value as Identity;
  const identity = Object.fromEntries(
    ['id', 'version', 'intentId', 'index']
      .filter(name => raw[name as keyof Identity] !== undefined)
      .map(name => [name, raw[name as keyof Identity]]),
  );
  const actual = await recordVersion(ctx, projectId, encoded.ref.kind, encoded.ref.key, encoded.ref.version);
  await put(ctx, projectId, partition, sourceCollection(collection), key, position, {
    key,
    ref: encoded.ref,
    ...(actual
      ? {
          stored: {
            ref: {
              kind: actual.kind,
              key: actual.key,
              version: actual.version,
              digest: actual.digest,
              bytes: actual.bytes,
            },
            ...(actual.workReadDigest === undefined ? {} : { readDigest: actual.workReadDigest }),
          },
        }
      : {}),
    identity,
    ...(collection === 'intents' ? {} : { readDigest: workReadDigest(value) }),
  });
  return encoded.record;
}

/** A compact head pointer, kept with ordinary store writes. Seeding it never rewrites the head/body. */
export async function fingerprintHead(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
  head: Doc<'projectHostedRecordHeads'>,
) {
  const row = await ctx.db.get(head.recordId);
  if (!row) return;
  let readDigest = row.workReadDigest;
  const hosted = head.kind === 'intent' && !head.status.startsWith('journal:');
  if (readDigest === undefined && ['issue', 'comment', 'lifecycle'].includes(head.kind)) {
    const value = journalRow(JSON.parse(await hostedRecordBody(ctx, row)));
    readDigest = workReadDigest(value);
    await ctx.db.patch(row._id, { workReadDigest: readDigest });
  }
  await put(ctx, projectId, partition, headsCollection(head.kind), head.key, head._creationTime, {
    key: head.key,
    ref: {
      kind: row.kind,
      key: row.key,
      version: row.version,
      digest: row.digest,
      bytes: row.bytes,
    },
    ...(readDigest === undefined ? {} : { readDigest }),
    ...(hosted ? { hosted: true } : {}),
  });
}

/** A completed bounded baseline covers this floor and every subsequent ordinary write. */
export async function fingerprintCoverage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  floor: number,
  complete: boolean,
  sampleSize: number,
) {
  const old = await indexed(ctx, partition, '_workStoreDigestCoverage', collection);
  const cached = old ? JSON.parse(old.value) : null;
  const prior = cached?.invalidated ? null : cached;
  await put(ctx, projectId, partition, '_workStoreDigestCoverage', collection, 0, {
    floor: Math.min(prior?.floor ?? floor, floor),
    complete: complete || prior?.complete === true,
    sampleSize: Math.max(prior?.sampleSize ?? 0, sampleSize),
  });
}
