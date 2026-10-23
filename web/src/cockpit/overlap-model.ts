// SPDX-License-Identifier: Apache-2.0
import { overlappingPaths } from '../../../src/coordination-paths';
import type { CockpitLane } from './model';

export type OverlapParty = { label: string; laneId?: string; agent?: boolean; main?: boolean };
/** One file where work meets. Advisory: never a lock or a verdict. */
export type OverlapRow = {
  path: string;
  kind: 'edited' | 'claimed' | 'main';
  who: OverlapParty[];
  /** "edited by both · lines 40–61 and 48–70" */
  detail: string;
  /** What will happen, in one sentence. */
  meaning: string;
  /** The one action that helps: open a Lane to compare, or tell a session to wait. */
  action?: { label: string; laneId?: string; tell?: { recipient: string; name: string; laneId?: string } };
};

type Edit = { lane: CockpitLane; paths: readonly { path: string; lines?: readonly [number, number][] }[] };
type Claim = { label: string; owner: string; paths: readonly string[]; laneId?: string; recipient?: string };

const ranges = (lines?: readonly [number, number][]) =>
  lines?.length
    ? lines
        .slice(0, 2)
        .map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`))
        .join(', ')
    : '';
/** Overlapping paths named as specifically as either side claimed them: a file wins over its directory. */
function specific(a: readonly string[], b: readonly string[]): string[] {
  const all = [...new Set([...overlappingPaths(a, b), ...overlappingPaths(b, a)])];
  return all.filter(
    path => !all.some(other => other !== path && other.startsWith(path.endsWith('/') ? path : `${path}/`)),
  );
}
const party = (lane: CockpitLane): OverlapParty => ({
  label: lane.name,
  laneId: lane.id,
  agent: lane.session
    ? !lane.session.person
    : lane.startedBy
      ? lane.startedBy.kind === 'agent'
      : lane.byAgent,
});

/**
 * Files more than one open Lane edits, files claimed by more than one session, and files a Lane
 * edits that main changed since its base. Each row says what will happen and offers one action.
 */
export function overlapRows(
  edits: readonly Edit[],
  claims: readonly Claim[] = [],
  behindMain: readonly { lane: CockpitLane; paths: readonly string[] }[] = [],
): OverlapRow[] {
  const rows = new Map<string, OverlapRow>();
  const byPath = new Map<string, { lane: CockpitLane; lines?: readonly [number, number][] }[]>();
  for (const { lane, paths } of edits)
    for (const item of paths)
      byPath.set(item.path, [
        ...(byPath.get(item.path) ?? []),
        { lane, ...(item.lines ? { lines: item.lines } : {}) },
      ]);
  for (const [path, list] of byPath) {
    if (list.length < 2) continue;
    const lines = list.map(item => ranges(item.lines)).filter(Boolean);
    // The Lane further from acceptance is the one that will have to update.
    const second = list.find(item => item.lane.tone !== 'passed') ?? list[1]!;
    rows.set(path, {
      path,
      kind: 'edited',
      who: list.map(item => party(item.lane)),
      detail: `edited by ${list.length === 2 ? 'both' : `${list.length} Lanes`}${lines.length === list.length ? ` · lines ${lines.join(' and ')}` : ''}`,
      meaning: 'Whichever is accepted second will need to update from main.',
      action: { label: 'Compare', laneId: second.lane.id },
    });
  }
  for (let i = 0; i < claims.length; i++)
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!,
        b = claims[j]!;
      if (a.owner === b.owner) continue;
      for (const path of specific(a.paths, b.paths)) {
        if (rows.has(path)) continue;
        const later = b.recipient ? b : a.recipient ? a : undefined;
        rows.set(path, {
          path,
          kind: 'claimed',
          who: [a, b].map(claim => ({
            label: claim.label,
            agent: true,
            ...(claim.laneId ? { laneId: claim.laneId } : {}),
          })),
          detail: 'claimed by both, not yet edited',
          meaning: "Both said they'd change it. Usually fine.",
          ...(later
            ? {
                action: {
                  label: `Ask ${later.label} to wait`,
                  tell: {
                    recipient: later.recipient!,
                    name: later.label,
                    ...(later.laneId ? { laneId: later.laneId } : {}),
                  },
                },
              }
            : {}),
        });
      }
    }
  for (const { lane, paths } of behindMain)
    for (const path of paths) {
      if (rows.has(path)) continue;
      rows.set(path, {
        path,
        kind: 'main',
        who: [party(lane), { label: 'main', main: true }],
        detail: 'changed on main since this Lane started',
        meaning: `${lane.name} is behind main here. Updating from main may need a merge in this file.`,
        action: { label: 'Open Lane', laneId: lane.id },
      });
    }
  const order = { edited: 0, main: 1, claimed: 2 };
  return [...rows.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
}

/** How many other Lanes share a file with each Lane. */
export function overlapCounts(rows: readonly OverlapRow[]): Map<string, number> {
  const others = new Map<string, Set<string>>();
  for (const row of rows) {
    const lanes = row.who.flatMap(who => (who.laneId ? [who.laneId] : []));
    for (const id of lanes)
      for (const other of lanes) if (other !== id) others.set(id, (others.get(id) ?? new Set()).add(other));
  }
  return new Map([...others].map(([id, set]) => [id, set.size]));
}
