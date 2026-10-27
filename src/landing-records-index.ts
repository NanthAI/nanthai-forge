import { assertLandingWorkerActive } from './landing-worker-context.js';
// SPDX-License-Identifier: Apache-2.0
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { readFragment, readCollection, pageHashes, pageSize } from './work-records.js';
import { landingEntrySchema, landingBatchSchema } from './landing-batch-types.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

type Header = {
  id: string;
  channel: string;
  status: string;
  alreadyOnMain?: unknown;
  keepOpen?: unknown;
  acceptanceId?: unknown;
  entryIds?: string[];
  runIds?: string[];
};
type Selection = { pages: string; headers: Map<string, Header>; positions: Map<string, number[]> };
const snapshots = new WeakMap<WorkStore, Map<string, Selection>>();
/** An advisory secondary index over immutable headers, compatible with existing
 * stores. Retain only the current collection's hashes; selected records are always
 * read and schema-validated afresh. Cold/revised indexes can be built cooperatively. */
function* selection(
  store: WorkStore,
  tx: WorkRecordTransaction,
  collection: 'landingEntries' | 'landingBatches',
) {
  let cache = snapshots.get(store);
  if (!cache) snapshots.set(store, (cache = new Map()));
  const index = tx.manifest.collections[collection],
    pages = JSON.stringify([index?.count ?? 0, index?.pages ?? []]);
  const previous = cache.get(collection);
  if (previous?.pages === pages) return previous;
  const headers = new Map<string, Header>(),
    positions = new Map<string, number[]>();
  const add = (key: string, position: number) => {
    const found = positions.get(key) ?? [];
    found.push(position);
    positions.set(key, found);
  };
  let position = 0;
  for (const page of index?.pages ?? []) {
    const hashes = pageHashes(store.directory, page);
    invariant(
      hashes.length === Math.min(pageSize, index!.count - position),
      'INVALID_WORK_STORE',
      'Work collection page is incomplete.',
    );
    for (const hash of hashes) {
      let header = previous?.headers.get(hash);
      if (!header) {
        const fragment = readFragment(store.directory, hash),
          fields = fragment.fields;
        const entryIds =
          collection === 'landingBatches' && fragment.arrays.entryIds
            ? readCollection(
                store.directory,
                fragment.arrays.entryIds,
                0,
                fragment.arrays.entryIds.count,
                true,
              ).records
            : [];
        invariant(
          entryIds.every(id => typeof id === 'string'),
          'INVALID_WORK_STORE',
          'Landing entry membership is invalid.',
        );
        invariant(
          ['id', 'channel', 'status'].every(key => typeof fields[key] === 'string'),
          'INVALID_WORK_STORE',
          'Landing selection header is invalid.',
        );
        invariant(
          (collection === 'landingEntries' ? landingEntrySchema : landingBatchSchema).shape.status.safeParse(
            fields.status,
          ).success,
          'INVALID_WORK_STORE',
          'Landing status is invalid.',
        );
        const runIds: string[] = [];
        if (collection === 'landingBatches')
          for (const page of fragment.arrays.prefixes?.pages ?? []) {
            for (const prefixHash of pageHashes(store.directory, page)) {
              const prefix = readFragment(store.directory, prefixHash).fields;
              invariant(
                typeof prefix.runId === 'string',
                'INVALID_WORK_STORE',
                'Landing prefix run identity is invalid.',
              );
              runIds.push(prefix.runId);
              yield;
            }
          }
        header = {
          id: fields.id as string,
          channel: fields.channel as string,
          status: fields.status as string,
          alreadyOnMain: fields.alreadyOnMain,
          keepOpen: fields.keepOpen,
          acceptanceId: fields.acceptanceId,
          entryIds: entryIds as string[],
          runIds,
        };
      }
      headers.set(hash, header);
      add(JSON.stringify(['status', header.status]), position);
      add(JSON.stringify(['channel', header.channel, header.status]), position);
      if (typeof header.acceptanceId === 'string')
        add(JSON.stringify(['acceptanceId', header.acceptanceId]), position);
      for (const id of header.entryIds ?? []) add(JSON.stringify(['entryId', id]), position);
      for (const id of header.runIds ?? []) add(JSON.stringify(['runId', id]), position);
      if (header.alreadyOnMain && !header.keepOpen) add('completion', position);
      position++;
      yield;
    }
  }
  const current = { pages, headers, positions };
  cache.set(collection, current);
  return current;
}
export async function prepareLandingRecords(store: WorkStore, tx: WorkRecordTransaction) {
  let turn = performance.now();
  for (const collection of ['landingEntries', 'landingBatches'] as const) {
    const build = selection(store, tx, collection);
    for (let next = build.next(); !next.done; next = build.next()) {
      if (performance.now() - turn < 8) continue;
      await yieldTurn();
      assertLandingWorkerActive();
      turn = performance.now();
    }
  }
}
export function landingPositions(
  store: WorkStore,
  tx: WorkRecordTransaction,
  collection: 'landingEntries' | 'landingBatches',
  statuses: string[],
  channel?: string,
  completions = false,
) {
  const build = selection(store, tx, collection);
  let next = build.next();
  while (!next.done) next = build.next();
  const index = next.value;
  return [
    ...new Set([
      ...statuses.flatMap(
        status =>
          index.positions.get(
            JSON.stringify(channel === undefined ? ['status', status] : ['channel', channel, status]),
          ) ?? [],
      ),
      ...(completions ? (index.positions.get('completion') ?? []) : []),
    ]),
  ].sort((a, b) => a - b);
}

/** Selected history membership from the same disposable immutable-header index. */
export function landingMatch(
  store: WorkStore,
  tx: WorkRecordTransaction,
  collection: 'landingEntries' | 'landingBatches',
  field: 'entryId' | 'acceptanceId' | 'runId',
  value: string,
) {
  const build = selection(store, tx, collection);
  let next = build.next();
  while (!next.done) next = build.next();
  return next.value.positions.get(JSON.stringify([field, value])) ?? [];
}

/** A worker and its execution adapter share the same owner's disposable index. */
export function shareLandingRecords(source: WorkStore, target: WorkStore) {
  invariant(source.directory === target.directory, 'INVALID_WORK_STORE', 'Landing index owner differs.');
  const retained = snapshots.get(source);
  if (retained) snapshots.set(target, retained);
}
export function landingRunBatch(
  store: WorkStore,
  tx: WorkRecordTransaction,
  runId: string,
  viewId: string,
  head: string,
) {
  for (const position of landingMatch(store, tx, 'landingBatches', 'runId', runId)) {
    const batch = tx.at('landingBatches', position);
    if (
      batch.prefixes.some(
        prefix => prefix.runId === runId && prefix.viewId === viewId && prefix.head === head,
      )
    )
      return batch;
  }
}
