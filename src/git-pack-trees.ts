// SPDX-License-Identifier: Apache-2.0
import { inflateSync } from 'node:zlib';
import { applyGitDelta } from './git-pack-delta.js';
import { gitHash } from './hosted-github-git.js';

/** Tree objects from stored Git packs (Issue 3bd4a8e9): a Lane build lists its parent commit's
 * tree from the history packs instead of reading every file to hash it. Packs are fed in order
 * as byte parts (R2 chunks); every object is inflated once to find the next, and only trees
 * (whole, or deltas against a tree) are kept. Commits and blobs are skipped. */
export type TreeListing = Map<string, { mode: string; sha: string }>;

const commit = 1,
  tree = 2,
  ofsDelta = 6,
  refDelta = 7;
export class PackTrees {
  /** Tree id -> its bytes, or its delta and base tree id; deltas stay small, so a pack's
   * every tree version fits where whole copies would not. */
  private readonly entries = new Map<string, { data: Buffer; base: string | null }>();
  /** Recently resolved delta trees (bounded): most deltas name a recent base. */
  private readonly cache = new Map<string, Buffer>();
  private cached = 0;
  /** Tree bytes kept (whole trees and deltas); past `budget` the scan gives up. */
  kept = 0;
  scanned = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private at = 0; // pack offset of buffer[0]
  private left = -1; // objects still to read in this pack; -1 before its header
  private treeAt = new Map<number, string>(); // pack offset -> tree id, this pack only
  /** With `objects`, every tree id and every id a tree names (blobs, subtrees, gitlinks): the
   * objects stored history holds, so a new pack never repeats one. With `commit`, that commit's
   * bytes when the scan meets it whole. */
  readonly objects: Set<string> | null;
  commit: Buffer | null = null;
  constructor(
    private readonly budget: number,
    options: { objects?: boolean; commit?: string; cacheBytes?: number } = {},
  ) {
    this.objects = options.objects ? new Set() : null;
    this.wanted = options.commit ?? null;
    this.cacheBytes = options.cacheBytes ?? 16 * 1024 * 1024;
  }
  private readonly wanted: string | null;
  private readonly cacheBytes: number;

  get size() {
    return this.entries.size;
  }
  /** A tree's bytes by id, resolving its delta chain; undefined when no pack scanned holds it. */
  get(id: string): Buffer | undefined {
    const chain: { id: string; data: Buffer }[] = [];
    let bytes: Buffer | undefined;
    for (let at: string | null = id; at;) {
      bytes = this.cache.get(at);
      if (bytes) break;
      const entry = this.entries.get(at);
      if (!entry) return undefined;
      if (!entry.base) {
        bytes = entry.data;
        break;
      }
      chain.push({ id: at, data: entry.data });
      at = entry.base;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      bytes = applyGitDelta(bytes!, chain[i]!.data);
      this.remember(chain[i]!.id, bytes);
    }
    return bytes;
  }
  private remember(id: string, bytes: Buffer) {
    if (bytes.length > this.cacheBytes) return;
    this.cache.delete(id);
    this.cache.set(id, bytes);
    this.cached += bytes.length;
    for (const [old, value] of this.cache) {
      if (this.cached <= this.cacheBytes) break;
      this.cache.delete(old);
      this.cached -= value.length;
    }
  }

