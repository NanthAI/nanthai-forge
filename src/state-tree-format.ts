// SPDX-License-Identifier: Apache-2.0
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';

/** Tree form of a State: folders are Git tree objects, each stored with the Forge SHA-256 identity
 * of every entry and the place of every child folder. A save writes one segment holding only the
 * folders on its changed paths. Everything here runs in Node and in Convex's V8 runtime. */
export type TreeMode = '100644' | '100755' | '120000' | '160000' | '40000';
/** Where a stored record lives: a segment object (its SHA-256 and exact size) and a byte range. */
export type Locator = { segment: string; size: number; offset: number; length: number };
export type TreeEntry = {
  name: string;
  mode: TreeMode;
  /** Git SHA-1: blob id, pinned submodule commit, or child tree id. */
  oid: string;
  /** Forge SHA-256: file blob id, or child node id. */
  id: string;
  /** Child folders only. */
  at?: Locator;
};
/** A stored folder: its node id (what walks compare), its Git tree id and its place. */
export type TreeRef = { id: string; oid: string; at: Locator };
export type TreeFile = { mode: NativeFile['mode']; blob: string; oid: string };

/** Folders above this many entries are stored as chunks, so an edit rewrites one chunk. */
export const WIDE_TREE_ENTRIES = 512;
/** A chunk ends after an entry whose name hash is 0 modulo this: about this many entries each. */
export const WIDE_CHUNK_MODULUS = 64;
/** The segment a builder is still writing; it has no digest yet. */
export const PENDING_SEGMENT = '';

const gitModes = { file: '100644', executable: '100755', symlink: '120000', gitlink: '160000' } as const;
const fileModes = {
  '100644': 'file',
  '100755': 'executable',
  '120000': 'symlink',
  '160000': 'gitlink',
} as const;
export const treeMode = (mode: NativeFile['mode']): TreeMode => gitModes[mode];
export const fileMode = (mode: TreeMode): NativeFile['mode'] | undefined =>
  fileModes[mode as keyof typeof fileModes];
export const fail: (condition: unknown) => asserts condition = condition =>
  invariant(condition, 'GIT_OBJECT_INVALID', 'A stored source tree is invalid.');

export function gitId(type: 'blob' | 'tree', bytes: Uint8Array): string {
  return bytesToHex(
    sha1
      .create()
      .update(utf8ToBytes(`${type} ${bytes.length}\0`))
      .update(bytes)
      .digest(),
  );
}
const text = new TextDecoder('utf-8', { fatal: true });
export function compareBytes(a: Uint8Array, b: Uint8Array) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
/** Git orders entries by name bytes, with a folder compared as `name/`. */
export function sortEntries(entries: Iterable<TreeEntry>): TreeEntry[] {
  return [...entries]
    .map(entry => ({ entry, key: utf8ToBytes(entry.mode === '40000' ? `${entry.name}/` : entry.name) }))
    .sort((a, b) => compareBytes(a.key, b.key))
    .map(item => item.entry);
}
/** The Git tree object body for entries already in Git order. */
export function treeBytes(entries: readonly TreeEntry[]): Uint8Array {
  return concatBytes(
    ...entries.flatMap(entry => [utf8ToBytes(`${entry.mode} ${entry.name}\0`), hexToBytes(entry.oid)]),
  );
}
function parseTree(bytes: Uint8Array): Omit<TreeEntry, 'id'>[] {
  const entries: Omit<TreeEntry, 'id'>[] = [];
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(0x20, at),
      nul = bytes.indexOf(0, space + 1);
    fail(space > at && nul > space + 1 && nul + 21 <= bytes.length);
    const mode = new TextDecoder('latin1').decode(bytes.subarray(at, space)) as TreeMode;
    fail(mode === '40000' || fileMode(mode));
    let name: string;
    try {
      name = text.decode(bytes.subarray(space + 1, nul));
    } catch {
      fail(false);
    }
    fail(!name.includes('/'));
    entries.push({ mode, name, oid: bytesToHex(bytes.subarray(nul + 1, nul + 21)) });
    at = nul + 21;
  }
  return entries;
}

function varint(value: number): number[] {
  fail(Number.isSafeInteger(value) && value >= 0);
  const out: number[] = [];
  for (; value >= 0x80; value = Math.floor(value / 0x80)) out.push((value % 0x80) | 0x80);
  out.push(value);
  return out;
}
class Cursor {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  varint(): number {
    let value = 0,
      scale = 1;
    for (;;) {
      fail(this.at < this.bytes.length && scale <= 2 ** 49);
      const byte = this.bytes[this.at++]!;
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 0x80;
    }
  }
  take(length: number): Uint8Array {
    fail(length >= 0 && this.at + length <= this.bytes.length);
    return this.bytes.subarray(this.at, (this.at += length));
  }
}

