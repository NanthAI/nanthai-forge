import { editRecordProjection } from './work-record-edit.js';
import type { z } from 'zod';
import { landingPositions, prepareLandingRecords } from './landing-records-index.js';
import { finishChild } from './finish-child.js';
import { invariant } from './errors.js';
// SPDX-License-Identifier: Apache-2.0
import { readFragment } from './work-records.js';
import { batchPrefixSchema, landingEntrySchema, landingBatchSchema } from './landing-batch-types.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

export type LandingRecordSelection = {
  selectedOnly?: boolean;
  entries?: string[];
  batches?: string[];
  runs?: string[];
  views?: string[];
  checks?: string[];
};
const writable = ['landingEntries', 'landingBatches', 'views', 'runs'] as const;
/** A pinned queue projection, not a portable Work snapshot. Historical Lane
 * conversations, saves and unrelated runs cannot delay queue admission/settlement.
 * Header status only selects records; every selected record is fully validated. */
export function landingRecords(
  store: WorkStore,
  channel?: string,
  tx = store.readRecords?.(),
  selectedId?: string,
  selection: LandingRecordSelection = {},
) {
  if (!tx) return store.load();
  const data = tx.data();
  const batchPositions = new Set(
    landingPositions(
      store,
      tx,
      'landingBatches',
      selection.selectedOnly ? [] : ['composing', 'checking'],
      channel,
    ),
  );
  for (const id of [...(selection.batches ?? []), ...(selectedId ? [selectedId] : [])])
    for (const position of tx.positions('landingBatches', id)) batchPositions.add(position);
  for (const id of [...(selection.entries ?? []), ...(selectedId ? [selectedId] : [])]) {
    const entry = tx.find('landingEntries', id)?.record;
    if (entry?.batchId)
      for (const position of tx.positions('landingBatches', entry.batchId)) batchPositions.add(position);
  }
  data.landingBatches = [...batchPositions]
    .sort((a, b) => a - b)
    .map(position => tx.at('landingBatches', position));
  const included = new Set([
    ...data.landingBatches.flatMap(batch => batch.entryIds),
    ...(selection.entries ?? []),
    ...(selectedId ? [selectedId] : []),
  ]);
  const entryPositions = new Set(
    landingPositions(
      store,
      tx,
      'landingEntries',
      selection.selectedOnly ? [] : ['queued', 'checking', 'awaiting-review'],
      channel,
    ),
  );
  for (const id of included)
    for (const position of tx.positions('landingEntries', id)) entryPositions.add(position);
  data.landingEntries = [...entryPositions]
    .sort((a, b) => a - b)
    .flatMap(position => {
      const entry = tx.at('landingEntries', position);
      if (channel !== undefined && entry.channel !== channel) return [];
      if (included.has(entry.id) || ['queued', 'checking', 'awaiting-review'].includes(entry.status))
        return [entry];
      return [];
    });
  data.checks = [
    ...new Set([...data.landingEntries.map(entry => entry.checkId), ...(selection.checks ?? [])]),
  ].flatMap(id => tx.find('checks', id)?.record ?? []);
  const views = new Set([
    ...(selection.views ?? []),
    ...data.landingEntries.map(entry => entry.viewId),
    ...data.landingBatches.flatMap(batch => batch.prefixes.map(prefix => prefix.viewId)),
  ]);
  data.views = [...views].flatMap(id => tx.find('views', id)?.record ?? []);
  data.lanes = [...new Set(data.views.flatMap(view => view.inputs.map(pin => pin.laneId)))].flatMap(
    id => tx.find('lanes', id)?.record ?? [],
  );
  data.runs = [
    ...new Set([
      ...(selection.runs ?? []),
      ...data.landingEntries.flatMap(entry => (entry.runId ? [entry.runId] : [])),
      ...data.landingBatches.flatMap(batch => batch.prefixes.map(prefix => prefix.runId)),
      ...(channel === undefined && !selection.selectedOnly
        ? ['queued', 'preparing', 'running'].flatMap(status =>
            tx.all('runs', status, 'status').map(run => run.id),
          )
        : []),
    ]),
  ].flatMap(id => tx.find('runs', id)?.record ?? []);
  const moves = new Map<number, WorkData['channelMoves'][number]>();
  const channels =
    channel === undefined
      ? [
          ...new Set([
            ...data.landingEntries.map(entry => entry.channel),
            ...data.landingBatches.map(batch => batch.channel),
          ]),
        ]
      : [channel];
  for (const name of channels)
    for (const position of tx.positions('channelMoves', name, 'channel').reverse()) {
      const move = tx.at('channelMoves', position);
      if (move.status === 'accepted') {
        moves.set(position, move);
        break;
      }
    }
  // Recover exact receipts even if later main moves overtook a lost reply.
  for (const batch of data.landingBatches)
    for (const prefix of batch.prefixes) {
      const receipt = tx.find('channelMoves', finishChild(batch.id, `accept:${prefix.viewId}`));
      if (receipt) moves.set(receipt.position, receipt.record);
    }
  data.channelMoves = [...moves].sort(([a], [b]) => a - b).map(([, move]) => move);
  return data;
}

