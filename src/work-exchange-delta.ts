// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import {
  recordIdentity,
  recordKey,
  recordMap,
  recordMetadata,
  recordReferences,
  recordAttributes,
  readRecord,
  type WorkRecordRoot,
  type RecordPin,
} from './work-exchange-records.js';
import { workSchema, type WorkData } from './work-types.js';
import { workSourcePins } from './work-archive-metadata.js';
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const workDeltaSchema = z
  .object({
    kind: z.literal('forge-work-delta'),
    schema: z.literal(2),
    base: z
      .object({
        root: hash,
        work: hash,
        revision: z.number().safe().nonnegative(),
        journalRevision: z.number().safe().nonnegative(),
      })
      .strict(),
    result: hash,
    changes: z.array(
      z
        .object({ collection: z.string(), key: z.string(), previous: hash.nullable(), next: hash.nullable() })
        .strict(),
    ),
  })
  .strict();
export type WorkDelta = z.infer<typeof workDeltaSchema>;
/** An optimization budget; exceeding it selects the complete compatibility path. */
export const WORK_DELTA_BYTES = 4 * 1024 * 1024;
export function supportsWorkDelta(before: WorkRecordRoot, after: WorkRecordRoot) {
  const old = new Map(before.fields.map(field => [field.name, field]));
  for (const field of after.fields) {
    const prior = old.get(field.name);
    old.delete(field.name);
    if ('records' in field) {
      if (!Object.hasOwn(workSchema.shape, field.name) || (prior && !('records' in prior))) return false;
      // Existing positional indexes support append/replacement directly. A
      // reordered or inserted history uses complete reconstruction instead.
      if (
        prior &&
        'records' in prior &&
        prior.records.some((record, i) => field.records[i]?.key !== record.key)
      )
        return false;
    } else if (
      !['schema', 'revision', 'nativeHead'].includes(field.name) &&
      JSON.stringify(field) !== JSON.stringify(prior)
    )
      return false;
  }
  return old.size === 0 && recordMetadata(before).schema === recordMetadata(after).schema;
}
export const workRecordChanges = (before: WorkRecordRoot, after: WorkRecordRoot) => {
  const old = recordMap(before),
    next = recordMap(after);
  const changes: WorkDelta['changes'] = [];
  for (const [id, { collection, record }] of old) {
    const value = next.get(id)?.record;
    if (value?.sha256 !== record.sha256)
      changes.push({ collection, key: record.key, previous: record.sha256, next: value?.sha256 ?? null });
  }
  for (const [id, { collection, record }] of next)
    if (!old.has(id)) changes.push({ collection, key: record.key, previous: null, next: record.sha256 });
  return changes;
};
export function buildWorkDelta(
  before: WorkRecordRoot,
  after: WorkRecordRoot,
  root: string,
  journalRevision = before.revision,
) {
  const delta: WorkDelta = {
    kind: 'forge-work-delta',
    schema: 2,
    base: { root, work: before.work.sha256, revision: before.revision, journalRevision },
    result: after.work.sha256,
    changes: workRecordChanges(before, after),
  };
  return Buffer.byteLength(JSON.stringify(delta)) <= WORK_DELTA_BYTES ? delta : undefined;
}
export function validateWorkDelta(
  before: WorkRecordRoot,
  after: WorkRecordRoot,
  input: unknown,
  baseline: { root: string; revision?: number },
) {
  const parsed = workDeltaSchema.safeParse(input);
  invariant(parsed.success, 'INVALID_WORK_BACKUP', 'Work record delta has an invalid shape.');
  const delta = parsed.data;
  invariant(
    delta.base.root === baseline.root &&
      delta.base.work === before.work.sha256 &&
      delta.base.revision === before.revision &&
      (baseline.revision === undefined || delta.base.journalRevision === baseline.revision),
    'WORK_STALE',
    'Work record delta names a different hosted baseline.',
  );
  invariant(
    delta.result === after.work.sha256,
    'INVALID_WORK_BACKUP',
    'Work delta result differs from the checkpoint.',
  );
  const expected = workRecordChanges(before, after);
  invariant(
    JSON.stringify(expected) === JSON.stringify(delta.changes),
    'INVALID_WORK_BACKUP',
    'Work delta omits a change or has a bad prior hash.',
  );
  // References of unchanged records are authenticated by the previously verified
  // record root. Scan their small descriptors for inbound edges on removals.
  const next = recordMap(after);
  const old = recordMap(before);
  for (const [id, { record }] of next)
    if (old.get(id)?.record.sha256 === record.sha256)
      invariant(
        JSON.stringify(record) === JSON.stringify(old.get(id)!.record),
        'INVALID_WORK_BACKUP',
        'Unchanged Work record has changed reference metadata.',
      );
  for (const change of delta.changes)
    if (change.next === null)
      for (const { record } of next.values())
        invariant(
          !record.refs.some(
            ref => recordIdentity(ref.collection, ref.key) === recordIdentity(change.collection, change.key),
          ),
          'INVALID_WORK_BACKUP',
          'A removed Work record still has inbound references.',
        );
  return delta;
}
export function partialWork(
  root: WorkRecordRoot,
  records: { collection: string; value: Record<string, unknown> }[],
) {
  const parsed = workSchema.safeParse({ intents: [], lanes: [], views: [], ...recordMetadata(root) });
  invariant(parsed.success, 'INVALID_WORK_BACKUP', 'Work record metadata has an invalid shape.');
  const data = parsed.data;
  for (const { collection, value } of records)
    ((data as unknown as Record<string, unknown[]>)[collection] ??= []).push(value);
  return data;
}
export async function validateChangedRecords(
  before: WorkRecordRoot,
  after: WorkRecordRoot,
  changes: WorkDelta['changes'],
  read: (pin: { sha256: string; size: number }) => Promise<Buffer>,
  sourcePins: Set<string>,
) {
  const old = recordMap(before),
    next = recordMap(after);
  const previous: { collection: string; value: Record<string, unknown> }[] = [],
    current: typeof previous = [];
  let validated = 0;
  for (const change of changes) {
    const id = recordIdentity(change.collection, change.key),
      record = next.get(id)?.record;
    if (old.has(id))
      previous.push({
        collection: change.collection,
        value: await readRecord(old.get(id)!.record, read, change.collection),
      });
    if (!record) continue;
    const value = await readRecord(record, read, change.collection),
      refs = recordReferences(change.collection, value);
    invariant(
      JSON.stringify(refs) === JSON.stringify(record.refs),
      'INVALID_WORK_BACKUP',
      'Changed Work record has incorrect reference pins.',
    );
    const attributes = recordAttributes(change.collection, value);
    invariant(
      record.status === attributes.status && record.channel === attributes.channel,
      'INVALID_WORK_BACKUP',
      'Changed Work record has incorrect summary pins.',
    );
    for (const ref of refs)
      invariant(
        next.has(recordIdentity(ref.collection, ref.key)),
        'INVALID_WORK_BACKUP',
        'Changed Work record has a dangling reference.',
      );
    current.push({ collection: change.collection, value });
    validated++;
  }
  const candidate = partialWork(after, current),
    prior = partialWork(before, previous);
  invariant(
    workSchema.safeParse(candidate).success,
    'INVALID_WORK_BACKUP',
    'Changed Work records require their versioned format.',
  );
  const sourceRecords = [...current],
    selected = new Set(
      current.map(item => recordIdentity(item.collection, recordKey(item.value, item.collection)!)),
    );
  for (let cursor = 0; cursor < sourceRecords.length; cursor++) {
    const item = sourceRecords[cursor]!,
      record = next.get(recordIdentity(item.collection, recordKey(item.value, item.collection)!))!.record;
    for (const ref of record.refs) {
      const id = recordIdentity(ref.collection, ref.key);
      if (selected.has(id)) continue;
      selected.add(id);
      const target = next.get(id);
      invariant(target, 'INVALID_WORK_BACKUP', 'Work record reference is unavailable.');
      sourceRecords.push({
        collection: ref.collection,
        value: await readRecord(target.record, read, ref.collection),
      });
    }
  }
  const context = partialWork(after, sourceRecords);
  const lanes = new Map(context.lanes.map(lane => [lane.id, lane]));
  const views = new Map(context.views.map(view => [view.id, view]));
  for (const view of candidate.views) {
    for (const input of view.inputs)
      invariant(
        lanes.get(input.laneId)?.intentId === view.intentId,
        'INVALID_WORK_BACKUP',
        'A changed View input belongs to another Intent.',
      );
    for (const dependency of view.dependencies ?? [])
      if (dependency.kind === 'view')
        invariant(
          views.get(dependency.viewId)?.head === dependency.head,
          'INVALID_WORK_BACKUP',
          'A changed View dependency differs from its pinned head.',
        );
  }
  for (const run of candidate.runs)
    invariant(
      views.get(run.viewId)?.head === run.head,
      'INVALID_WORK_BACKUP',
      'A changed check run differs from its pinned View.',
    );
  for (const move of candidate.channelMoves)
    if (move.status === 'accepted')
      invariant(
        views.get(move.viewId)?.status === 'clean' && views.get(move.viewId)?.head === move.head,
        'INVALID_WORK_BACKUP',
        'A changed Channel receipt differs from its clean View.',
      );
  for (const head of workSourcePins(context))
    invariant(sourcePins.has(head), 'INVALID_WORK_BACKUP', 'Changed Work record names unavailable source.');
  return { current: candidate, previous: prior, validated };
}
export function applyWorkDelta(
  before: WorkData,
  after: WorkRecordRoot,
  changed: Map<string, Record<string, unknown>>,
) {
  const old = new Map<string, Record<string, unknown>>();
  for (const [collection, items] of Object.entries(before))
    if (Array.isArray(items))
      for (const item of items) old.set(recordIdentity(collection, recordKey(item, collection)!), item);
  return Object.fromEntries(
    after.fields.map(field => [
      field.name,
      'value' in field
        ? field.value
        : field.records.map(record => {
            const id = recordIdentity(field.name, record.key),
              value = changed.get(id) ?? old.get(id);
            invariant(value, 'INVALID_WORK_BACKUP', 'Work delta omits record bytes.');
            return value;
          }),
    ]),
  ) as WorkData;
}
export function changedRecordPins(root: WorkRecordRoot, delta: WorkDelta): RecordPin[] {
  const records = recordMap(root);
  return delta.changes.flatMap(change =>
    change.next ? [records.get(recordIdentity(change.collection, change.key))!.record] : [],
  );
}
