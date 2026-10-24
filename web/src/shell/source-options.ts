// SPDX-License-Identifier: Apache-2.0
import { age } from '../ui/status';
import type { GlyphName } from '../ui/Glyph';

/** One choice in the Code Source picker. Lane ids distinguish saves shared by several Lanes. */
export type SourceOption = {
  key: string;
  head: string;
  laneId?: string;
  name: string;
  meta: string;
  glyph: GlyphName;
};
type LaneInput = {
  id: string;
  name: string;
  head: string;
  state: string;
  assignment?: string;
  lastCheckpointAt?: string;
  main?: { included?: boolean | null };
};
type CandidateInput = {
  id: string;
  intentId: string;
  head?: string | null;
  at: string;
  inputs?: { laneId: string }[];
};
type MoveInput = { channel: string; viewId: string; at: string; status?: string; head?: string };
type RunInput = { viewId: string; status: string; startedAt?: string; endedAt?: string };

export const shortHash = (head: string) => head.slice(0, 8);
const RECENT_CANDIDATES = 5;

/** main · Open Lanes · Recent Candidates, newest first; the picker adds Exact head. */
export function sourceOptions({
  main,
  now,
  lanes,
  views,
  intents,
  moves,
  runs,
}: {
  main: string;
  now: number;
  lanes: readonly LaneInput[];
  views: readonly CandidateInput[];
  intents: readonly { id: string; outcome: string }[];
  moves: readonly MoveInput[];
  runs: readonly RunInput[];
}) {
  const accepted = new Map(
    moves
      .filter(move => move.channel === 'main' && (move.status === undefined || move.status === 'accepted'))
      .map(move => [move.viewId, move]),
  );
  const mainAt = [...accepted.values()].filter(move => move.head === main).at(-1)?.at;
  const mainOption: SourceOption = {
    key: 'main',
    head: main,
    name: 'main',
    meta: [mainAt && `accepted ${age(mainAt, now, true)}`, shortHash(main)].filter(Boolean).join(' · '),
    glyph: 'channel',
  };
  const open = lanes
    .filter(lane => !['completed', 'abandoned'].includes(lane.state) && !lane.main?.included)
    .sort((a, b) => (b.lastCheckpointAt ?? '').localeCompare(a.lastCheckpointAt ?? ''))
    .map((lane): SourceOption => ({
      key: `lane:${lane.id}`,
      head: lane.head,
      laneId: lane.id,
      name: lane.name,
      meta: [
        lane.assignment?.trim() || 'nobody working',
        lane.lastCheckpointAt ? `last save ${age(lane.lastCheckpointAt, now, true)}` : 'no saves yet',
      ].join(' · '),
      glyph: 'lane',
    }));
  const seen = new Set<string>();
  const candidates = views
    .filter((view): view is CandidateInput & { head: string } => Boolean(view.head))
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter(view => {
      // Only the newest Candidate per Intent and Lane set is current.
      const set = `${view.intentId}:${(view.inputs ?? [])
        .map(input => input.laneId)
        .sort()
        .join(',')}`;
      if (seen.has(set) || seen.has(view.head)) return false;
      seen.add(set).add(view.head);
      return true;
    })
    .slice(0, RECENT_CANDIDATES)
    .map((view): SourceOption => {
      const move = accepted.get(view.id);
      const run = runs.filter(run => run.viewId === view.id).at(-1);
      const state = move
        ? `accepted ${age(move.at, now, true)}`
        : run?.status === 'passed'
          ? `passed ${age(run.endedAt ?? run.startedAt, now, true)}`
          : run?.status === 'failed'
            ? 'check failed'
            : run && ['queued', 'running', 'preparing'].includes(run.status)
              ? 'checking'
              : age(view.at, now, true);
      return {
        key: `view:${view.id}`,
        head: view.head,
        name: intents.find(intent => intent.id === view.intentId)?.outcome ?? 'Intent',
        meta: state,
        glyph: 'view',
      };
    });
  return { main: mainOption, lanes: open, candidates };
}

/** The picker value for the source being read: a Lane save keeps its Lane name. */
export function currentSource(
  head: string,
  laneId: string | undefined,
  options: ReturnType<typeof sourceOptions>,
  lanes: readonly { id: string; name: string; head: string }[],
): SourceOption {
  const lane = lanes.find(lane => lane.id === laneId);
  if (lane)
    return {
      key: lane.head === head ? `lane:${lane.id}` : 'saved-lane',
      head,
      laneId: lane.id,
      name: lane.name,
      meta: lane.head === head ? `latest save · ${shortHash(head)}` : `save ${shortHash(head)}`,
      glyph: 'lane',
    };
  if (head === options.main.head) return options.main;
  const candidate = options.candidates.find(option => option.head === head);
  if (candidate) return { ...candidate, meta: `${candidate.meta} · ${shortHash(head)}` };
  return { key: 'exact', head, name: 'Exact head', meta: shortHash(head), glyph: 'check' };
}

/** A full hash, or an unambiguous prefix (7+) of a known head. */
export function resolveHead(value: string, known: readonly string[]): string | null {
  const hash = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hash)) return hash;
  if (!/^[0-9a-f]{7,63}$/.test(hash)) return null;
  const matches = [...new Set(known.filter(head => head.startsWith(hash)))];
  return matches.length === 1 ? matches[0]! : null;
}
