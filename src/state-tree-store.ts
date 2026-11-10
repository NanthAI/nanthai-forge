// SPDX-License-Identifier: Apache-2.0
import { concatBytes } from '@noble/hashes/utils.js';
import { invariant } from './errors.js';
import { digest } from './portable-hash.js';
import {
  PENDING_SEGMENT,
  WIDE_TREE_ENTRIES,
  decodeRecord,
  encodeNode,
  encodeWide,
  gitId,
  sortEntries,
  wideChunks,
  type Locator,
  type TreeEntry,
  type TreeRef,
} from './state-tree-format.js';
import {
  SEGMENT_TAIL_BYTES,
  encodeSegment,
  parseSegmentTail,
  segmentIndex,
  type SegmentHeader,
  type StateTreeRecord,
} from './state-tree-segment.js';

/** Content-addressed bytes (R2 in production). `getRange` is optional: without it every segment is
 * read whole. */
export interface SegmentStore {
  get(id: string): Promise<Uint8Array>;
  getRange?(id: string, offset: number, length: number): Promise<Uint8Array>;
  put(bytes: Uint8Array): Promise<string>;
}
/** What Convex keeps for a State in tree form: its segment and its root node id. Every byte read
 * through it is checked against one of these two identities. */
export type StateTreePointer = { segment: string; size: number; root: string };
/** Segments up to this size are read whole (one GET, digest checked); larger ones by range. */
export const WHOLE_SEGMENT_BYTES = 256 * 1024;
/** A wide folder whose chunks sit in more segments than this has its most scattered chunks
 * rewritten together, down to half as many segments. */
export const WIDE_SEGMENT_SPREAD = 8;
/** Ranges of one segment closer than this are fetched as one GET. */
const RANGE_GAP_BYTES = 64 * 1024;

const pending = (at: Locator) => at.segment === PENDING_SEGMENT;
const fail: (condition: unknown) => asserts condition = condition =>
  invariant(condition, 'GIT_OBJECT_INVALID', 'A stored source tree is invalid.');

/** One operation's view of the tree store: verified reads with a cache, and the one segment it
 * writes. A folder is checked against the node id its parent (or the State pointer) names, so a
 * ranged read is as safe as a whole one, and a walk trusts no byte it did not check. */
export class TreeSession {
  private readonly whole = new Map<string, Promise<{ bytes: Uint8Array; header: SegmentHeader }>>();
  private readonly headers = new Map<string, Promise<SegmentHeader>>();
  /** Decoded folders by node id; `oid` is empty when the Git id was not computed. */
  private readonly nodes = new Map<string, { entries: readonly TreeEntry[]; oid: string }>();
  /** Where an already stored (or pending) record lives, by node or chunk id. */
  private readonly places = new Map<string, Locator>();
  private readonly records: { id: string; bytes: Uint8Array }[] = [];
  private readonly table = new Map<string, { index: number; size: number }>();
  private offset = 0;
  private sealed = false;
  private readonly wholeBytes: number;
  private readonly strict: boolean;
  /** Every folder read is checked against the node id its parent (or the pointer) names. `strict`
   * also checks each whole segment against its digest and each folder against the Git tree id
   * its parent names: the checks that gate recording a pointer. */
  constructor(
    private readonly store: SegmentStore,
    options: { wholeBytes?: number; strict?: boolean } = {},
  ) {
    this.wholeBytes = options.wholeBytes ?? WHOLE_SEGMENT_BYTES;
    this.strict = options.strict ?? false;
  }

