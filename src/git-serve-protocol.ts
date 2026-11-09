// SPDX-License-Identifier: Apache-2.0
import { sha1 } from '@noble/hashes/legacy.js';
import { ForgeError, invariant } from './errors.js';

/** Server side of Git smart HTTP for read-only clone and fetch (protocol v2, v0
 * fallback). Pure and portable: it runs in Convex's V8 runtime, so no Buffer. The
 * packs it serves are stored Git packs, never built here. */
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const oid = /^[0-9a-f]{40}$/;
export const flushPkt = encoder.encode('0000');
export const delimPkt = encoder.encode('0001');
/** Largest side-band payload: 65520-byte pkt-line minus length and band byte. */
export const sidebandData = 65515;

export function concatBytes(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
export function pkt(value: string | Uint8Array) {
  const body = typeof value === 'string' ? encoder.encode(value) : value;
  invariant(body.length + 4 <= 65520, 'BAD_ARGUMENT', 'A Git protocol line is too long.');
  const out = new Uint8Array(body.length + 4);
  out.set(encoder.encode((body.length + 4).toString(16).padStart(4, '0')));
  out.set(body, 4);
  return out;
}
/** Splits bytes into one band's pkt-lines (1 pack data, 2 progress, 3 error). */
export function sideband(band: 1 | 2 | 3, bytes: Uint8Array, max = sidebandData) {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += max) {
    const slice = bytes.subarray(at, at + max);
    const body = new Uint8Array(slice.length + 1);
    body[0] = band;
    body.set(slice, 1);
    parts.push(pkt(body));
  }
  return concatBytes(parts);
}
export const errorPkt = (code: string, message: string) => pkt(`ERR ${code}: ${message}\n`);

/** Parsed request lines; `flush` and `delim` mark section ends. */
export type PktLine = string | { kind: 'flush' | 'delim' };
export function parsePktLines(bytes: Uint8Array): PktLine[] {
  const lines: PktLine[] = [];
  for (let at = 0; at < bytes.length;) {
    invariant(at + 4 <= bytes.length, 'GIT_PROTOCOL', 'The Git request ended inside a protocol line.');
    const head = decoder.decode(bytes.subarray(at, at + 4));
    invariant(/^[0-9a-f]{4}$/.test(head), 'GIT_PROTOCOL', 'The Git request has an invalid protocol line.');
    const length = parseInt(head, 16);
    if (length === 0 || length === 1) {
      lines.push({ kind: length === 0 ? 'flush' : 'delim' });
      at += 4;
      continue;
    }
    invariant(
      length > 4 && at + length <= bytes.length,
      'GIT_PROTOCOL',
      'The Git request has an invalid protocol line.',
    );
    lines.push(decoder.decode(bytes.subarray(at + 4, at + length)).replace(/\n$/, ''));
    at += length;
  }
  return lines;
}

/** What the server lists: HEAD points at refs/heads/main. */
export type GitRefs = { main: string };
export const agent = 'agent=forge/1';

/** v2 capability advertisement (GET info/refs with Git-Protocol: version=2). Only
 * what is served is advertised: no shallow, filter, packfile-uris or push. */
export function advertiseV2() {
  return concatBytes([
    pkt('version 2\n'),
    pkt(`${agent}\n`),
    pkt('ls-refs\n'),
    pkt('fetch\n'),
    pkt('object-format=sha1\n'),
    flushPkt,
  ]);
}
const v0Capabilities = `side-band-64k side-band ofs-delta no-progress symref=HEAD:refs/heads/main object-format=sha1 ${agent}`;
/** v0 ref advertisement, with the smart-HTTP service preamble. */
export function advertiseV0(refs: GitRefs) {
  return concatBytes([
    pkt('# service=git-upload-pack\n'),
    flushPkt,
    pkt(`${refs.main} HEAD\0${v0Capabilities}\n`),
    pkt(`${refs.main} refs/heads/main\n`),
    flushPkt,
  ]);
}

