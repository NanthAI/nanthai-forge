// SPDX-License-Identifier: Apache-2.0
import { intentProgress } from '../../../src/work-intent-progress';
import type { CockpitLane } from '../cockpit/model';
import { attentionRank, toneLabel, type Tone } from '../ui/status';

export type IntentStatus = 'active' | 'ready' | 'abandoned' | 'completed';
export type IntentRow = {
  id: string;
  outcome: string;
  constraints: string;
  status: IntentStatus;
  planned: boolean;
  createdAt?: string;
  lanes: CockpitLane[];
  open: CockpitLane[];
  /** The most urgent state among its open Lanes, or the Intent status when none are open. */
  tone: Tone;
  label: string;
  lastAt?: string;
  agents?: { name: string; identity: string }[];
  landedAt?: string;
  notes: number;
  decisions: number;
};

type IntentInput = {
  id: string;
  outcome: string;
  constraints?: string;
  status: IntentStatus;
  createdAt?: string;
  notes?: readonly { kind: string; at: string }[];
};

const statusTone: Record<IntentStatus, [Tone, string]> = {
  active: ['waiting', 'Waiting'],
  ready: ['passed', 'Ready'],
  completed: ['passed', 'Done'],
  abandoned: ['stale', 'Abandoned'],
};

export function intentRows(intents: readonly IntentInput[], lanes: readonly CockpitLane[]): IntentRow[] {
  return intents.map(intent => {
    const own = lanes.filter(lane => lane.intentId === intent.id);
    const planned = intentProgress(intent.status, own.length) === 'Planned';
    const open = own.filter(lane => lane.open);
    const worst = [...open].sort((a, b) => attentionRank[a.tone] - attentionRank[b.tone])[0];
    const [tone, label]: [Tone, string] = planned
      ? ['plain', 'Planned']
      : intent.status === 'active' && worst
        ? [worst.tone, worst.tone === 'stale' ? 'Stale' : toneLabel[worst.tone]]
        : statusTone[intent.status];
    const times = [
      intent.createdAt,
      ...own.map(lane => lane.lastAt),
      ...(intent.notes ?? []).map(note => note.at),
    ]
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      id: intent.id,
      outcome: intent.outcome,
      constraints: intent.constraints ?? '',
      status: intent.status,
      planned,
      ...(intent.createdAt ? { createdAt: intent.createdAt } : {}),
      lanes: own,
      open,
      tone,
      label,
      ...(times.length ? { lastAt: times.at(-1)! } : {}),
      notes: intent.notes?.length ?? 0,
      decisions: intent.notes?.filter(note => note.kind === 'decision').length ?? 0,
    };
  });
}

export type IntentFilter = 'open' | 'ready' | 'done' | 'planned' | 'all';
export function filterIntents(rows: readonly IntentRow[], filter: IntentFilter): IntentRow[] {
  const keep = (row: IntentRow) =>
    filter === 'all'
      ? true
      : filter === 'planned'
        ? row.planned
        : filter === 'done'
          ? row.status === 'completed' || row.status === 'abandoned'
          : filter === 'ready'
            ? row.status === 'ready' || (row.status === 'active' && row.tone === 'passed')
            : !row.planned && (row.status === 'active' || row.status === 'ready');
  return rows
    .filter(keep)
    .sort(
      (a, b) =>
        attentionRank[a.tone] - attentionRank[b.tone] || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''),
    );
}

/** Latest version of each planning item linked to an Intent. */
export function linkedPlanning<T extends { id: string; version: number; intentIds: readonly string[] }>(
  items: readonly T[],
  intentId: string,
): T[] {
  const latest = new Map<string, T>();
  for (const item of items) if ((latest.get(item.id)?.version ?? 0) < item.version) latest.set(item.id, item);
  return [...latest.values()].filter(item => item.intentIds.includes(intentId));
}
