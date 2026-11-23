// SPDX-License-Identifier: Apache-2.0
// Where Lanes cross, by pair (Item df1f2d46): the shared files the overlap read already sends, turned into the pairs of
// Items that touch the same files, most at risk first. An Item's open Lanes count as one side, so its title shows
// once; its Lanes that cross each other are a pair of their own. Built in the browser from reads the page already
// holds: no read of its own. Saved work only; a conflict is one Forge observed on a Lane (the caller's predicate).
import type { SharedFile } from './model';

/** One side of a pair: an Item (its Lanes together) or a Lane with no Item. */
export type CrossSide = { key: string; title: string };
export type CrossPair = {
  key: string;
  a: CrossSide;
  /** null: the Lanes of `a` cross each other. */
  b: CrossSide | null;
  /** The pair's Lanes on each side, in first-seen order. */
  aLanes: string[];
  bLanes: string[];
  /** The pair's Lanes the caller's predicate says Forge observed a conflict on. */
  conflicted: string[];
  /** How many shared files the pair has; `pairPaths` lists them. */
  files: number;
};
export type Folder = { dir: string; names: string[] };

/** Folders of a pair, most shared files first; the folder is the path up to its last `/` ('' at the top). Names keep
 * their order; a folder sorts its own when it is opened. */
export function byFolder(paths: readonly string[]): Folder[] {
  const dirs = new Map<string, string[]>();
  for (const path of paths) {
    const cut = path.lastIndexOf('/') + 1;
    const dir = path.slice(0, cut);
    const names = dirs.get(dir) ?? [];
    names.push(path.slice(cut));
    dirs.set(dir, names);
  }
  return [...dirs]
    .map(([dir, names]) => ({ dir, names }))
    .sort((x, y) => y.names.length - x.names.length || x.dir.localeCompare(y.dir));
}

/**
 * Pairs of sides that saved the same files: pairs with a conflict first, then most shared files (the band keeps the
 * file order). One pass over the shared files; each file costs its sides squared (at most 50 Lanes on a file). A pair
 * keeps counts and Lanes only, so 1,225 pairs over 5,000 files hold no path lists; `pairPaths` lists one pair's files
 * when it is drawn.
 */
export function crossPairs(
  files: readonly SharedFile[],
  sideOf: (laneId: string) => CrossSide,
  conflicted: (laneId: string) => boolean,
): CrossPair[] {
  const pairs = new Map<string, CrossPair>();
  const add = (a: CrossSide, b: CrossSide | null, aLanes: string[], bLanes: string[]) => {
    const key = b ? `${a.key}\n${b.key}` : a.key;
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { key, a, b, aLanes: [], bLanes: [], conflicted: [], files: 0 }));
    for (const id of aLanes) if (!pair.aLanes.includes(id)) pair.aLanes.push(id);
    for (const id of bLanes) if (!pair.bLanes.includes(id)) pair.bLanes.push(id);
    pair.files += 1;
  };
  for (const file of files) {
    const list = [...sidesOf(file, sideOf).values()].sort((x, y) => (x.side.key < y.side.key ? -1 : 1));
    for (const [i, one] of list.entries()) {
      if (one.lanes.length > 1) add(one.side, null, one.lanes, []);
      for (const other of list.slice(i + 1)) add(one.side, other.side, one.lanes, other.lanes);
    }
  }
  return [...pairs.values()]
    .map(pair => ({ ...pair, conflicted: [...pair.aLanes, ...pair.bLanes].filter(conflicted) }))
    .sort(
      (x, y) =>
        Number(y.conflicted.length > 0) - Number(x.conflicted.length > 0) ||
        y.files - x.files ||
        x.a.title.localeCompare(y.a.title) ||
        x.key.localeCompare(y.key),
    );
}

function sidesOf(file: SharedFile, sideOf: (laneId: string) => CrossSide) {
  const sides = new Map<string, { side: CrossSide; lanes: string[] }>();
  for (const laneId of file.laneIds) {
    const side = sideOf(laneId);
    const entry = sides.get(side.key) ?? { side, lanes: [] };
    entry.lanes.push(laneId);
    sides.set(side.key, entry);
  }
  return sides;
}

/** One pair's shared files: a file is the pair's when a Lane of each side saved it (two of the Item's own Lanes for an
 * Item crossing itself). One pass over the shared files, for a pair being drawn. */
export function pairPaths(files: readonly SharedFile[], pair: CrossPair): string[] {
  const a = new Set(pair.aLanes);
  const b = new Set(pair.bLanes);
  return files
    .filter(file => {
      const inA = file.laneIds.filter(id => a.has(id)).length;
      return pair.b ? inA > 0 && file.laneIds.some(id => b.has(id)) : inA > 1;
    })
    .map(file => file.path);
}

/** The side most shared files touch, when it touches at least half of them (and there are two sides or more):
 * the one fact that explains most of the list. */
export function mostlyOne(
  files: readonly SharedFile[],
  sideOf: (laneId: string) => CrossSide,
): { side: CrossSide; files: number } | null {
  if (files.length < 2) return null;
  const count = new Map<string, { side: CrossSide; files: number }>();
  for (const file of files) {
    const seen = new Set<string>();
    for (const laneId of file.laneIds) {
      const side = sideOf(laneId);
      if (seen.has(side.key)) continue;
      seen.add(side.key);
      const entry = count.get(side.key) ?? { side, files: 0 };
      entry.files += 1;
      count.set(side.key, entry);
    }
  }
  if (count.size < 2) return null;
  const top = [...count.values()].sort((x, y) => y.files - x.files)[0]!;
  return top.files * 2 >= files.length ? top : null;
}