export type V2Request = { command: string; capabilities: string[]; args: string[] };
export function parseV2Request(bytes: Uint8Array): V2Request {
  const lines = parsePktLines(bytes);
  const capabilities: string[] = [],
    args: string[] = [];
  let section: 'caps' | 'args' | 'end' = 'caps';
  for (const line of lines) {
    if (typeof line !== 'string') {
      if (line.kind === 'delim' && section === 'caps') section = 'args';
      else section = 'end';
      continue;
    }
    if (section === 'caps') capabilities.push(line);
    else if (section === 'args') args.push(line);
  }
  const command = capabilities.find(line => line.startsWith('command='))?.slice(8);
  invariant(command, 'GIT_PROTOCOL', 'The Git request names no command.');
  return { command, capabilities, args };
}

/** v2 ls-refs reply: HEAD (symref to main) and refs/heads/main, filtered by ref-prefix. */
export function lsRefs(refs: GitRefs, args: string[]) {
  const prefixes = args.filter(arg => arg.startsWith('ref-prefix ')).map(arg => arg.slice(11));
  const symrefs = args.includes('symrefs');
  const listed = [
    { name: 'HEAD', line: `${refs.main} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n` },
    { name: 'refs/heads/main', line: `${refs.main} refs/heads/main\n` },
  ].filter(ref => !prefixes.length || prefixes.some(prefix => ref.name.startsWith(prefix)));
  return concatBytes([...listed.map(ref => pkt(ref.line)), flushPkt]);
}

export type FetchArgs = {
  wants: string[];
  haves: string[];
  done: boolean;
  noProgress: boolean;
  sideband: boolean;
};
const unsupported = [
  'deepen',
  'deepen-since',
  'deepen-not',
  'shallow',
  'filter',
  'want-ref',
  'packfile-uris',
];
/** v2 fetch arguments; refuses what was not advertised (shallow, filter, want-ref). */
export function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], done: false, noProgress: false, sideband: true };
  let ofsDelta = false;
  for (const arg of args) {
    const [word, value] = [arg.split(' ', 1)[0]!, arg.slice(arg.indexOf(' ') + 1)];
    if (word === 'want' || word === 'have') {
      invariant(oid.test(value), 'GIT_PROTOCOL', `The Git request has an invalid ${word} line.`);
      (word === 'want' ? out.wants : out.haves).push(value);
    } else if (arg === 'done') out.done = true;
    else if (arg === 'no-progress') out.noProgress = true;
    else if (arg === 'ofs-delta') ofsDelta = true;
    else if (unsupported.includes(word))
      throw new ForgeError(
        'GIT_UNSUPPORTED',
        `Forge serves full clones only; "${word}" (shallow or partial clone) is not supported.`,
      );
  }
  invariant(out.wants.length, 'GIT_PROTOCOL', 'The Git fetch names no commit.');
  invariant(ofsDelta, 'GIT_UNSUPPORTED', 'Forge serves packs with offset deltas; use Git 1.6 or later.');
  return out;
}
/** v0 upload-pack request: want lines (first carries capabilities), haves, done. */
export function parseV0Request(bytes: Uint8Array): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], done: false, noProgress: false, sideband: false };
  let caps: string[] = [];
  let ofsDelta = false;
  for (const line of parsePktLines(bytes)) {
    if (typeof line !== 'string') continue;
    const [word, value = '', ...rest] = line.split(' ');
    if (word === 'want') {
      invariant(oid.test(value), 'GIT_PROTOCOL', 'The Git request has an invalid want line.');
      if (!out.wants.length) caps = rest;
      out.wants.push(value);
    } else if (word === 'have') {
      invariant(oid.test(value), 'GIT_PROTOCOL', 'The Git request has an invalid have line.');
      out.haves.push(value);
    } else if (word === 'done') out.done = true;
    else if (['shallow', 'deepen', 'deepen-since', 'deepen-not', 'filter'].includes(word!))
      throw new ForgeError(
        'GIT_UNSUPPORTED',
        `Forge serves full clones only; "${word}" (shallow or partial clone) is not supported.`,
      );
  }
  for (const cap of caps) {
    if (cap === 'side-band-64k' || cap === 'side-band') out.sideband = true;
    else if (cap === 'no-progress') out.noProgress = true;
    else if (cap === 'ofs-delta') ofsDelta = true;
  }
  invariant(out.wants.length, 'GIT_PROTOCOL', 'The Git fetch names no commit.');
  invariant(ofsDelta, 'GIT_UNSUPPORTED', 'Forge serves packs with offset deltas; use Git 1.6 or later.');
  return out;
}

