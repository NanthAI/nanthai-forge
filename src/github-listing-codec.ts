// SPDX-License-Identifier: Apache-2.0
import type { GithubListing } from './github-archive-source.js';
import type { GithubSourceEntry } from './github-project-source.js';

const modes = ['100644', '100755', '120000', '160000'] as const;
const modeCode = new Map<string, number>(modes.map((mode, code) => [mode, code]));
const gitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The file table of one commit tree in columns: one paths string with offsets, binary Git
 * ids, sizes and mode codes. About 150 bytes a file at real path lengths, where one object
 * per file plus a path Map held about 300 (150,612 files: 494 of 512 MB). Paths are in
 * portable State order (JS code units), so a lookup is a binary search. */
export class ListingTable {
  readonly length: number;
  /** @internal Use ListingTable.from, ListingTable.decode or ListingBuilder. */
  constructor(
    private paths: string,
    private starts: Uint32Array,
    private shas: Buffer,
    private shaBytes: number,
    private sizes: Uint32Array,
    private modes: Uint8Array,
    readonly totalBytes: number,
    readonly submodules: number,
  ) {
    this.length = sizes.length;
  }
  /** Null when the rows are not one sorted table of distinct paths and valid Git ids. */
  static from(listing: GithubListing): ListingTable | null {
    const files = listing.files,
      shaBytes = files.length ? files[0]!.sha.length / 2 : 20;
    const shas = Buffer.alloc(files.length * shaBytes),
      starts = new Uint32Array(files.length + 1),
      sizes = new Uint32Array(files.length),
      codes = new Uint8Array(files.length);
    let at = 0;
    for (let i = 0; i < files.length; i++) {
      const { path, sha, size, mode } = files[i]!;
      const code = modeCode.get(mode);
      if (
        typeof path !== 'string' ||
        !path ||
        (i && byPath(files[i - 1]!.path, path) >= 0) ||
        typeof sha !== 'string' ||
        !gitId.test(sha) ||
        sha.length !== shaBytes * 2 ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 0xffffffff ||
        code === undefined
      )
        return null;
      shas.write(sha, i * shaBytes, 'hex');
      sizes[i] = size;
      codes[i] = code;
      at += path.length;
      starts[i + 1] = at;
    }
    return new ListingTable(
      files.map(file => file.path).join(''),
      starts,
      shas,
      shaBytes,
      sizes,
      codes,
      listing.totalBytes,
      listing.submodules,
    );
  }
  path(index: number) {
    return this.paths.slice(this.starts[index]!, this.starts[index + 1]!);
  }
  sha(index: number) {
    return this.shas.toString('hex', index * this.shaBytes, (index + 1) * this.shaBytes);
  }
  size(index: number) {
    return this.sizes[index]!;
  }
  mode(index: number): GithubSourceEntry['mode'] {
    return modes[this.modes[index]!]!;
  }
  /** One row as an entry object, made on demand and not retained by the table. */
  entry(index: number): GithubSourceEntry {
    return { path: this.path(index), sha: this.sha(index), size: this.size(index), mode: this.mode(index) };
  }
  /** Row of `path`, or -1. */
  index(path: string) {
    let low = 0,
      high = this.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1,
        order = byPath(this.path(middle), path);
      if (order === 0) return middle;
      if (order < 0) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }
  /** Layout: u32 header length, JSON header, starts, sizes, modes, Git ids, UTF-8 paths. */
  encode(tree: string) {
    const header = Buffer.from(
      JSON.stringify({
        schema: 2,
        tree,
        totalBytes: this.totalBytes,
        submodules: this.submodules,
        files: this.length,
        shaBytes: this.shaBytes,
      }),
    );
    // One buffer, paths encoded in place: no second copy of the table while it is written.
    const parts = [
      header,
      Buffer.from(this.starts.buffer, this.starts.byteOffset, this.starts.byteLength),
      Buffer.from(this.sizes.buffer, this.sizes.byteOffset, this.sizes.byteLength),
      Buffer.from(this.modes.buffer, this.modes.byteOffset, this.modes.byteLength),
      this.shas,
    ];
    const pathBytes = Buffer.byteLength(this.paths, 'utf8');
    const bytes = Buffer.allocUnsafe(4 + parts.reduce((sum, part) => sum + part.length, 0) + pathBytes);
    bytes.writeUInt32LE(header.length);
    let at = 4;
    for (const part of parts) at += part.copy(bytes, at);
    bytes.write(this.paths, at, 'utf8');
    return bytes;
  }
  /** Null when the bytes are not a well-formed table for `tree`: the caller lists again. */
  static decode(bytes: Buffer, tree: string): ListingTable | null {
    try {
      const headerBytes = bytes.readUInt32LE(0);
      const header: Record<string, unknown> = JSON.parse(bytes.toString('utf8', 4, 4 + headerBytes));
      const files = header.files,
        shaBytes = header.shaBytes;
      if (
        header.schema !== 2 ||
        header.tree !== tree ||
        !Number.isSafeInteger(files) ||
        (shaBytes !== 20 && shaBytes !== 32) ||
        !Number.isSafeInteger(header.totalBytes) ||
        !Number.isSafeInteger(header.submodules)
      )
        return null;
      const n = files as number;
      let at = 4 + headerBytes;
      const take = (size: number) => {
        const part = bytes.subarray(at, at + size);
        at += size;
        // An exact copy: typed views need their own aligned buffer.
        return new Uint8Array(part);
      };
      const starts = new Uint32Array(take((n + 1) * 4).buffer),
        sizes = new Uint32Array(take(n * 4).buffer),
        codes = take(n),
        shas = Buffer.from(take(n * (shaBytes as number)).buffer);
      if (at > bytes.length) return null;
      const paths = bytes.toString('utf8', at);
      if (starts[0] !== 0 || starts[n] !== paths.length || codes.some(code => code >= modes.length))
        return null;
      const table = new ListingTable(
        paths,
        starts,
        shas,
        shaBytes as number,
        sizes,
        codes,
        header.totalBytes as number,
        header.submodules as number,
      );
      for (let i = 0; i < n; i++)
        if (starts[i + 1]! <= starts[i]! || (i && byPath(table.path(i - 1), table.path(i)) >= 0)) return null;
      return table;
    } catch {
      return null;
    }
  }
}