  private segment(segment: string, size: number) {
    let loaded = this.whole.get(segment);
    if (!loaded) {
      loaded = this.store.get(segment).then(bytes => {
        invariant(
          bytes.length === size && (!this.strict || digest(bytes) === segment),
          'SOURCE_HASH_MISMATCH',
          'A stored object differs from its pin.',
        );
        const header = parseSegmentTail(bytes, size);
        fail(!('headerBytes' in header));
        return { bytes, header };
      });
      this.whole.set(segment, loaded);
      loaded.catch(() => this.whole.delete(segment));
    }
    return loaded;
  }
  private ranged(size: number) {
    return !!this.store.getRange && size > this.wholeBytes;
  }
  private header(segment: string, size: number): Promise<SegmentHeader> {
    if (!this.ranged(size)) return this.segment(segment, size).then(loaded => loaded.header);
    let header = this.headers.get(segment);
    if (!header) {
      header = (async () => {
        const read = (bytes: number) => this.store.getRange!(segment, size - bytes, bytes);
        let parsed = parseSegmentTail(await read(Math.min(size, SEGMENT_TAIL_BYTES)), size);
        if ('headerBytes' in parsed) parsed = parseSegmentTail(await read(parsed.headerBytes + 8), size);
        fail(!('headerBytes' in parsed));
        return parsed;
      })();
      this.headers.set(segment, header);
      header.catch(() => this.headers.delete(segment));
    }
    return header;
  }
  /** Record bytes for places in stored segments: one GET per small segment, and one per run of
   * nearby ranges in a large one. */
  private async recordsAt(places: readonly Locator[]): Promise<Uint8Array[]> {
    const out = Array.from<Uint8Array>({ length: places.length }),
      bySegment = new Map<string, number[]>();
    places.forEach((at, i) => bySegment.set(at.segment, [...(bySegment.get(at.segment) ?? []), i]));
    await Promise.all(
      [...bySegment].map(async ([segment, indexes]) => {
        const size = places[indexes[0]!]!.size;
        if (!this.ranged(size)) {
          const { bytes } = await this.segment(segment, size);
          for (const i of indexes)
            out[i] = bytes.subarray(places[i]!.offset, places[i]!.offset + places[i]!.length);
          return;
        }
        indexes.sort((a, b) => places[a]!.offset - places[b]!.offset);
        const runs: number[][] = [];
        let end = -Infinity;
        for (const i of indexes) {
          if (places[i]!.offset - end > RANGE_GAP_BYTES) runs.push([]);
          runs.at(-1)!.push(i);
          end = Math.max(end, places[i]!.offset + places[i]!.length);
        }
        await Promise.all(
          runs.map(async run => {
            const start = places[run[0]!]!.offset,
              length = Math.max(...run.map(i => places[i]!.offset + places[i]!.length)) - start,
              bytes = await this.store.getRange!(segment, start, length);
            fail(bytes.length === length);
            for (const i of run)
              out[i] = bytes.subarray(
                places[i]!.offset - start,
                places[i]!.offset - start + places[i]!.length,
              );
          }),
        );
      }),
    );
    return out;
  }
  private async decode(at: Locator, bytes: Uint8Array) {
    const header = await this.header(at.segment, at.size);
    return decodeRecord(bytes, index => {
      if (index === 0) return { segment: at.segment, size: at.size };
      const other = header.segments[index - 1];
      fail(other);
      return { segment: other[0], size: other[1] };
    });
  }

  /** A folder's entries in Git order. The stored bytes must hash to `ref.id`, and to `ref.oid` as
   * a Git tree when the caller names one. */
  async load(ref: { id: string; oid?: string; at: Locator }): Promise<readonly TreeEntry[]> {
    const known = this.nodes.get(ref.id);
    if (known) {
      fail(!this.strict || !ref.oid || !known.oid || ref.oid === known.oid);
      return known.entries;
    }
    fail(!pending(ref.at));
    const record = await this.decode(ref.at, (await this.recordsAt([ref.at]))[0]!);
    invariant(record.id === ref.id, 'SOURCE_HASH_MISMATCH', 'A stored source tree differs from its pin.');
    let entries: TreeEntry[], tree: Uint8Array;
    if (record.kind === 'node') ({ entries, tree } = record);
    else {
      const bytes = await this.recordsAt(record.chunks.map(chunk => chunk.at)),
        chunks = await Promise.all(record.chunks.map((chunk, i) => this.decode(chunk.at, bytes[i]!)));
      entries = [];
      const trees: Uint8Array[] = [];
      chunks.forEach((chunk, i) => {
        invariant(
          chunk.kind === 'node' && chunk.id === record.chunks[i]!.id,
          'SOURCE_HASH_MISMATCH',
          'A stored source tree differs from its pin.',
        );
        this.places.set(chunk.id, record.chunks[i]!.at);
        entries.push(...chunk.entries);
        trees.push(chunk.tree);
      });
      tree = concatBytes(...trees);
    }
    const oid = this.strict ? gitId('tree', tree) : '';
    fail(!oid || !ref.oid || ref.oid === oid);
    this.places.set(ref.id, ref.at);
    this.nodes.set(ref.id, { entries, oid });
    return entries;
  }

