import { finishChild } from './finish-child.js';
import { invariant } from './errors.js';
// SPDX-License-Identifier: Apache-2.0
import { readFragment, pageHashes, pageSize } from './work-records.js';
import { landingBatchSchema, landingEntrySchema, batchPrefixSchema } from './landing-batch-types.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

const writable = ['landingEntries', 'landingBatches', 'views', 'runs'] as const;
// Only scalar scheduling hints are cached by immutable record hash. Selected
// records are still read/validated afresh; retain just the current snapshot's keys.
const headerCache = new WeakMap<WorkStore, Map<string, Record<string, unknown>>>();
/** A pinned queue projection, not a portable Work snapshot. Historical Lane
 * conversations, saves and unrelated runs cannot delay queue admission/settlement.
 * Header status only selects records; every selected record is fully validated. */
export function landingRecords(
  store: WorkStore,
  channel?: string,
  tx = store.readRecords?.(),
  selectedId?: string,
) {
  if (!tx) return store.load();
  const data = tx.data();
  const pages = new Map<string, string[]>();
  const previous = headerCache.get(store),
    current = new Map<string, Record<string, unknown>>();
  const header = (collection: 'landingEntries' | 'landingBatches', position: number) => {
    const page = tx.manifest.collections[collection]!.pages[Math.floor(position / pageSize)]!;
    let hashes = pages.get(page);
    if (!hashes) {
      hashes = pageHashes(store.directory, page);
      pages.set(page, hashes);
    }
    const hash = hashes[position % pageSize]!;
    let fields = previous?.get(hash);
    if (!fields) {
      const raw = readFragment(store.directory, hash).fields;
      fields = Object.fromEntries(
        ['id', 'channel', 'status', 'alreadyOnMain', 'keepOpen'].map(key => [key, raw[key]]),
      );
    }
    current.set(hash, fields);
    const retained = { fields };
    invariant(
      channel === undefined || retained.fields.channel === channel,
      'INVALID_WORK_STORE',
      'Landing channel lookup differs from its retained record.',
    );
    return retained;
  };
  const positions = (collection: 'landingEntries' | 'landingBatches') =>
    channel === undefined
      ? Array.from({ length: tx.manifest.collections[collection]?.count ?? 0 }, (_, i) => i)
      : tx.positions(collection, channel, 'channel');
  data.landingBatches = positions('landingBatches').flatMap(position => {
    // fieldsAt cannot represent a batch's required nonempty entryIds array.
    const retained = header('landingBatches', position);
    const parsed = landingBatchSchema.shape.status.safeParse(retained.fields.status);
    invariant(parsed.success, 'INVALID_WORK_STORE', 'Landing batch status is invalid.');
    const status = parsed.data;
    return ['composing', 'checking'].includes(status) || retained.fields.id === selectedId
      ? [tx.at('landingBatches', position)]
      : [];
  });
  const included = new Set([
    ...data.landingBatches.flatMap(batch => batch.entryIds),
    ...(selectedId ? [selectedId] : []),
  ]);
  data.landingEntries = positions('landingEntries').flatMap(position => {
    const retained = header('landingEntries', position);
    const parsed = landingEntrySchema.shape.status.safeParse(retained.fields.status);
    invariant(parsed.success, 'INVALID_WORK_STORE', 'Landing entry status is invalid.');
    const status = parsed.data;
    if (
      included.has(String(retained.fields.id)) ||
      ['queued', 'checking', 'awaiting-review'].includes(status)
    )
      return [tx.at('landingEntries', position)];
    if (!retained.fields.alreadyOnMain || retained.fields.keepOpen) return [];
    const entry = tx.at('landingEntries', position),
      view = tx.find('views', entry.viewId)?.record;
    const incomplete = view?.inputs.some(pin => {
      const lane = tx.fields('lanes', pin.laneId)?.record;
      return lane && lane.head === pin.head && ['active', 'paused', 'ready'].includes(lane.state);
    });
    return incomplete ? [entry] : [];
  });
  const views = new Set([
    ...data.landingEntries.map(entry => entry.viewId),
    ...data.landingBatches.flatMap(batch => batch.prefixes.map(prefix => prefix.viewId)),
  ]);
  data.views = [...views].flatMap(id => tx.find('views', id)?.record ?? []);
  data.lanes = [...new Set(data.views.flatMap(view => view.inputs.map(pin => pin.laneId)))].flatMap(
    id => tx.find('lanes', id)?.record ?? [],
  );
  data.checks = [...new Set(data.landingEntries.map(entry => entry.checkId))].flatMap(
    id => tx.find('checks', id)?.record ?? [],
  );
  data.runs = [
    ...new Set([
      ...data.landingBatches.flatMap(batch => batch.prefixes.map(prefix => prefix.runId)),
      ...(channel === undefined
        ? ['queued', 'preparing', 'running'].flatMap(status =>
            tx.all('runs', status, 'status').map(run => run.id),
          )
        : []),
    ]),
  ].flatMap(id => tx.find('runs', id)?.record ?? []);
  const moves = new Map<number, WorkData['channelMoves'][number]>();
  if (channel !== undefined) {
    for (const position of tx.positions('channelMoves', channel, 'channel').reverse()) {
      const move = tx.at('channelMoves', position);
      if (move.status === 'accepted') {
        moves.set(position, move);
        break;
      }
    }
    // Lost acceptance replies may precede a later main move. Keep those exact
    // receipts as well as current main so recovery never rechecks accepted work.
    for (const batch of data.landingBatches)
      for (const prefix of batch.prefixes) {
        const receipt = tx.find('channelMoves', finishChild(batch.id, `accept:${prefix.viewId}`));
        if (receipt) moves.set(receipt.position, receipt.record);
      }
  }
  data.channelMoves = [...moves].sort(([a], [b]) => a - b).map(([, move]) => move);
  headerCache.set(store, current);
  return data;
}

/** Publish only the queue records the transition actually changed, under the
 * existing owner lock and driver fence. Never save a projection as whole Work. */
export function editLandingRecords<T>(
  store: WorkStore,
  channel: string,
  edit: (data: WorkData) => T,
  tx: WorkRecordTransaction,
  selectedId: string,
) {
  const data = landingRecords(store, channel, tx, selectedId);
  const before = new Map(
    writable.map(collection => [
      collection,
      new Map((data[collection] ?? []).map(record => [record.id, JSON.stringify(record)])),
    ]),
  );
  const result = edit(data);
  const changes = writable.flatMap(collection =>
    (data[collection] ?? []).flatMap(record =>
      before.get(collection)!.get(record.id) === JSON.stringify(record) ? [] : [{ collection, record }],
    ),
  );
  if (!changes.length) return result;
  const expanded = Number(data.schema) >= 19 || data.landingBatches?.some(batch => batch.entryIds.length > 4);
  tx.setSchema(
    (Number(data.schema) >= 21
      ? data.schema
      : [16, 18, 20].includes(Number(data.schema))
        ? expanded
          ? 20
          : 18
        : expanded
          ? 19
          : 17) as WorkData['schema'],
  );
  for (const { collection, record } of changes) {
    const position = tx.positions(collection, record.id)[0];
    if (position === undefined) tx.append(collection, record);
    else tx.replace(collection, position, record);
  }
  store.commitRecords(tx);
  return result;
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