/** The identity of a folder record: its Git tree bytes and the SHA-256 id of every entry. Places
 * are not part of it, so the same folder stored in two segments has one identity. */
function nodeId(tree: Uint8Array, ids: Uint8Array): string {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, tree.length);
  return bytesToHex(
    sha256.create().update(utf8ToBytes('forge-tree-node\n')).update(length).update(tree).update(ids).digest(),
  );
}
export function wideId(chunks: readonly string[]): string {
  return bytesToHex(
    sha256
      .create()
      .update(utf8ToBytes('forge-tree-wide\n'))
      .update(hexToBytes(chunks.join('')))
      .digest(),
  );
}
/** Segment table index of a locator: 0 is the segment being read or written. */
export type SegmentIndex = (segment: string, size: number) => number;
export type SegmentAt = (index: number) => { segment: string; size: number };

/** One record holding entries in Git order (a whole folder, or one chunk of a wide folder). */
export function encodeNode(entries: readonly TreeEntry[], segmentIndex: SegmentIndex) {
  const tree = treeBytes(entries),
    ids = hexToBytes(entries.map(entry => entry.id).join('')),
    places = entries
      .filter(entry => entry.mode === '40000')
      .flatMap(entry => {
        fail(entry.at);
        return [
          ...varint(segmentIndex(entry.at.segment, entry.at.size)),
          ...varint(entry.at.offset),
          ...varint(entry.at.length),
        ];
      });
  fail(ids.length === 32 * entries.length);
  return {
    id: nodeId(tree, ids),
    tree,
    bytes: concatBytes(
      Uint8Array.of(1, ...varint(entries.length), ...varint(tree.length)),
      tree,
      ids,
      Uint8Array.from(places),
    ),
  };
}
export type DecodedRecord =
  | { kind: 'node'; id: string; tree: Uint8Array; entries: TreeEntry[] }
  | { kind: 'wide'; id: string; chunks: { id: string; at: Locator }[] };
/** Decode one record and compute its identity from its own bytes; the caller compares that with
 * the identity it asked for. */
export function decodeRecord(bytes: Uint8Array, segmentAt: SegmentAt): DecodedRecord {
  const cursor = new Cursor(bytes),
    kind = cursor.take(1)[0],
    count = cursor.varint();
  const place = (): Locator => {
    const { segment, size } = segmentAt(cursor.varint()),
      offset = cursor.varint(),
      length = cursor.varint();
    fail(length > 0 && offset + length <= size);
    return { segment, size, offset, length };
  };
  if (kind === 2) {
    fail(count > 1);
    const ids = cursor.take(32 * count),
      chunks = Array.from({ length: count }, (_, i) => ({
        id: bytesToHex(ids.subarray(32 * i, 32 * i + 32)),
        at: place(),
      }));
    fail(cursor.at === bytes.length);
    return { kind: 'wide', id: wideId(chunks.map(chunk => chunk.id)), chunks };
  }
  fail(kind === 1);
  const tree = cursor.take(cursor.varint()),
    ids = cursor.take(32 * count),
    parsed = parseTree(tree);
  fail(parsed.length === count);
  const entries = parsed.map((entry, i): TreeEntry => {
    const id = bytesToHex(ids.subarray(32 * i, 32 * i + 32));
    return entry.mode === '40000' ? { ...entry, id, at: place() } : { ...entry, id };
  });
  fail(cursor.at === bytes.length);
  return { kind: 'node', id: nodeId(tree, ids), tree, entries };
}
export function encodeWide(chunks: readonly { id: string; at: Locator }[], segmentIndex: SegmentIndex) {
  return {
    id: wideId(chunks.map(chunk => chunk.id)),
    bytes: concatBytes(
      Uint8Array.of(2, ...varint(chunks.length)),
      hexToBytes(chunks.map(chunk => chunk.id).join('')),
      Uint8Array.from(
        chunks.flatMap(chunk => [
          ...varint(segmentIndex(chunk.at.segment, chunk.at.size)),
          ...varint(chunk.at.offset),
          ...varint(chunk.at.length),
        ]),
      ),
    ),
  };
}
/** Cut a wide folder after every entry whose name hashes to 0: the cuts depend only on names, so
 * adding or changing one entry moves at most the two chunks around it. */
export function wideChunks(entries: readonly TreeEntry[]): TreeEntry[][] {
  const chunks: TreeEntry[][] = [];
  let current: TreeEntry[] = [];
  for (const entry of entries) {
    current.push(entry);
    let hash = 0x811c9dc5;
    for (const byte of utf8ToBytes(entry.name)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    if (hash % WIDE_CHUNK_MODULUS === 0) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}
