// SPDX-License-Identifier: Apache-2.0
// Where the Flow picture's parts stand for a given width (Item 85f456c1, the approved home mock): an isometric
// platform per stop on a zigzag, a block per open Lane, Lanes checked together in one tower, main as the day's
// landings, and two rails back to Editing. Three sizes by the width the region gives it: under 640, 640 to 999, and
// 1000 and over. Pure numbers; Picture.tsx draws them. Flat fills only: no glow, gradient or shadow.
import type { Station } from './model';

const CX = 0.866;
const CY = 0.5;
type Point = [number, number];
const P = (du: number, dv: number, dz: number): Point => [(du - dv) * CX, (du + dv) * CY - dz];
const at = (cx: number, cy: number, du: number, dv: number, dz: number): Point => {
  const [x, y] = P(du, dv, dz);
  return [cx + x, cy + y];
};
const f = (n: number) => n.toFixed(1);
const poly = (pts: readonly Point[]) => `M${pts.map(p => `${f(p[0])} ${f(p[1])}`).join('L')}Z`;

/** The size step for a width: 0 under 640, 1 from 640, 2 from 1000. */
export const tierOf = (width: number) => (width >= 1000 ? 2 : width >= 640 ? 1 : 0);

export function config(width: number) {
  const t = tierOf(width);
  const s = [12, 15, 18][t]!;
  const g = s + 2;
  const n = t ? 4 : 3;
  const half = (n * g) / 2 + 5;
  const tip = half * 2 * CX;
  return {
    t,
    s,
    g,
    n,
    half,
    mL: t === 2 ? 232 : tip + 14,
    mR: t === 2 ? 96 : tip + 12,
    lw: 172,
    mh: [64, 92, 120][t]!,
    up: 70,
  };
}
export type Config = ReturnType<typeof config>;

/** One block's three faces and its glyphs, around the origin. */
export function cubeArt(s: number) {
  const a = s / 2;
  const b = a * 0.5;
  const p = (du: number, dv: number, dz: number) => P(du, dv, dz);
  return {
    t: poly([p(-a, -a, s), p(a, -a, s), p(a, a, s), p(-a, a, s)]),
    l: poly([p(-a, a, s), p(a, a, s), p(a, a, 0), p(-a, a, 0)]),
    r: poly([p(a, -a, s), p(a, a, s), p(a, a, 0), p(a, -a, 0)]),
    hole: poly([p(-b, -b, s), p(b, -b, s), p(b, b, s), p(-b, b, s)]),
    cross: `M${p(-b, 0, s).map(f).join(' ')}L${p(b, 0, s).map(f).join(' ')}M${p(0, -b, s).map(f).join(' ')}L${p(0, b, s).map(f).join(' ')}`,
    dia: poly([p(-b, 0, s), p(0, -b, s), p(b, 0, s), p(0, b, s)]),
  };
}

/** Where each block of a stop stands: a grid of n × n per layer; at Checking one tower per check, then the rest. */
export function placeBlocks(station: Station, c: Config, cx: number, cy: number) {
  const { n, g, s } = c;
  const put = (col: number, row: number, layer: number) =>
    at(cx, cy, (col - (n - 1) / 2) * g, (row - (n - 1) / 2) * g, layer * s);
  const out: { laneId: string; x: number; y: number }[] = [];
  // Past the feed's cap the moving Lanes are one solid at the back; held Lanes stand in front of it, one row a layer.
  if (station.solid) {
    station.blocks.forEach((block, i) => {
      const [x, y] = put(i % n, n - 1, Math.floor(i / n));
      out.push({ laneId: block.laneId, x, y });
    });
    return out;
  }
  if (station.stop === 'checking') {
    const sizes = new Map<string, number>();
    for (const block of station.blocks)
      if (block.check) sizes.set(block.check, (sizes.get(block.check) ?? 0) + 1);
    const heights = Array<number>(n * (n - 1)).fill(0);
    const towers = new Map<string, { slot: number; layer: number }>();
    for (const [check, size] of sizes) {
      const slot = towers.size % heights.length;
      towers.set(check, { slot, layer: heights[slot]! });
      // Keep later checks distinct when more groups exist than the rear grid can hold.
      heights[slot] = heights[slot]! + size + 0.35;
    }
    let rest = 0;
    for (const block of station.blocks) {
      const tower = block.check ? towers.get(block.check) : undefined;
      const [x, y] = tower
        ? put(tower.slot % n, Math.floor(tower.slot / n), tower.layer++)
        : put(rest % n, n - 1, Math.floor(rest++ / n));
      out.push({ laneId: block.laneId, x, y });
    }
    return out;
  }
  station.blocks.forEach((block, i) => {
    const [x, y] = put((i % (n * n)) % n, Math.floor((i % (n * n)) / n), Math.floor(i / (n * n)));
    out.push({ laneId: block.laneId, x, y });
  });
  return out;
}

/** Past the cap: a stop's solid stands as tall as its count, from one block's height up to main's full height. */
export const solidHeight = (station: Station, c: Config) =>
  station.solid ? c.s + Math.min(1, station.solid / 40) * (c.mh - c.s) : 0;
