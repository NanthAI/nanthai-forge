// SPDX-License-Identifier: Apache-2.0
import { getDocumentSize } from 'convex/values';
import { digest } from './portable-hash.js';
import type { IndexEntry } from './work-hosted-index.js';
import type { PlanningItem } from './work-planning-types.js';

export const planningSummary = (
  item: PlanningItem & {
    bodyLength?: number;
    hasDoneWhen?: boolean;
    payloadKey?: string;
  },
) => {
  const bodyKnown = item.bodyLength !== undefined || !item.payloadKey || item.body.length > 0;
  const length = bodyKnown ? (item.bodyLength ?? item.body.length) : null;
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    version: item.version,
    intentIds: item.intentIds,
    initiativeId: item.initiativeId ?? null,
    at: item.at,
    ...(item.author ? { author: item.author } : {}),
    body: item.body.slice(0, 400),
    bodyLength: length,
    hasDoneWhen: bodyKnown ? (item.hasDoneWhen ?? /done\s+when\s*:/i.test(item.body)) : null,
    ...(length === null || length > 400 ? { bodyTruncated: true } : {}),
  };
};

/** Provider accepts 16 terms. Report the actual terms; never silently claim whole-query coverage. */
export function planningSearchTerms(text: string) {
  const all = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const terms = all.filter(term => [...term].length <= 32).slice(0, 16);
  return { text: terms.join(' '), omittedTerms: all.length - terms.length };
}
/**
 * A query that is one 8-character id prefix or a full UUID (as `planningSearchTerms` tokenised it)
 * names an item: the key prefix to look up directly, so the item comes before text mentions.
 */
export function planningIdPrefix(text: string): string | undefined {
  const terms = text.split(' ');
  if (terms.length === 1 && /^[0-9a-f]{8}$/.test(terms[0]!)) return terms[0];
  if (terms.length === 5 && /^[0-9a-f]{8} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{12}$/.test(text))
    return terms.join('-');
  return undefined;
}
/** Search previews are bounded independently of the full, unchanged planning record. */
export function planningSearchEntry(item: PlanningItem, position: number): IndexEntry {
  return {
    collection: 'planningSearch',
    key: item.id,
    parent: '',
    position,
    value: JSON.stringify({
      id: item.id,
      kind: item.kind,
      status: item.status,
      version: item.version,
      initiativeId: item.initiativeId ?? null,
      ...(item.author ? { author: item.author } : {}),
      title: item.title.slice(0, 400),
      titleLength: item.title.length,
      ...(item.title.length > 400 ? { titleTruncated: true } : {}),
      body: item.body.slice(0, 400),
      bodyLength: item.body.length,
      ...(item.body.length > 400 ? { bodyTruncated: true } : {}),
      hasDoneWhen: /done\s+when\s*:/i.test(item.body),
    }),
    planning: {
      text: `${item.title}\n${item.body}`.replace(/[\uD800-\uDFFF]/gu, '\uFFFD'),
      kind: item.kind,
      status: item.status,
      initiativeId: item.initiativeId ?? '',
      open: ['proposed', 'open', 'in-progress'].includes(item.status),
    },
  };
}

/** Includes system and enclosing IDs; physical sizing, rather than a new input limit. */
export const planningSearchRowBytes = (entry: IndexEntry) =>
  getDocumentSize({
    ...entry,
    projectId: 'x'.repeat(32),
    generationId: 'x'.repeat(32),
  });

/** Ordinary records keep one row. Oversized legacy text uses the existing payload
 * retirement protocol, with bounded fragments and a compact root for current-version checks. */
export function planningSearchEntries(item: PlanningItem, position: number): IndexEntry[] {
  const entry = planningSearchEntry(item, position);
  if (planningSearchRowBytes(entry) <= 1048576) return [entry];
  const text = entry.planning!.text;
  const payloadKey = `${item.id}:${digest(text)}`;
  const fragments: string[] = [];
  // Preserve whole provider-indexable words. A >32-codepoint word is unindexed;
  // represent it by an equally unindexed placeholder instead of inventing split-word hits.
  let chunk = '';
  for (const match of text.matchAll(/[\p{Alphabetic}\p{Number}]+/gu)) {
    const term = match[0];
    const word = term.length > 64 || [...term].length > 32 ? 'z'.repeat(33) : term;
    if (chunk.length + word.length + 1 > 16000) {
      fragments.push(chunk);
      chunk = '';
    }
    chunk += `${word} `;
  }
  if (chunk || !fragments.length) fragments.push(chunk);
  const root = {
    ...entry,
    value: JSON.stringify({
      ...JSON.parse(entry.value),
      payloadKey,
      payloadParts: fragments.length,
    }),
    planning: { ...entry.planning!, text: '' },
  };
  return [
    root,
    ...fragments.map((text, part) => ({
      collection: 'planningSearch:payload',
      key: `${payloadKey}:${part}`,
      parent: payloadKey,
      position: part,
      // Concatenating payload values restores the exact compact summary, as for other Work payloads.
      value: part === 0 ? entry.value : '',
      planning: { ...entry.planning!, text, itemId: item.id, payloadKey },
    })),
  ];
}
