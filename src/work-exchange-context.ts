// SPDX-License-Identifier: Apache-2.0
import { WORK_DELTA_BYTES, partialWork, batchContextIds, type WorkDelta } from './work-exchange-delta.js';
import { recordIdentity, recordMap, readRecord, type WorkRecordRoot } from './work-exchange-records.js';
/** Include inbound dependants, referenced records and sibling View families. */
export async function workDeltaContext(
  before: WorkRecordRoot,
  after: WorkRecordRoot,
  delta: WorkDelta,
  read: (pin: { sha256: string; size: number }) => Promise<Buffer>,
  extra: string[] = [],
  metadataOnly = new Set<string>(),
  options: {
    maxBytes?: number;
    prefetchOnly?: boolean;
    readMany?: (pins: { sha256: string; size: number }[]) => Promise<Buffer[]>;
  } = {},
) {
  const old = recordMap(before),
    next = recordMap(after),
    all = [...old.values(), ...next.values()];
  const impacted = new Set([
    ...delta.changes.map(c => recordIdentity(c.collection, c.key)).filter(id => !metadataOnly.has(id)),
    ...extra,
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { collection, record } of all) {
      const id = recordIdentity(collection, record.key);
      if (
        !impacted.has(id) &&
        record.refs.some(ref => impacted.has(recordIdentity(ref.collection, ref.key)))
      ) {
        impacted.add(id);
        changed = true;
      }
    }
  }
  const selected = new Set([...impacted, ...metadataOnly]);
  for (const root of [before, after])
    for (const field of root.fields)
      if ('records' in field) {
        if (field.name === 'intents') {
          const current =
            [...field.records].reverse().find(r => r.status === 'active') ?? field.records.at(-1);
          if (current) selected.add(recordIdentity(field.name, current.key));
        }
        if (field.name === 'channelMoves' || field.name === 'hostedChannelMoves') {
          const channels = new Map();
          for (const record of field.records)
            if (field.name === 'hostedChannelMoves' || record.status === 'accepted')
              channels.set(record.channel, record);
          for (const record of channels.values()) selected.add(recordIdentity(field.name, record.key));
        }
      }
  // View supersession and acceptance depend on siblings as well as direct edges.
  const families = new Set<string>();
  for (const { collection, record } of all)
    if (collection === 'views' && impacted.has(recordIdentity(collection, record.key)))
      for (const ref of record.refs)
        if (ref.collection === 'intents' || ref.collection === 'lanes')
          families.add(recordIdentity(ref.collection, ref.key));
  for (const { collection, record } of all)
    if (
      collection === 'views' &&
      record.refs.some(ref => families.has(recordIdentity(ref.collection, ref.key)))
    )
      selected.add(recordIdentity(collection, record.key));
  const pending = [...selected];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    if (metadataOnly.has(pending[cursor]!)) continue;
    for (const map of [old, next])
      for (const ref of map.get(pending[cursor]!)?.record.refs ?? []) {
        const id = recordIdentity(ref.collection, ref.key);
        if (!selected.has(id)) {
          selected.add(id);
          pending.push(id);
        }
      }
  }
  let bytes = 0;
  for (const map of [old, next]) for (const id of selected) bytes += map.get(id)?.record.size ?? 0;
  if (bytes > (options.maxBytes ?? WORK_DELTA_BYTES)) return;
  // Publication needs prior changed bodies, outgoing references and batch
  // prefix metadata; other inbound/sibling bodies belong to source return.
  // Unchanged keys/refs inherit the validated base and whole digest traversal.
  const needed = new Set([
    ...delta.changes.map(c => recordIdentity(c.collection, c.key)),
    ...batchContextIds(after, delta.changes),
  ]);
  if (options.prefetchOnly) {
    const queue = [...needed].filter(id => !metadataOnly.has(id));
    for (let cursor = 0; cursor < queue.length; cursor++)
      for (const ref of next.get(queue[cursor]!)?.record.refs ?? []) {
        const id = recordIdentity(ref.collection, ref.key);
        if (!needed.has(id)) {
          needed.add(id);
          queue.push(id);
        }
      }
  }
  const changedIds = new Set(delta.changes.map(c => recordIdentity(c.collection, c.key)));
  const load = async (root: WorkRecordRoot, map: typeof old) => {
    const values = [];
    // Keep the original collection order for View supersession and histories.
    const entries = [...map].filter(([id]) =>
      options.prefetchOnly ? (map === old ? changedIds : needed).has(id) : selected.has(id),
    );
    for (let start = 0; start < entries.length;) {
      let end = start,
        bytes = 0;
      while (end < entries.length && end - start < 100) {
        const size = entries[end]![1].record.size;
        if (end > start && bytes + size > 2 * 1024 * 1024) break;
        bytes += size;
        end++;
      }
      const page = entries.slice(start, end);
      const bodies = options.readMany
        ? await options.readMany(page.map(([, { record }]) => record))
        : undefined;
      for (const [index, [, { collection, record }]] of page.entries()) {
        // The publication validator authenticates keys, bodies and references
        // once below; avoid parsing and discarding a second copy here.
        if (options.prefetchOnly) continue;
        const value = await readRecord(record, bodies ? async () => bodies[index]! : read, collection);
        values.push({ collection, value });
      }
      start = end;
    }
    return partialWork(root, values);
  };
  return { previous: await load(before, old), current: await load(after, next), recordsRead: selected.size };
}