  private tableIndex = (segment: string, size: number) => {
    if (segment === PENDING_SEGMENT) return 0;
    let entry = this.table.get(segment);
    if (!entry) this.table.set(segment, (entry = { index: this.table.size + 1, size }));
    fail(entry.size === size);
    return entry.index;
  };
  private add(id: string, bytes: Uint8Array): Locator {
    fail(!this.sealed);
    const at = { segment: PENDING_SEGMENT, size: 0, offset: this.offset, length: bytes.length };
    this.records.push({ id, bytes });
    this.offset += bytes.length;
    this.places.set(id, at);
    return at;
  }
  /** Store a folder (entries in any order) in this operation's segment, unless a folder with the
   * same identity is already stored somewhere this session has seen. */
  write(unsorted: Iterable<TreeEntry>): TreeRef {
    const entries = sortEntries(unsorted);
    for (let i = 1; i < entries.length; i++)
      invariant(
        entries[i - 1]!.name !== entries[i]!.name,
        'INVALID_NATIVE_SOURCE',
        'Source file and directory paths overlap.',
      );
    let id: string, tree: Uint8Array, bytes: Uint8Array;
    if (entries.length <= WIDE_TREE_ENTRIES) ({ id, tree, bytes } = encodeNode(entries, this.tableIndex));
    else {
      const chunks = wideChunks(entries).map(chunk => encodeNode(chunk, this.tableIndex)),
        held = new Map<string, number>();
      for (const chunk of chunks) {
        const at = this.places.get(chunk.id);
        if (at && !pending(at)) held.set(at.segment, (held.get(at.segment) ?? 0) + 1);
      }
      // Too scattered: move the chunks of the segments holding the fewest into this one, so a
      // reader needs few GETs and the large segments (an import) are never rewritten.
      const moved = new Set(
        held.size > WIDE_SEGMENT_SPREAD
          ? [...held]
              .sort((a, b) => a[1] - b[1])
              .slice(0, held.size - WIDE_SEGMENT_SPREAD / 2)
              .map(([segment]) => segment)
          : [],
      );
      const refs = chunks.map(chunk => {
        const at = this.places.get(chunk.id);
        return { id: chunk.id, at: at && !moved.has(at.segment) ? at : this.add(chunk.id, chunk.bytes) };
      });
      ({ id, bytes } = encodeWide(refs, this.tableIndex));
      tree = concatBytes(...chunks.map(chunk => chunk.tree));
    }
    const oid = gitId('tree', tree),
      at = this.places.get(id) ?? this.add(id, bytes);
    this.nodes.set(id, { entries, oid });
    return { id, oid, at };
  }

  /** Read a State's header through its pointer. */
  async open(pointer: StateTreePointer): Promise<{ record: StateTreeRecord; root: TreeRef }> {
    const header = await this.header(pointer.segment, pointer.size),
      [id, oid, index, offset, length] = header.root,
      other = index ? header.segments[index - 1]! : [pointer.segment, pointer.size];
    invariant(id === pointer.root, 'SOURCE_HASH_MISMATCH', 'A stored source tree differs from its pin.');
    return {
      record: header.record,
      root: { id, oid, at: { segment: other[0] as string, size: other[1] as number, offset, length } },
    };
  }
  /** Write this operation's segment, read the stored bytes back and check every record in them.
   * Only the returned pointer may be recorded for the State. */
  async finish(record: StateTreeRecord, root: TreeRef) {
    fail(!this.sealed);
    this.sealed = true;
    const rootIndex = this.tableIndex(root.at.segment, root.at.size),
      bytes = encodeSegment(this.records, {
        record,
        root: [root.id, root.oid, rootIndex, root.at.offset, root.at.length],
        segments: [...this.table].map(([segment, entry]) => [segment, entry.size]),
      }),
      segment = await this.store.put(bytes),
      stored = await this.store.get(segment);
    await verifySegment(stored, segment, bytes.length);
    const here = (at: Locator) => (pending(at) ? { ...at, segment, size: bytes.length } : at);
    return {
      pointer: { segment, size: bytes.length, root: root.id } satisfies StateTreePointer,
      root: { ...root, at: here(root.at) },
      bytes: bytes.length,
      records: this.records.length,
    };
  }
}

/** Check a whole segment: its digest, its header, and that every indexed record decodes and
 * hashes to its indexed identity, with no byte outside a record. */
export async function verifySegment(bytes: Uint8Array, segment: string, size = bytes.length) {
  invariant(
    bytes.length === size && digest(bytes) === segment,
    'SOURCE_HASH_MISMATCH',
    'A stored object differs from its pin.',
  );
  const header = parseSegmentTail(bytes, size);
  fail(!('headerBytes' in header));
  const index = segmentIndex(bytes, header);
  for (const [id, [offset, length]] of index) {
    const record = decodeRecord(bytes.subarray(offset, offset + length), at => {
      if (at === 0) return { segment, size };
      const other = header.segments[at - 1];
      fail(other);
      return { segment: other[0], size: other[1] };
    });
    invariant(record.id === id, 'SOURCE_HASH_MISMATCH', 'A stored source tree differs from its pin.');
  }
  let end = 0;
  for (const [offset, length] of [...index.values()].sort((a, b) => a[0] - b[0])) {
    fail(offset === end);
    end += length;
  }
  fail(end === header.index[0]);
  return header;
}