function selectedObservation<T>(schema: z.ZodType<T>, fields: unknown): T {
  const parsed = schema.safeParse(fields);
  invariant(parsed.success, 'INVALID_WORK_STORE', 'Selected landing header is invalid.');
  return parsed.data;
}
const entryObservation = landingEntrySchema.pick({
  id: true,
  channel: true,
  status: true,
  checkId: true,
  viewId: true,
  runId: true,
  arrivedAt: true,
  waitingFor: true,
});
const batchObservation = landingBatchSchema.pick({ id: true, channel: true, status: true });
/** Scheduling needs no prefix histories, Lane saves, Views or run evidence.
 * Select scalar headers and validate them afresh on every observation. */
export async function observeLandingQueue(store: WorkStore, channel?: string) {
  const tx = store.readRecords?.();
  if (!tx) return landingRecords(store, channel);
  try {
    await prepareLandingRecords(store, tx);
    const landingEntries = landingPositions(store, tx, 'landingEntries', ['queued', 'checking'], channel).map(
      position =>
        selectedObservation(
          entryObservation,
          readFragment(store.directory, tx.versionAt('landingEntries', position)).fields,
        ),
    );
    const landingBatches = landingPositions(
      store,
      tx,
      'landingBatches',
      ['composing', 'checking'],
      channel,
    ).map(position =>
      selectedObservation(
        batchObservation,
        readFragment(store.directory, tx.versionAt('landingBatches', position)).fields,
      ),
    );
    const checks = [...new Set(landingEntries.map(entry => entry.checkId))].flatMap(
      id => tx.find('checks', id)?.record ?? [],
    );
    const runs =
      channel === undefined
        ? ['queued', 'preparing', 'running'].flatMap(status => tx.all('runs', status, 'status'))
        : [];
    return { revision: tx.revision, landingEntries, landingBatches, checks, runs };
  } finally {
    tx.dispose();
  }
}

/** Prepare only changed queue records outside the writer lock, then publish
 * under the driver fence and exact-pointer CAS. Never save a projection as whole Work. */
export function editLandingRecords<T>(
  store: WorkStore,
  channel: string | undefined,
  edit: (data: WorkData) => T,
  tx: WorkRecordTransaction,
  selectedId: string,
  beforePublish?: () => void,
  selection: LandingRecordSelection = {},
  underLock = false,
) {
  const data = landingRecords(store, channel, tx, selectedId, selection);
  return editRecordProjection(
    store,
    tx,
    data,
    writable,
    current => {
      const result = edit(current);
      const expanded =
        Number(current.schema) >= 19 || current.landingBatches?.some(batch => batch.entryIds.length > 4);
      current.schema = (
        Number(current.schema) >= 21
          ? current.schema
          : [16, 18, 20].includes(Number(current.schema))
            ? expanded
              ? 20
              : 18
            : expanded
              ? 19
              : 17
      ) as WorkData['schema'];
      return result;
    },
    beforePublish,
    underLock,
  );
}

/** Locate a runner's exact prefix without hydrating completed diagnoses or Work.
 * The nested lookup is advisory location only; validate the retained prefix. */
export function landingCheckPrefix(store: WorkStore, viewId: string) {
  const tx = store.readRecords?.();
  if (!tx)
    return store
      .load()
      .landingBatches?.flatMap(batch => batch.prefixes)
      .find(prefix => prefix.viewId === viewId);
  for (let position = 0; position < (tx.manifest.collections.landingBatches?.count ?? 0); position++) {
    const header = readFragment(store.directory, tx.versionAt('landingBatches', position));
    const prefix = header.arrays.prefixes?.lookup
      ? tx.fieldFind('landingBatches', String(header.fields.id), 'prefixes', viewId, 'viewId')
      : tx.at('landingBatches', position).prefixes.find(item => item.viewId === viewId);
    if (prefix) {
      const parsed = batchPrefixSchema.safeParse(prefix);
      invariant(parsed.success, 'INVALID_WORK_STORE', 'Selected landing prefix is invalid.');
      return parsed.data;
    }
  }
  return undefined;
}
