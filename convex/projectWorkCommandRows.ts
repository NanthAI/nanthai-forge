// SPDX-License-Identifier: Apache-2.0
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

/** Only selected record attributes hydrate; note/checkpoint/history collections stay paged. */
export async function commandPayloadRows(rows: Rows, lookup: CommandLookup) {
  for (const row of [...rows]) {
    if (
      !row ||
      !['intents', 'initiatives', 'planningItems'].includes(row.collection) ||
      rows.some(item => item?.collection === `${row.collection}:attributes` && item.key === row.key)
    )
      continue;
    const header = JSON.parse(row.value) as Record<string, unknown> & IndexHeader;
    if (!header.payloadKey) continue;
    const parts: IndexEntry[] = [];
    for (let offset = 0; offset < header.payloadParts!; offset += 100) {
      const selected = await lookup(
        Array.from({ length: Math.min(100, header.payloadParts! - offset) }, (_, i) => ({
          collection: `${row.collection}:payload`,
          key: `${header.payloadKey}:${offset + i}`,
        })),
      );
      for (const part of selected) {
        invariant(part, 'WORK_STALE', 'This Work record changed while reading its attributes.');
        parts.push(part);
      }
    }
    rows.push({
      ...row,
      collection: `${row.collection}:attributes`,
      value: JSON.stringify(assembleIndexValue(row.collection, header, parts)),
    });
  }
}

/** Planning replacement also updates old reciprocal links and source memberships. */
export async function commandPlanningRows(
  rows: Rows,
  command: Exclude<HostedEvent['command'], { action: 'source-return' }>,
  lookup: CommandLookup,
) {
  if (command.action !== 'put-planning-item' && command.action !== 'comment-planning-item') return;
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
}
