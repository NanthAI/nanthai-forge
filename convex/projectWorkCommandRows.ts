// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { assembleIndexValue, type IndexHeader } from '../src/work-index-value';
import type { IndexEntry } from '../src/work-hosted-index';
import type { HostedEvent } from '../src/work-types';
import { invariant } from '../src/errors';
type Rows = (IndexEntry | null)[];
type Key = { collection: string; key: string };
export type CommandLookup = (keys: Key[]) => Promise<Rows>;
export const commandValues = (rows: Rows, collection: string) =>
  rows
    .filter((row): row is IndexEntry => row?.collection === collection)
    .map(row =>
      JSON.parse(
        rows.find(item => item?.collection === `${collection}:attributes` && item.key === row.key)?.value ??
          row.value,
      ),
    );

/** Only selected record attributes hydrate; note/checkpoint/history collections stay paged. Every row that needs its
 * payload is hydrated in the same batched lookups (100 keys per call), so k large Intents cost ceil(parts/100) calls,
 * not one call per Intent (review r1). */
export async function commandPayloadRows(rows: Rows, lookup: CommandLookup) {
  const pending: { row: IndexEntry; header: Record<string, unknown> & IndexHeader; keys: Key[] }[] = [];
  for (const row of rows) {
    if (
      !row ||
      !['intents', 'initiatives', 'planningItems', 'planningVersions'].includes(row.collection) ||
      rows.some(item => item?.collection === `${row.collection}:attributes` && item.key === row.key) ||
      pending.some(item => item.row.collection === row.collection && item.row.key === row.key)
    )
      continue;
    const header = JSON.parse(row.value) as Record<string, unknown> & IndexHeader;
    if (!header.payloadKey) continue;
    pending.push({
      row,
      header,
      keys: Array.from({ length: header.payloadParts! }, (_, i) => ({
        collection: `${row.collection}:payload`,
        key: `${header.payloadKey}:${i}`,
      })),
    });
  }
  const keys = pending.flatMap(item => item.keys),
    parts: (IndexEntry | null)[] = [];
  for (let offset = 0; offset < keys.length; offset += 100)
    parts.push(...(await lookup(keys.slice(offset, offset + 100))));
  let at = 0;
  for (const { row, header, keys: own } of pending) {
    const selected = parts.slice(at, (at += own.length));
    invariant(
      selected.every(part => part),
      'WORK_STALE',
      'This Work record changed while reading its attributes.',
    );
    rows.push({
      ...row,
      collection: `${row.collection}:attributes`,
      value: JSON.stringify(assembleIndexValue(row.collection, header, selected as IndexEntry[])),
    });
  }
}

/** Planning replacement also updates old reciprocal links and source memberships. */
export async function commandPlanningRows(
  rows: Rows,
  command: Exclude<HostedEvent['command'], { action: 'source-return' | 'purged-planning-row' }>,
  lookup: CommandLookup,
) {
  if (
    command.action !== 'put-planning-item' &&
    command.action !== 'comment-planning-item' &&
    command.action !== 'purge-planning-item'
  )
    return;
  const aliases = commandValues(rows, 'intentAliases'),
    targetId = aliases.find(alias => alias.aliasId === command.itemId)?.intentId ?? command.itemId;
  const target = commandValues(rows, 'intents').find(intent => intent.id === targetId);
  const historyId = target?.historyRefs?.[0]?.itemId;
  const keys: Key[] = [];
  const add = (collection: string, key: string) => {
    if (
      !rows.some(row => row?.collection === collection && row.key === key) &&
      !keys.some(row => row.collection === collection && row.key === key)
    )
      keys.push({ collection, key });
  };
  if (historyId && historyId !== command.itemId) add('planningItems', historyId);
  for (const id of target?.relatedIntentIds ?? []) add('intents', id);
  for (const membership of target?.memberships ?? []) add('initiatives', membership.initiativeId);
  for (const item of [...commandValues(rows, 'planningItems'), ...commandValues(rows, 'initiatives')]) {
    for (const id of item.intentIds ?? []) add('intents', id);
    if (item.initiativeId) add('initiatives', item.initiativeId);
  }
  for (let offset = 0; offset < keys.length; offset += 100)
    rows.push(...(await lookup(keys.slice(offset, offset + 100))));
  await commandPayloadRows(rows, lookup);
  // A put that newly names an Item as a link, parent, relation or Initiative reads that Item's latest version, so
  // a tombstone is refused here exactly as a full replay refuses it (purge Lane 2, refuseTombstoneLinks). Only ids the
  // current version does not already name, after hydration and spreading: an unchanged put reads nothing more, and
  // a tombstone is small enough to be whole.
  if (command.action !== 'put-planning-item') return;
  // The reducer's target (planningTarget): an Initiative's own id, else the Intent's first history Item or the Intent.
  const currentId = commandValues(rows, 'initiatives').some(item => item.id === command.itemId)
    ? command.itemId
    : (historyId ?? targetId);
  const current = commandValues(rows, 'planningItems').find(item => item.id === currentId);
  const before = new Set(planningLinkIds(current));
  const named = [...new Set(planningLinkIds(command))].filter(id => !before.has(id));
  // A key looked up once is never asked again, also when it came back empty (review r1).
  const asked = new Set<string>();
  const has = (collection: string, key: string) =>
    asked.has(`${collection}\n${key}`) || rows.some(row => row?.collection === collection && row.key === key);
  const load = async (wanted: Key[]) => {
    const keys = wanted.filter(({ collection, key }) => !asked.has(`${collection}\n${key}`));
    for (const { collection, key } of keys) asked.add(`${collection}\n${key}`);
    for (let offset = 0; offset < keys.length; offset += 100)
      rows.push(...(await lookup(keys.slice(offset, offset + 100))));
  };
  // Resolve each newly named id the way the reducer does: its alias, then its Intent's history Item.
  await load(
    named.flatMap(id => [
      ...(has('intentAliases', id) ? [] : [{ collection: 'intentAliases', key: id }]),
      ...(has('intents', id) ? [] : [{ collection: 'intents', key: id }]),
    ]),
  );
  const aliasOf = (id: string) =>
    commandValues(rows, 'intentAliases').find(alias => alias.aliasId === id)?.intentId ?? id;
  await load(
    [...new Set(named.map(aliasOf))]
      .filter(id => !has('intents', id))
      .map(key => ({ collection: 'intents', key })),
  );
  // A large Intent's header lacks its history refs; hydrate the newly read ones (already hydrated rows are skipped).
  await commandPayloadRows(rows, lookup);
  const linkKeys: Key[] = [];
  for (const id of named) {
    const intentId = aliasOf(id);
    const itemId =
      commandValues(rows, 'intents').find(intent => intent.id === intentId)?.historyRefs?.[0]?.itemId ??
      intentId;
    if (!has('planningItems', itemId) && !linkKeys.some(key => key.key === itemId))
      linkKeys.push({ collection: 'planningItems', key: itemId });
  }
  await load(linkKeys);
}
/** The Item ids a planning version or put names as links, Initiative, parent or relations, as written. */
const planningLinkIds = (
  item:
    | {
        intentIds?: string[] | undefined;
        initiativeId?: string | null | undefined;
        parentId?: string | null | undefined;
        relations?: { id: string }[] | undefined;
      }
    | undefined,
) => [
  ...(item?.intentIds ?? []),
  ...(item?.initiativeId ? [item.initiativeId] : []),
  ...(item?.parentId ? [item.parentId] : []),
  ...(item?.relations ?? []).map(relation => relation.id),
];