/** Collects a listing's rows in any order into columns, then sorts them into a ListingTable,
 * so building a table never holds one object per file. */
export class ListingBuilder {
  private paths: string[] = [];
  private shas = Buffer.alloc(0);
  private shaBytes = 0;
  private sizes = new Uint32Array(0);
  private codes = new Uint8Array(0);
  /** False when the row cannot be a table row (Git id, size or mode). */
  push(path: string, sha: string, size: number, mode: string) {
    const code = modeCode.get(mode),
      n = this.paths.length;
    if (!this.shaBytes && gitId.test(sha)) this.shaBytes = sha.length / 2;
    if (
      !path ||
      !gitId.test(sha) ||
      sha.length !== this.shaBytes * 2 ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 0xffffffff ||
      code === undefined
    )
      return false;
    if (n === this.sizes.length) this.grow(Math.max(1024, n * 2));
    this.paths.push(path);
    this.shas.write(sha, n * this.shaBytes, 'hex');
    this.sizes[n] = size;
    this.codes[n] = code;
    return true;
  }
  get length() {
    return this.paths.length;
  }
  path(index: number) {
    return this.paths[index]!;
  }
  /** The rows in portable State order; null when two rows share a path. Empties the builder. */
  finish(totalBytes: number, submodules: number): ListingTable | null {
    const paths = this.paths,
      n = paths.length,
      shaBytes = this.shaBytes || 20;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => byPath(paths[a]!, paths[b]!));
    const shas = Buffer.alloc(n * shaBytes),
      starts = new Uint32Array(n + 1),
      sizes = new Uint32Array(n),
      codes = new Uint8Array(n),
      sorted: string[] = new Array(n);
    let at = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k]!;
      if (k && paths[order[k - 1]!] === paths[i]) return null;
      this.shas.copy(shas, k * shaBytes, i * shaBytes, (i + 1) * shaBytes);
      sizes[k] = this.sizes[i]!;
      codes[k] = this.codes[i]!;
      sorted[k] = paths[i]!;
      at += paths[i]!.length;
      starts[k + 1] = at;
    }
    this.paths = [];
    this.grow(0);
    const joined = sorted.join('');
    return new ListingTable(joined, starts, shas, shaBytes, sizes, codes, totalBytes, submodules);
  }
  private grow(capacity: number) {
    const shas = Buffer.alloc(capacity * (this.shaBytes || 20));
    this.shas.copy(shas, 0, 0, Math.min(this.shas.length, shas.length));
    this.shas = shas;
    const sizes = new Uint32Array(capacity),
      codes = new Uint8Array(capacity);
    sizes.set(this.sizes.subarray(0, capacity));
    codes.set(this.codes.subarray(0, capacity));
    this.sizes = sizes;
    this.codes = codes;
  }
}

/** Verified pins of a table's rows, by row: the SHA-256 blob and its size (an LFS path binds
 * its object's size). About 41 bytes a file, where a path Map of objects held about 185. */
export class ImportedPins {
  private blobs: Buffer;
  private sizes: Float64Array;
  private done: Uint8Array;
  count = 0;
  constructor(readonly length: number) {
    this.blobs = Buffer.alloc(length * 32);
    this.sizes = new Float64Array(length);
    this.done = new Uint8Array(length);
  }
  set(index: number, blob: string, size: number) {
    if (!this.done[index]) this.count++;
    this.done[index] = 1;
    this.blobs.write(blob, index * 32, 'hex');
    this.sizes[index] = size;
  }
  has(index: number) {
    return this.done[index] === 1;
  }
  blob(index: number) {
    return this.blobs.toString('hex', index * 32, index * 32 + 32);
  }
  size(index: number) {
    return this.sizes[index]!;
  }
  /** Distinct blobs in ascending digest order, each with its size. */
  *distinct(): Generator<{ sha256: string; size: number }> {
    const blobs = this.blobs;
    const order = new Uint32Array(this.length);
    let n = 0;
    for (let i = 0; i < this.length; i++) if (this.done[i]) order[n++] = i;
    const sorted = order
      .subarray(0, n)
      .sort((a, b) => blobs.compare(blobs, b * 32, b * 32 + 32, a * 32, a * 32 + 32));
    for (let k = 0; k < n; k++) {
      const i = sorted[k]!;
      if (k && blobs.compare(blobs, sorted[k - 1]! * 32, sorted[k - 1]! * 32 + 32, i * 32, i * 32 + 32) === 0)
        continue;
      yield { sha256: this.blob(i), size: this.sizes[i]! };
    }
  }
}
