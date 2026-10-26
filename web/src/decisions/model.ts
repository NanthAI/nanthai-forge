// SPDX-License-Identifier: Apache-2.0
import { decisionContext, type DecisionRecord } from '../../../src/decision-types';
import type { TimelineEvent } from '../lane/timeline';

export type DecisionIntent = { id: string; outcome: string };
export type DecisionFilter = 'active' | 'superseded' | 'all';
export const decisionOrder = (records: readonly DecisionRecord[]) =>
  [...records].sort(
    (a, b) => b.decidedAt.localeCompare(a.decidedAt) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id),
  );
export function replacementsFor(records: readonly DecisionRecord[], id: string) {
  return records.filter(record => record.supersedes === id);
}
export function activeDecisions(records: readonly DecisionRecord[], intentId?: string) {
  return decisionOrder(decisionContext([...records], intentId).active);
}
export function decisionGroups(records: readonly DecisionRecord[], filter: DecisionFilter, target = 'all') {
  const superseded = new Set(decisionContext([...records]).superseded.map(record => record.id));
  // Intent-targeted records participate in the same supersession graph as project records.
  for (const record of records) if (record.supersedes) superseded.add(record.supersedes);
  const groups = new Map<string, DecisionRecord[]>();
  for (const record of decisionOrder(records)) {
    if (filter !== 'all' && (filter === 'superseded') !== superseded.has(record.id)) continue;
    if (
      target !== 'all' &&
      (target === 'project'
        ? record.target.kind !== 'project'
        : record.target.kind !== 'intent' || record.target.intentId !== target)
    )
      continue;
    const day = record.decidedAt.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), record]);
  }
  return [...groups].map(([day, records]) => ({ day, records }));
}
export function decisionDate(value: string, time = false) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(time && value.length > 10 ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'UTC',
  })
    .format(new Date(value))
    .replace(',', '');
}
export function decisionDay(day: string, now: number) {
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  return `${day === today ? 'Today · ' : day === yesterday ? 'Yesterday · ' : ''}${decisionDate(day)}`;
}
export function targetName(record: DecisionRecord, intents: readonly DecisionIntent[]) {
  return record.target.kind === 'project'
    ? 'Project'
    : (intents.find(intent => record.target.kind === 'intent' && intent.id === record.target.intentId)
        ?.outcome ?? 'Intent');
}
export function overrideText(record: DecisionRecord, records: readonly DecisionRecord[]) {
  const rule = record.overrides;
  return rule?.kind === 'default'
    ? `default ${rule.description}`
    : rule?.kind === 'decision'
      ? (records.find(record => record.id === rule.decisionId)?.what ?? 'earlier decision')
      : undefined;
}
export function decisionTimeline(records: readonly DecisionRecord[], intentId: string): TimelineEvent[] {
  return records
    .filter(record => record.target.kind === 'intent' && record.target.intentId === intentId)
    .map(record => ({
      id: `owner-decision:${record.id}`,
      at: record.at,
      tone: 'plain',
      glyph: 'claim',
      text: `Owner decision recorded · ${record.what}`,
      detail: [
        `by ${record.actor.name}`,
        overrideText(record, records) && `overrides ${overrideText(record, records)}`,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
}
export function recentDecisions(records: readonly DecisionRecord[], now: number) {
  return [...records]
    .filter(record => Date.parse(record.at) <= now && Date.parse(record.at) >= now - 7 * 86_400_000)
    .sort((a, b) => b.at.localeCompare(a.at));
}
/** Documents are navigation only; arbitrary record text never becomes an executable URL. */
export function decisionDocumentHref(link: string, sourceHref: (path: string) => string) {
  if (/^https?:\/\//i.test(link)) return link;
  if (/^(?:docs\/|README\.md(?:#|$)|AGENTS\.md(?:#|$))/.test(link)) return sourceHref(link);
  return undefined;
}

/** Only cross-record previews are shortened; the record's own what is always complete. */
export function decisionExcerpt(what: string, limit = 110) {
  if (what.length <= limit) return what;
  const text = Array.from(what).slice(0, limit).join('');
  const boundary = text.lastIndexOf(' ');
  return `${text.slice(0, boundary > limit / 2 ? boundary : text.length)}…`;
}
