// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { selectPacks, type StoredPack } from './git-serve-protocol.js';

/** Lane refs over Git (Issue 09367fb2): which Lanes a ref listing names, and which packs a
 * fetch of Lane commits needs. Pure and portable (Convex V8). */
const laneRefPattern = /^refs\/forge\/lanes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** At most this many Lanes are built for one ref listing. */
export const namedLaneLimit = 8;
/** Lanes a ls-refs request names exactly (`git fetch origin refs/forge/lanes/<laneId>`). */
export function namedLanes(args: string[]) {
  const named = new Set<string>();
  for (const arg of args)
    if (arg.startsWith('ref-prefix ')) {
      const match = laneRefPattern.exec(arg.slice(11));
      if (match) named.add(match[1]!);
    }
  invariant(
    named.size <= namedLaneLimit,
    'GIT_UNSUPPORTED',
    `Fetch at most ${namedLaneLimit} Lane refs at a time.`,
  );
  return [...named];
}

/** A built Lane commit: its pack holds the commit and the trees and blobs its base commit
 * lacks; null when the saved head equals its base (the ref is the base commit). */
export type LanePack = { commit: string; pack: StoredPack | null };
/** Like selectPacks, with Lane commits as wants: a Lane needs history through the newest
 * stored pack (which covers every Lane's base commit) plus its own pack, unless the
 * client already has that commit. */
export function selectFetch(packs: StoredPack[], lanes: LanePack[], wants: string[], haves: string[]) {
  const tips = new Set(packs.map(pack => pack.tip));
  const byCommit = new Map(lanes.map((lane, i) => [lane.commit, i]));
  const laneWants = wants.filter(want => byCommit.has(want) && !tips.has(want));
  const mainWants = wants.filter(want => !laneWants.includes(want));
  if (laneWants.length && packs.length) mainWants.push(packs.at(-1)!.tip);
  invariant(mainWants.length, 'GIT_HISTORY_UNAVAILABLE', 'This project has no stored Git history.');
  const selected = selectPacks(packs, mainWants, haves);
  const chosen = [
    ...new Set(
      laneWants
        .map(want => byCommit.get(want)!)
        .filter(i => lanes[i]!.pack && !haves.includes(lanes[i]!.commit)),
    ),
  ];
  const common = selected.common ?? haves.find(have => byCommit.has(have)) ?? null;
  return { ...selected, common, lanes: chosen };
}

/** Public author of a Lane commit: the owner's Forge handle (with the agent slug when an
 * agent saved it), never a name or email address. */
export function laneAuthor(handle: string | null, agent?: string) {
  const login = handle || 'forge';
  return { name: agent ? `${login}/${agent}` : login, email: `${login}@users.noreply.forge` };
}