/** The solid's three faces: a column at the back of its platform, the front row left for held Lanes. */
export function solid(cx: number, cy: number, c: Config, height: number) {
  const hm = ((c.n - 1) * c.g) / 2;
  const back = -c.g / 2;
  const p = (du: number, dv: number, dz: number) => at(cx, cy, du + back, dv + back, dz);
  const w = hm * 0.75;
  return {
    l: poly([p(-w, w, height), p(w, w, height), p(w, w, 0), p(-w, w, 0)]),
    r: poly([p(w, -w, height), p(w, w, height), p(w, w, 0), p(w, -w, 0)]),
    t: poly([p(-w, -w, height), p(w, -w, height), p(w, w, height), p(-w, w, height)]),
  };
}
/** How tall a stop's blocks stand, for the space above it. */
function stack(station: Station, c: Config) {
  if (!station.n) return 0;
  if (station.solid) return Math.max(solidHeight(station, c), Math.ceil(station.blocks.length / c.n) * c.s);
  if (station.stop === 'checking')
    return Math.max(0, ...placeBlocks(station, c, 0, 0).map(block => 1.5 * c.s - block.y));
  return Math.ceil(station.n / (c.n * c.n)) * c.s;
}
/** Tag lines a stop's label carries at the two smaller sizes: two, then "and N more". */
const chips = (station: Station | undefined) => {
  const h = station?.held.length ?? 0;
  return Math.min(h, 2) + (h > 2 ? 1 : 0);
};

/** Where the five stops stand for a width: the zigzag's centres, the two rails' heights and the total height. */
export function layout(stations: readonly Station[], today: number, width: number, c: Config) {
  const stops = stations.length + 1;
  const steps = stops - 1;
  const half = c.half;
  const d = Math.min(250, (width - c.mL - c.mR) / (steps * CX));
  const mainH = Math.max(6, Math.min(0.5, c.mh / Math.max(today, 1)) * today);
  const labH = c.t ? 50 : 30;
  const tops = [stack(stations[0]!, c) + half, 0, stack(stations[2]!, c) + half, 0, mainH + half * 0.72];
  const upper =
    c.t === 2
      ? Math.max(c.up + 60, mainH + half + 34, stack(stations[2]!, c) + half + c.up)
      : 14 + labH + Math.max(chips(stations[0]), chips(stations[2])) * 24 + 8 + Math.max(...tops);
  const checkingHeadroom = stack(stations[3]!, c) - d * CY + 48;
  const oy = Math.max(upper, checkingHeadroom);
  const foot = c.t === 2 ? 128 : 12 + labH + Math.max(chips(stations[1]), chips(stations[3])) * 24 + 18;
  const G: Point[] = [
    [0, 0],
    [d, 0],
    [d, -d],
    [2 * d, -d],
    [2 * d, -2 * d],
  ];
  const C = G.slice(0, stops).map(([u, v]): Point => [c.mL + (u - v) * CX, oy + (u + v) * CY]);
  const y1 = oy + d * CY + half + foot;
  const y2 = y1 + 28;
  return { C, d, y1, y2, height: y2 + 26, tops, mainH };
}

/** A platform's three faces around a centre. */
export function platform(cx: number, cy: number, half: number) {
  const k = 5;
  const p = (du: number, dv: number, dz: number) => at(cx, cy, du, dv, dz);
  return {
    l: poly([p(-half, half, 0), p(half, half, 0), p(half, half, -k), p(-half, half, -k)]),
    r: poly([p(half, -half, 0), p(half, half, 0), p(half, half, -k), p(half, -half, -k)]),
    top: poly([p(-half, -half, 0), p(half, -half, 0), p(half, half, 0), p(-half, half, 0)]),
  };
}

/** main: the day's landings laid down hour by hour, a seam per hour, a check or a cross on top. */
export function strata(
  cx: number,
  cy: number,
  half: number,
  hours: readonly number[],
  height: number,
  red: boolean,
) {
  const hm = half * 0.72;
  const p = (du: number, dv: number, dz: number) => at(cx, cy, du, dv, dz);
  const total = hours.reduce((a, b) => a + b, 0);
  const k = total ? height / total : 0;
  let z = 0;
  const seams: string[] = [];
  for (const v of hours) {
    z += v * k;
    if (v && z < height - 1)
      seams.push(
        `M${p(-hm, hm, z).map(f).join(' ')}L${p(hm, hm, z).map(f).join(' ')}L${p(hm, -hm, z).map(f).join(' ')}`,
      );
  }
  const q = hm * 0.45;
  const H = height;
  return {
    l: poly([p(-hm, hm, H), p(hm, hm, H), p(hm, hm, 0), p(-hm, hm, 0)]),
    r: poly([p(hm, -hm, H), p(hm, hm, H), p(hm, hm, 0), p(hm, -hm, 0)]),
    t: poly([p(-hm, -hm, H), p(hm, -hm, H), p(hm, hm, H), p(-hm, hm, H)]),
    seams,
    glyph: red
      ? `M${p(-q, 0, H).map(f).join(' ')}L${p(q, 0, H).map(f).join(' ')}M${p(0, -q, H).map(f).join(' ')}L${p(0, q, H).map(f).join(' ')}`
      : `M${p(-q, q * 0.1, H)
          .map(f)
          .join(' ')}L${p(-q * 0.2, q * 0.8, H)
          .map(f)
          .join(' ')}L${p(q, -q * 0.7, H)
          .map(f)
          .join(' ')}`,
  };
}

export const ISO = { CX, CY };
