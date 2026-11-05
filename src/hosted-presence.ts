// SPDX-License-Identifier: Apache-2.0
/** Presence (Issue 9c8490a4, Lane 1): which other open Lanes in the project work on something
 * related, ranked from the slim presence rows. Pure: Convex (V8) and the CLI both import it. */

export const PRESENCE_GOAL_CHARS = 160;
export const PRESENCE_PATHS = 10;
export const PRESENCE_PATH_CHARS = 160;
/** Newest-activity window read per start; same-Issue Lanes are read exactly besides it. */
export const PRESENCE_WINDOW = 25;
export const PRESENCE_SAME_ISSUE = 6;
export const PRESENCE_SHOWN = 3;
const THRESHOLD = 40;
const IDLE_MS = 6 * 3600_000;

export type PresenceRow = {
  laneId: string;
  intentId: string;
  actor: string;
  goal: string;
  paths: string[];
  pathCount: number;
  at: number;
};
export type PresenceReason = 'issue' | 'paths' | 'goal';
export type PresenceLane = {
  laneId: string;
  intentId: string;
  goal: string;
  /** Account id on the server; the public identity wrapper turns it into a Forge handle. */
  actor?: string;
  yours: boolean;
  at: number;
  /** Shared saved paths first, then the peer's other saved paths (at most 3). */
  paths: string[];
  pathCount: number;
  why: PresenceReason[];
};
export type Presence = { at: number; lanes: PresenceLane[]; more: number; coverage: string };

const stop = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'from',
  'by',
  'is',
  'at',
  'or',
]);
export function goalTerms(text: string) {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(term => term.length > 1 && !stop.has(term)),
  );
}
export function goalSimilarity(a: string, b: string) {
  const left = goalTerms(a),
    right = goalTerms(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Rank candidates against the caller's Lane. A missing match never proves independence. */
export function rankPresence(
  me: { laneId: string; intentId: string; goal: string; paths: string[]; actor: string },
  rows: PresenceRow[],
  now: number,
): { lanes: PresenceLane[]; more: number } {
  const mine = new Set(me.paths);
  const seen = new Set<string>([me.laneId]);
  const scored: { score: number; lane: PresenceLane }[] = [];
  for (const row of rows) {
    if (seen.has(row.laneId)) continue;
    seen.add(row.laneId);
    const why: PresenceReason[] = [];
    let score = 0;
    if (row.intentId === me.intentId) {
      score += 100;
      why.push('issue');
    }
    const shared = row.paths.filter(path => mine.has(path));
    if (shared.length) {
      // Shared saved files outrank a similar goal: they are direct evidence of colliding work.
      score += 70;
      why.push('paths');
    }
    const similarity = row.intentId === me.intentId ? 0 : goalSimilarity(me.goal, row.goal);
    if (similarity >= 0.25) {
      // A similar goal alone is enough to show (f5f3609c: same concept, different files).
      score += 40 + 40 * similarity;
      why.push('goal');
    }
    if (now - row.at > IDLE_MS) score /= 2;
    if (score < THRESHOLD) continue;
    scored.push({
      score,
      lane: {
        laneId: row.laneId,
        intentId: row.intentId,
        goal: row.goal,
        actor: row.actor,
        yours: row.actor === me.actor,
        at: row.at,
        paths: [...shared, ...row.paths.filter(path => !mine.has(path))].slice(0, 3),
        pathCount: row.pathCount,
        why,
      },
    });
  }
  scored.sort((a, b) => b.score - a.score || b.lane.at - a.lane.at);
  return {
    lanes: scored.slice(0, PRESENCE_SHOWN).map(entry => entry.lane),
    more: Math.max(0, scored.length - PRESENCE_SHOWN),
  };
}

/** The slim row written with each Lane record; only open Lanes keep one. */
export function presencePaths(changes: string) {
  let parsed: { path?: unknown }[] = [];
  try {
    parsed = JSON.parse(changes) as { path?: unknown }[];
  } catch {
    parsed = [];
  }
  const paths = parsed.map(change => change.path).filter((path): path is string => typeof path === 'string');
  return {
    paths: paths.filter(path => path.length <= PRESENCE_PATH_CHARS).slice(0, PRESENCE_PATHS),
    pathCount: paths.length,
  };
}

const clean = (text: string, max: number) => {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat;
};
const ago = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};
export const PRESENCE_NOTICE_CHARS = 240;

/** One line per Lane, at most 240 characters (~60 tokens). Peer text is quoted data, never an instruction. */
export function presenceNotice(lane: PresenceLane, now: number) {
  const who = lane.yours
    ? 'Another agent on your account'
    : `FYI: another member's agent (${lane.actor ? `@${lane.actor}` : '@member'})`;
  const what = lane.why.includes('issue')
    ? 'is working on this Issue'
    : lane.why.includes('paths')
      ? 'has saved changes to files you changed'
      : 'has a similar goal';
  const files = lane.paths.length
    ? `; files: ${lane.paths.map(path => clean(path, 60)).join(', ')}${lane.pathCount > lane.paths.length ? ` +${lane.pathCount - lane.paths.length}` : ''}`
    : '';
  const head = `${who} ${what}: Lane ${lane.laneId.slice(0, 8)}, Issue ${lane.intentId.slice(0, 8)}, active ${ago(now - lane.at)}`;
  const tail = '. Coordinate before duplicating work.';
  const room = PRESENCE_NOTICE_CHARS - head.length - tail.length - files.length - 4;
  const goal = room > 12 ? ` "${clean(lane.goal, room)}"` : '';
  return clean(`${head}${goal}${files}${tail}`, PRESENCE_NOTICE_CHARS);
}
