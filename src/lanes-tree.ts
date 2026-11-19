// SPDX-License-Identifier: Apache-2.0
/** `lanes {"view":"tree"}` (Issue 57c6f3ec): which open Lanes stack on which, which overlap, and each
 * one's state and next step, from the one bounded `lanes` page. The Convex query pairs overlaps from
 * the slim presence rows it already reads (convex/projectHostedLiveLanes.ts); this module only renders
 * text and imports nothing, so loading it adds one chunk to `lanes {"view":"tree"}` and none elsewhere. The web
 * dependency graph (d35431d8) reads the same `stackOn` and `overlaps` fields. */
/** One overlap peer of a Lane: exact shared listed paths, or `maybe` when only a path filter matches. */
export type TreeOverlap = { laneId: string; paths: string[]; maybe?: true };

const GOAL_CHARS = 60;

export type TreeLane = {
  laneId: string;
  intent: string | null;
  lastSaveAt: string | null;
  landing: { state: string } | null;
  dormant?: boolean;
  stackOn?: string | null;
  held?: string;
  overlaps?: TreeOverlap[];
};

/** One word per Lane: new, saved, waiting, held, checking, ready, failed, landed (dormant appended). */
export function treeState(lane: TreeLane) {
  const phase = lane.landing?.state;
  const state = lane.held
    ? 'held'
    : phase === 'queued'
      ? 'waiting'
      : phase === 'terminal-failed'
        ? 'failed'
        : phase === 'checking' || phase === 'ready' || phase === 'landed'
          ? phase
          : lane.lastSaveAt
            ? 'saved'
            : 'new';
  return lane.dormant ? `${state}, dormant` : state;
}

function treeNext(lane: TreeLane, byId: ReadonlyMap<string, TreeLane>) {
  const state = treeState(lane).split(',')[0];
  if (state === 'landed') return 'none';
  if (state === 'failed') return 'fix, then land --save';
  if (state !== 'saved' && state !== 'new') return `status {"laneId":"${lane.laneId}"} names its wait`;
  if (lane.dormant) return 'resume or abandon: lanes {"view":"dormant"}';
  const parent = lane.stackOn ? byId.get(lane.stackOn) : undefined;
  if (parent && treeState(parent) !== 'landed') return `land after ${parent.laneId.slice(0, 8)}`;
  return state === 'saved' ? 'land --save' : 'edit, then save';
}

const clip = (text: string | null) =>
  !text ? '' : text.length > GOAL_CHARS ? `${text.slice(0, GOAL_CHARS - 1)}…` : text;

/** Text lines: stacks as trees (children under their parent), each Lane with state, goal, next step
 * and overlaps. Bounded by the page: one line per Lane plus one per overlapping Lane. */
export function renderLaneTree(lanes: readonly TreeLane[]) {
  const byId = new Map(lanes.map(lane => [lane.laneId, lane]));
  const children = new Map<string, TreeLane[]>();
  const roots: TreeLane[] = [];
  for (const lane of lanes) {
    const parent = lane.stackOn && byId.has(lane.stackOn) ? lane.stackOn : null;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), lane]);
    else roots.push(lane);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const visit = (lane: TreeLane, lead: string, branch: string) => {
    if (seen.has(lane.laneId)) return;
    seen.add(lane.laneId);
    const offPage =
      lane.stackOn && !byId.has(lane.stackOn) ? ` (stacked on ${lane.stackOn.slice(0, 8)})` : '';
    lines.push(
      `${lead}${branch}${lane.laneId.slice(0, 8)} [${treeState(lane)}] ${clip(lane.intent)}${offPage} · next: ${treeNext(lane, byId)}`,
    );
    const below = lead + (branch === '├─ ' ? '│  ' : branch ? '   ' : '');
    const overlaps = lane.overlaps ?? [];
    if (overlaps.length)
      lines.push(
        `${below}${children.has(lane.laneId) ? '│' : ' '}  overlaps: ${overlaps
          .map(o => `${o.laneId.slice(0, 8)}${o.maybe ? ' (maybe)' : ` (${o.paths.join(', ')})`}`)
          .join('; ')}`,
      );
    const kids = children.get(lane.laneId) ?? [];
    kids.forEach((kid, i) => visit(kid, below, i === kids.length - 1 ? '└─ ' : '├─ '));
  };
  for (const root of roots) visit(root, '', '');
  // A stack loop has no root on the page; list its Lanes flat rather than drop them.
  for (const lane of lanes) visit(lane, '', '');
  return lines;
}