/** Stored packs in fetch order: pack i holds what tip i reaches beyond tips 0..i-1. */
export type StoredPack = { tip: string; bytes: number; objects: number };
export type PackSelection = { from: number; to: number; common: string | null };
/** The packs a client needs: up to the newest wanted tip, after the newest tip it
 * has. Wants must be stored tips (advertised refs move only to stored tips). */
export function selectPacks(packs: StoredPack[], wants: string[], haves: string[]): PackSelection {
  const index = new Map(packs.map((pack, i) => [pack.tip, i]));
  let to = -1;
  for (const want of wants) {
    const at = index.get(want);
    if (at === undefined)
      throw new ForgeError(
        'GIT_NOT_OUR_REF',
        `Commit ${want.slice(0, 12)} is not a current Forge ref; fetch again to read the latest refs.`,
      );
    to = Math.max(to, at);
  }
  let from = 0,
    common: string | null = null;
  for (const have of haves) {
    const at = index.get(have);
    if (at !== undefined && at + 1 > from) {
      from = at + 1;
      common = have;
    }
  }
  return { from, to, common };
}

/** Joins whole stored packs into one pack stream: one new header, every body, a new
 * SHA-1 trailer. One pack passes through byte-exact (its own trailer). Stored packs
 * are not thin, so offset deltas stay inside their own body. */
export class PackJoiner {
  private hash = sha1.create();
  private single: boolean;
  private position = 0;
  private current = 0;
  constructor(private packs: StoredPack[]) {
    this.single = packs.length === 1;
  }
  get bytes() {
    if (this.single) return this.packs[0]!.bytes;
    return 12 + this.packs.reduce((sum, pack) => sum + pack.bytes - 32, 0) + 20;
  }
  header(): Uint8Array {
    if (this.single) return new Uint8Array(0);
    const objects = this.packs.reduce((sum, pack) => sum + pack.objects, 0);
    const out = new Uint8Array(12);
    out.set(encoder.encode('PACK'));
    const view = new DataView(out.buffer);
    view.setUint32(4, 2);
    view.setUint32(8, objects);
    this.hash.update(out);
    return out;
  }
  /** Bytes of the current pack, in order; returns what to send. */
  push(part: Uint8Array): Uint8Array {
    const pack = this.packs[this.current];
    invariant(pack, 'GIT_PACK_INVALID', 'A stored pack is longer than its record.');
    const start = this.position,
      end = start + part.length;
    invariant(end <= pack.bytes, 'GIT_PACK_INVALID', 'A stored pack is longer than its record.');
    this.position = end;
    if (this.single) return part;
    if (start === 0)
      invariant(
        part.length < 4 || decoder.decode(part.subarray(0, 4)) === 'PACK',
        'GIT_PACK_INVALID',
        'A stored history object is not a Git pack.',
      );
    const keep = part.subarray(
      Math.max(0, 12 - start),
      Math.max(0, Math.min(part.length, pack.bytes - 20 - start)),
    );
    this.hash.update(keep);
    return keep;
  }
  /** Ends the current pack; after the last, returns the trailer. */
  next(): Uint8Array {
    const pack = this.packs[this.current];
    invariant(
      pack && this.position === pack.bytes,
      'GIT_PACK_INVALID',
      'A stored pack is shorter than its record.',
    );
    this.current++;
    this.position = 0;
    if (this.current < this.packs.length || this.single) return new Uint8Array(0);
    return this.hash.digest();
  }
}
/** An empty pack, for a fetch whose wants the client already has. */
export function emptyPack() {
  const head = new Uint8Array(12);
  head.set(encoder.encode('PACK'));
  new DataView(head.buffer).setUint32(4, 2);
  return concatBytes([head, sha1(head)]);
}
