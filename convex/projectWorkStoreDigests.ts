// SPDX-License-Identifier: Apache-2.0
// Compact, independently maintained journal fingerprints. These are disposable index metadata, not Work.
import { writeFingerprint as put } from './projectWorkStoreFingerprintWrites';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { hostedRecordValue, type HostedRecordRef } from '../src/hosted-records';
import { journalRow, workStoreRecord, type WorkStoreSource } from '../src/work-store-records';
import { record as indexed } from './projectWorkIndexStore';
import { recordHead, recordVersion, hostedRecordBody } from './projectHostedRecords';
import { storeReadOf, sameValue } from './projectWorkStoreReads';

const sourceCollection = (collection: string) => `_workStoreDigests:${collection}`;
const headsCollection = (kind: string) => `_workStoreHeads:${kind}`;
export const workReadDigest = (value: unknown) => digest(canonicalPayload(value));
type Identity = { id?: string; version?: number; intentId?: string; index?: number };
type Fingerprint = {
  key: string;
  ref: HostedRecordRef;
  identity: Identity;
  readDigest?: string;
  hosted?: boolean;
  invalid?: boolean;
  stored?: { ref: HostedRecordRef; readDigest?: string };
};

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

/** Equal fingerprints open no journal values, head values or immutable bodies. Full reads diagnose mismatches. */
export async function compareFingerprints(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  cursor: string | null,
  newest: number,
) {
  const readSources: Record<string, string> = {
    readItems: 'planningItems',
    readVersions: 'planningVersions',
    readComments: 'planningComments',
    readNotes: 'notes',
    readLifecycle: 'lifecycle',
  };
  const source = readSources[collection] ?? collection;
  const coverage = await indexed(ctx, partition, '_workStoreDigestCoverage', source);
  const tally = () => ({ count: 0, keys: [] as string[] });
  const missing = tally(),
    different = tally(),
    invalid = tally();
  const add = (bucket: ReturnType<typeof tally>, key: string) => {
    bucket.count++;
    if (bucket.keys.length < 20) bucket.keys.push(key);
  };
  if (!coverage) return null;
  const window = JSON.parse(coverage.value);
  if (window.invalidated || (!window.complete && newest > window.sampleSize)) return null;
  const cacheCollection = source === 'issueHeads' ? headsCollection('issue') : sourceCollection(source);
  const page = await ctx.db
    .query('projectWorkRecords')
    .withIndex('by_generation_and_collection_and_position', q =>
      q.eq('generationId', partition).eq('collection', cacheCollection).gte('position', window.floor),
    )
    .order('desc')
    .paginate({ cursor, numItems: Math.min(newest, 100), maximumBytesRead: 500000 });
  let checked = 0,
    matched = 0,
    hosted = 0;
  for (const item of page.page) {
    const expected = JSON.parse(item.value) as Fingerprint;
    checked++;
    if (expected.invalid) {
      add(invalid, expected.key);
      continue;
    }
    let ref = expected.ref;
    if (source === 'issueHeads') {
      const journal = await indexed(ctx, partition, sourceCollection('planningItems'), expected.key);
      if (!journal) {
        // A bounded source baseline can omit an older Issue that the target head window includes.
        // Missing hash metadata is a mismatch to diagnose, never evidence that the Issue is absent.
        const original = await indexed(ctx, partition, 'planningItems', expected.key);
        if (!original) add(missing, expected.key);
        else if (JSON.parse(original.value).version !== ref.version) add(different, expected.key);
        else matched++;
        continue;
      }
      ref = (JSON.parse(journal.value) as Fingerprint).ref;
    }
    const current =
      ['planningItems', 'intents', 'issueHeads'].includes(source) ||
      (collection in readSources && source !== 'planningVersions')
        ? await indexed(ctx, partition, headsCollection(ref.kind), ref.key)
        : null;
    let pointer = current ? (JSON.parse(current.value) as Fingerprint) : null;
    if (
      (['planningItems', 'intents', 'issueHeads'].includes(source) ||
        (collection in readSources && source !== 'planningVersions')) &&
      !pointer
    ) {
      const head = await recordHead(ctx, projectId, ref.kind, ref.key);
      const row = head ? await ctx.db.get(head.recordId) : null;
      if (!head || !row) {
        add(missing, expected.key);
        continue;
      }
      pointer = {
        key: head.key,
        identity: expected.identity,
        ref: {
          kind: row.kind,
          key: row.key,
          version: row.version,
          digest: row.digest,
          bytes: row.bytes,
        },
        ...(head.kind === 'intent' && !head.status.startsWith('journal:') ? { hosted: true } : {}),
      };
    }
    if (source === 'intents' && pointer?.hosted) {
      hosted++;
      continue;
    }
    // These are independently recorded target hashes, captured only from a successful immutable
    // version write. Source fingerprints remain independent, including failed dual writes.
    const cached = pointer ? { ref: pointer.ref, readDigest: pointer.readDigest } : expected.stored;
    const actual = cached
      ? { ...cached.ref, workReadDigest: cached.readDigest }
      : await recordVersion(ctx, projectId, ref.kind, ref.key, pointer?.ref.version ?? ref.version);
    if (!actual) {
      add(missing, expected.key);
      continue;
    }
    const equal =
      actual.version === ref.version &&
      actual.digest === ref.digest &&
      actual.bytes === ref.bytes &&
      (!(collection in readSources) || expected.readDigest === actual.workReadDigest);
    if (equal) {
      matched++;
      continue;
    }
    // Only differences pay to open the source payload/reader and verify its retained body.
    const original = await indexed(
      ctx,
      partition,
      source === 'issueHeads' ? 'planningItems' : source,
      expected.key,
    );
    if (original && collection in readSources) {
      try {
        const value = await storeReadOf(ctx, projectId, source as 'notes', expected.identity);
        if (value === null) add(missing, expected.key);
        else if (sameValue(value, JSON.parse(original.value))) {
          // Old immutable versions may predate reader-hash metadata. The verified full reader is
          // authoritative; absent or stale derived metadata is not a source difference.
          matched++;
          continue;
        }
      } catch {
        add(invalid, expected.key);
      }
    } else {
      try {
        const row = await recordVersion(ctx, projectId, ref.kind, ref.key, actual.version);
        if (row) await hostedRecordBody(ctx, row);
      } catch {
        add(invalid, expected.key);
      }
    }
    add(different, expected.key);
  }
  if (page.isDone && checked < newest && !window.complete)
    add(invalid, `${source}:digest-baseline-too-small`);
  return {
    checked,
    matched,
    ...(source === 'issueHeads' || collection in readSources ? {} : { hosted }),
    missing,
    different,
    invalid,
    cursor: page.isDone ? null : page.continueCursor,
  };
}
