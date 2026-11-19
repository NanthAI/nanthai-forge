// SPDX-License-Identifier: Apache-2.0
// Who works on each Item now (Item d3357f40): the Plan's Owner column shows them when an Item has no owner. One
// bounded read (convex/projectPlanWorkers.ts) asks, by Intent, about the in-progress Items: each Item's own Intent
// and its first two follow-ups (a reopened Item, src/hosted-intent-chain.ts), at most PLAN_WORK_INTENTS Intents, in
// plan order. It is made once per page open and again only when the asked Intents change or a hidden tab is shown again;
// never subscribed, never on a timer, never while the tab is hidden, so an idle tab costs nothing. An Item that was
// asked about and has no active Lane says "no one yet"; one past the cap, before the answer arrives, or for a reader
// the server withholds presence from, says nothing rather than guess. A visible tab is not refreshed when another Lane
// starts on an Item already in progress (that would need a subscription, and idle must cost nothing): the page reads
// again when it opens, when the in-progress Items change, and when the tab is shown again. Labels are public identities only: a Forge handle or `handle/agent`.
import { useEffect, useMemo, useState } from 'react';
import { successorIntentId } from '../../../../src/hosted-intent-chain';
import type { PlanRow } from '../../../../src/planning-model';

export type ActiveLane = { intentId: string; actor?: string | null; at: number | null };
/** Item id to the public labels working on it, newest first, each once; an empty list means asked and nobody. An
 * Item missing from the map was not asked about: nothing is said. */
export type Workers = ReadonlyMap<string, readonly string[]>;
/** The read: the Lanes on the asked Intents, or `withheld` for a reader who may not see presence. */
export type ReadWorkers = (
  intentIds: readonly string[],
) => Promise<{ lanes: readonly ActiveLane[]; withheld?: boolean }>;

/** The server's cap (convex/projectPlanWorkers.ts PLAN_WORK_INTENTS): three Intents per Item, so 50 Items. */
export const PLAN_WORK_INTENTS = 150;
/** Intents asked per Item: its own and the first two follow-ups (an Item reopened twice). */
const PER_ITEM = 3;

/** A Forge handle, optionally with an agent run's word-pair slug (src/agent-slug.ts). */
const labelShape = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])(?:\/[a-z]+-[a-z]+)?$/;
/** A label the server mapped to a public identity; anything else (an unmapped account, a name) is never shown. */
export const publicLabel = (actor: unknown): actor is string =>
  typeof actor === 'string' && labelShape.test(actor);

/** The Intents to ask about, each with its Item: in-progress Items in plan order, own Intent then two follow-ups. */
export function askedIntents(rows: readonly PlanRow[]): Map<string, string> {
  const asked = new Map<string, string>();
  const started = rows
    .filter(row => row.kind === 'issue' && row.status === 'in-progress')
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.id.localeCompare(b.id));
  for (const row of started) {
    if (asked.size + PER_ITEM > PLAN_WORK_INTENTS) break;
    for (let hop = 0, intent = row.id; hop < PER_ITEM; hop++, intent = successorIntentId(intent))
      asked.set(intent, row.id);
  }
  return asked;
}

/** Each asked Item's labels (an empty list when nobody works on it), and every other Item that is not in progress
 * as nobody; an in-progress Item past the cap is left out. */
export function workersByItem(
  lanes: readonly ActiveLane[],
  rows: readonly PlanRow[],
  asked: ReadonlyMap<string, string> = askedIntents(rows),
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const items = new Set(asked.values());
  for (const row of rows)
    if (row.kind === 'issue' && (row.status !== 'in-progress' || items.has(row.id))) out.set(row.id, []);
  const newest = [...lanes].sort((a, b) => (b.at ?? Infinity) - (a.at ?? Infinity));
  for (const lane of newest) {
    const item = asked.get(lane.intentId);
    if (!item || !publicLabel(lane.actor)) continue;
    const labels = out.get(item) ?? [];
    if (!labels.includes(lane.actor)) labels.push(lane.actor);
    out.set(item, labels);
  }
  return out;
}

/** The labels across several Items (an Initiative's), newest Item order kept, each once. */
export function workersOf(workers: Workers, ids: readonly string[]) {
  return [...new Set(ids.flatMap(id => workers.get(id) ?? []))];
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Reads the active Lanes once, then again only when the asked Intents change or a hidden tab is shown again. */
export function useWorkers(read: ReadWorkers | undefined, rows: readonly PlanRow[] | undefined): Workers {
  const [answer, setAnswer] = useState<{
    key: string;
    lanes: readonly ActiveLane[];
    withheld?: boolean;
  } | null>(null);
  const asked = useMemo(() => (rows ? askedIntents(rows) : null), [rows]);
  const key = asked ? [...asked.keys()].sort().join(',') : null;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    // A tab shown again reads once more: Lanes may have started or closed while nobody looked.
    const onShow = () => !hidden() && setShown(n => n + 1);
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);
  useEffect(() => {
    if (key === null || !read || !asked) return;
    if (!asked.size) return setAnswer({ key, lanes: [] });
    if (hidden()) return; // read when shown (above)
    let live = true;
    read([...asked.keys()]).then(
      ({ lanes, withheld }) => live && setAnswer({ key, lanes, withheld }),
      // A failed read leaves the column as it was: owners still show, and nothing is guessed.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [key, shown, Boolean(read)]);
  return useMemo(() => {
    if (!rows) return new Map();
    // Until the answer for these Intents arrives, an in-progress Item says nothing; the rest are nobody's.
    // A reader the server withholds presence from is told nothing about in-progress Items.
    const current = answer && answer.key === key && !answer.withheld && asked;
    return current ? workersByItem(answer.lanes, rows, current) : workersByItem([], rows, new Map());
  }, [answer, rows, asked, key]);
}