  /** Starts the next pack; deltas never cross packs (stored packs are not thin). */
  startPack() {
    this.buffer = Buffer.alloc(0);
    this.at = 0;
    this.left = -1;
    this.treeAt = new Map();
  }
  /** Feeds the next bytes of the current pack. Returns false once over budget or malformed:
   * the result is then unusable and the caller stops. `last` marks the pack's final part. */
  push(part: Uint8Array, last: boolean) {
    this.scanned += part.length;
    const view = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, view]) : view;
    let pos = 0;
    if (this.left < 0) {
      if (this.buffer.length < 12) return !last;
      if (this.buffer.toString('latin1', 0, 4) !== 'PACK') return false;
      this.left = this.buffer.readUInt32BE(8);
      pos = 12;
    }
    while (this.left > 0) {
      const object = this.object(pos, last);
      if (object === 'more') break;
      if (object === 'bad') return false;
      pos = object;
      this.left--;
      if (this.kept > this.budget) return false;
    }
    this.at += pos;
    this.buffer = this.buffer.subarray(pos);
    return this.left === 0 || !last;
  }
  /** Reads one object at `pos`; returns the next position, or 'more' when the bytes end first. */
  private object(pos: number, last: boolean): number | 'more' | 'bad' {
    const bytes = this.buffer,
      offset = this.at + pos;
    let i = pos;
    if (i >= bytes.length) return last ? 'bad' : 'more';
    let byte = bytes[i++]!;
    const type = (byte >> 4) & 7;
    let size = byte & 15,
      shift = 4;
    while (byte & 128) {
      if (i >= bytes.length) return last ? 'bad' : 'more';
      if (shift > 49) return 'bad';
      byte = bytes[i++]!;
      size += (byte & 127) * 2 ** shift;
      shift += 7;
    }
    let base: string | undefined;
    if (type === ofsDelta) {
      if (i >= bytes.length) return last ? 'bad' : 'more';
      byte = bytes[i++]!;
      let back = byte & 127;
      while (byte & 128) {
        if (i >= bytes.length) return last ? 'bad' : 'more';
        byte = bytes[i++]!;
        back = (back + 1) * 128 + (byte & 127);
      }
      base = this.treeAt.get(offset - back);
    } else if (type === refDelta) {
      if (i + 20 > bytes.length) return last ? 'bad' : 'more';
      const id = bytes.toString('hex', i, i + 20);
      i += 20;
      if (this.entries.has(id)) base = id;
    } else if (type < 1 || type > 4) return 'bad';
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(bytes.subarray(i), {
        info: true,
        maxOutputLength: size + 1,
      }) as unknown as typeof inflated;
    } catch {
      return last ? 'bad' : 'more';
    }
    if (inflated.buffer.length !== size || inflated.engine.bytesWritten <= 0) return 'bad';
    const next = i + inflated.engine.bytesWritten;
    if (type === tree || base !== undefined) {
      let bytes = inflated.buffer;
      try {
        if (base !== undefined) bytes = applyGitDelta(this.get(base)!, bytes);
      } catch {
        return 'bad';
      }
      const id = gitHash('tree', bytes);
      if (!this.entries.has(id)) {
        if (this.objects) {
          this.objects.add(id);
          if (!this.collect(bytes)) return 'bad';
        }
        // A delta whose result is already kept whole is dropped; deltas never form a cycle
        // because a base is always an earlier, already-kept tree.
        this.entries.set(id, { data: inflated.buffer, base: base ?? null });
        this.kept += inflated.buffer.length;
        if (base !== undefined) this.remember(id, bytes);
      }
      this.treeAt.set(offset, id);
    } else if (
      type === commit &&
      this.wanted &&
      !this.commit &&
      gitHash('commit', inflated.buffer) === this.wanted
    )
      this.commit = inflated.buffer;
    return next;
  }
  private collect(bytes: Buffer) {
    for (let at = 0; at < bytes.length;) {
      const nul = bytes.indexOf(0, at);
      if (nul < 0 || nul + 21 > bytes.length) return false;
      const id = bytes.toString('hex', nul + 1, nul + 21);
      if (!this.objects!.has(id)) {
        this.objects!.add(id);
        this.kept += 64;
      }
      at = nul + 21;
    }
    return true;
  }
}

/** The tree id a commit object names. */
export const commitTree = (bytes: Buffer) =>
  /^tree ([0-9a-f]{40})\n/.exec(bytes.toString('latin1', 0, 46))?.[1] ?? null;
/** An object id set as sorted raw 20-byte ids (an R2 object), and back. */
export function objectSetBytes(ids: Iterable<string>) {
  return Buffer.concat([...new Set(ids)].sort().map(id => Buffer.from(id, 'hex')));
}
export function readObjectSet(bytes: Buffer, into = new Set<string>()) {
  for (let at = 0; at + 20 <= bytes.length; at += 20) into.add(bytes.toString('hex', at, at + 20));
  return into;
}

/** Every blob, executable, symlink and gitlink path under `root`, or null when a tree is
 * missing or malformed. */
export function listTree(trees: { get(id: string): Buffer | undefined }, root: string): TreeListing | null {
  const listing: TreeListing = new Map();
  const walk = (id: string, prefix: string): boolean => {
    const bytes = trees.get(id);
    if (!bytes) return false;
    let at = 0;
    while (at < bytes.length) {
      const space = bytes.indexOf(0x20, at),
        nul = bytes.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 21 > bytes.length) return false;
      const mode = bytes.toString('latin1', at, space),
        name = bytes.toString('utf8', space + 1, nul),
        sha = bytes.toString('hex', nul + 1, nul + 21);
      at = nul + 21;
      if (mode === '40000') {
        if (!walk(sha, `${prefix}${name}/`)) return false;
      } else listing.set(prefix + name, { mode, sha });
    }
    return true;
  };
  try {
    return walk(root, '') ? listing : null;
  } catch {
    return null; // a delta that does not apply
  }
}
