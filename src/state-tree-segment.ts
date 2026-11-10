// SPDX-License-Identifier: Apache-2.0
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { compareBytes, fail } from './state-tree-format.js';

/** A tree segment: the one object a save writes. Records first (so a place is an absolute byte
 * range), then a sorted record index, then a JSON header, then the header length and a magic. */
const text = new TextDecoder('utf-8', { fatal: true });
/** The State record of a segment: everything of the manifest except its file list. */
export type StateTreeRecord = {
  /** Forge State identity: SHA-256 of the exact manifest bytes. */
  state: string;
  /** Every manifest field except `files`, in its original key order. */
  fields: Record<string, unknown>;
  /** Position of `files` among the original keys. */
  filesAt: number;
};
export type SegmentHeader = {
  schema: 1;
  kind: 'forge-tree-segment';
  record: StateTreeRecord;
  /** The State's root folder: node id, Git tree id, then segment index, offset and length. */
  root: [string, string, number, number, number];
  /** Other segments this one's places name; place index i + 1 is entry i. */
  segments: [string, number][];
  /** Offset of the record index and its entry count (40 bytes each: node id, offset, length). */
  index: [number, number];
};
const magic = utf8ToBytes('FTS1');
const hex64 = /^[0-9a-f]{64}$/,
  hex40 = /^[0-9a-f]{40}$/;
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function encodeSegment(
  records: readonly { id: string; bytes: Uint8Array }[],
  header: Omit<SegmentHeader, 'schema' | 'kind' | 'index'>,
): Uint8Array {
  const index = new Uint8Array(40 * records.length),
    view = new DataView(index.buffer);
  let offset = 0;
  const placed = records.map(record => {
    const at = offset;
    offset += record.bytes.length;
    return { id: record.id, at, length: record.bytes.length };
  });
  placed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  placed.forEach((record, i) => {
    index.set(hexToBytes(record.id), 40 * i);
    view.setUint32(40 * i + 32, record.at);
    view.setUint32(40 * i + 36, record.length);
  });
  const json = utf8ToBytes(
      JSON.stringify({
        schema: 1,
        kind: 'forge-tree-segment',
        ...header,
        index: [offset, records.length],
      } satisfies SegmentHeader),
    ),
    tail = new Uint8Array(8);
  new DataView(tail.buffer).setUint32(0, json.length);
  tail.set(magic, 4);
  return concatBytes(...records.map(record => record.bytes), index, json, tail);
}
/** Bytes from the end of a segment that hold its header in one ranged read (a longer header takes
 * a second read). */
export const SEGMENT_TAIL_BYTES = 4096;
/** Parse a header from the last bytes of a segment of `size` bytes. Returns the header length when
 * `tail` is too short to hold it. */
export function parseSegmentTail(tail: Uint8Array, size: number): SegmentHeader | { headerBytes: number } {
  fail(tail.length >= 8 && tail.length <= size);
  const end = tail.length - 8,
    headerBytes = new DataView(tail.buffer, tail.byteOffset + end, 4).getUint32(0);
  fail(compareBytes(tail.subarray(end + 4), magic) === 0 && headerBytes + 8 <= size);
  if (headerBytes > end) return { headerBytes };
  let value: unknown;
  try {
    value = JSON.parse(text.decode(tail.subarray(end - headerBytes, end)));
  } catch {
    fail(false);
  }
  const header = value as SegmentHeader,
    record = header?.record,
    records = size - 8 - headerBytes;
  fail(
    header?.schema === 1 &&
      header.kind === 'forge-tree-segment' &&
      record &&
      hex64.test(record.state) &&
      typeof record.fields === 'object' &&
      record.fields !== null &&
      !Array.isArray(record.fields) &&
      !('files' in record.fields) &&
      natural(record.filesAt) &&
      record.filesAt <= Object.keys(record.fields).length,
  );
  fail(
    Array.isArray(header.segments) &&
      header.segments.every(
        item => Array.isArray(item) && item.length === 2 && hex64.test(item[0]) && natural(item[1]),
      ) &&
      Array.isArray(header.index) &&
      header.index.length === 2 &&
      header.index.every(natural) &&
      header.index[0] + 40 * header.index[1] === records,
  );
  const root = header.root;
  fail(
    Array.isArray(root) &&
      root.length === 5 &&
      hex64.test(root[0]) &&
      hex40.test(root[1]) &&
      root.slice(2).every(natural) &&
      root[2] <= header.segments.length,
  );
  return header;
}
/** The record index of a whole segment: node id to offset and length. */
export function segmentIndex(bytes: Uint8Array, header: SegmentHeader): Map<string, [number, number]> {
  const [at, count] = header.index,
    view = new DataView(bytes.buffer, bytes.byteOffset + at, 40 * count),
    index = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(40 * i + 32),
      length = view.getUint32(40 * i + 36);
    fail(length > 0 && offset + length <= at);
    index.set(bytesToHex(bytes.subarray(at + 40 * i, at + 40 * i + 32)), [offset, length]);
  }
  fail(index.size === count);
  return index;
}
