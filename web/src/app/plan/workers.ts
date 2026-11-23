// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

export type ActiveLane = {
  intentId: string;
  /** Joins the shell's line feed for the Lane's state (lane-words.ts); older servers leave it out. */
  laneId?: string;
  actor?: string | null;
  at: number | null;
};
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

const hasWork = (row: PlanRow, includeOpenLanes: boolean) =>
  row.status === 'in-progress' || (includeOpenLanes && row.inLane === true);

/** The Intents to ask about, each with its Item: Items with work in plan order, own Intent then two follow-ups. */
export function askedIntents(rows: readonly PlanRow[], includeOpenLanes = false): Map<string, string> {
  const asked = new Map<string, string>();
  const started = rows
    .filter(row => row.kind === 'issue' && hasWork(row, includeOpenLanes))
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.id.localeCompare(b.id));
  for (const row of started) {
    if (asked.size + PER_ITEM > PLAN_WORK_INTENTS) break;
    for (let hop = 0, intent = row.id; hop < PER_ITEM; hop++, intent = successorIntentId(intent))
      asked.set(intent, row.id);
  }
  return asked;
}

/** Each asked Item's labels (an empty list when nobody works on it), and every other Item that is not in progress
 * as nobody; a working Item past the cap is left out. */
export function workersByItem(
  lanes: readonly ActiveLane[],
  rows: readonly PlanRow[],
  asked: ReadonlyMap<string, string> = askedIntents(rows),
  includeOpenLanes = false,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const items = new Set(asked.values());
  for (const row of rows)
    if (row.kind === 'issue' && (!hasWork(row, includeOpenLanes) || items.has(row.id))) out.set(row.id, []);
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

/** Distinct agents across an Initiative's Items. Missing or capped data only supports a lower bound. */
export function workingAgentsLabel(
  workers: Workers,
  ids: readonly string[],
  observedLanes: number,
  missingIdentity: boolean,
  openLanes: number | null,
) {
  const agents = new Set<string>();
  for (const id of ids) for (const label of workers.get(id) ?? []) if (label.includes('/')) agents.add(label);
  const partial = missingIdentity || openLanes !== observedLanes;
  const n = agents.size;
  if (partial && !n) return 'Not reported';
  return `${partial ? 'At least ' : ''}${n.toLocaleString()} ${n === 1 ? 'agent' : 'agents'}`;
}

/** The account for which the recorded creator acted. Only projected public identities qualify. */
export function accountableHandle(creator: string | undefined) {
  return publicLabel(creator) ? creator.split('/')[0] : undefined;
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Reads the active Lanes once, then again only when the asked Intents change or a hidden tab is shown again. */
export function useWorkers(
  read: ReadWorkers | undefined,
  rows: readonly PlanRow[] | undefined,
  includeOpenLanes: boolean,
) {
  const [answer, setAnswer] = useState<{
    key: string;
    lanes: readonly ActiveLane[];
    withheld?: boolean;
  } | null>(null);
  const asked = useMemo(() => (rows ? askedIntents(rows, includeOpenLanes) : null), [rows, includeOpenLanes]);
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
    // Until the answer for these Intents arrives, an in-progress Item says nothing; the rest are nobody's.
    // A reader the server withholds presence from is told nothing about active Lanes.
    const current = answer && answer.key === key && !answer.withheld && asked;
    const seen = current ? answer.lanes.filter(lane => current.has(lane.intentId)) : [];
    return {
      byItem: workersByItem(seen, rows ?? [], current || new Map(), includeOpenLanes),
      /** The asked Lanes themselves, each with its Intent (and Lane id when sent). */
      lanes: seen,
      /** Each asked Intent's Item, known from the rows before any answer (askedIntents). */
      asked,
      observedLanes: seen.length,
      missingIdentity: seen.some(lane => !publicLabel(lane.actor)),
    };
  }, [answer, rows, asked, key, includeOpenLanes]);
}
