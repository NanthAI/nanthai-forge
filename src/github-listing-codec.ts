// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { importPageBytes } from './github-import-pages.js';
import type { GithubSourceEntry } from './github-project-source.js';

const modes = ['100644', '100755', '120000', '160000'] as const;
const gitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const pageRows = 65_536;
// Normally zero. A damaged create-only key can be superseded by a fresh checksum.
const pageNonceBytes = 16;
// Each row has two u32s (path length and blob size), one mode byte, the binary Git ID, then UTF-8.
const fixedBytes = 9;
const count = z.number().int().nonnegative();
const pageSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: count.positive().max(importPageBytes),
  rows: count.positive().max(pageRows),
  first: z.string().min(1),
});
const indexSchema = z.object({
  schema: z.literal(3),
  tree: z.string().regex(gitId),
  files: count,
  totalBytes: count,
  submodules: count,
  shaBytes: z.union([z.literal(20), z.literal(32)]),
  pages: z.array(pageSchema),
});
export type ListingIndex = z.infer<typeof indexSchema>;
type Page = ListingIndex['pages'][number];
type Totals = Pick<ListingIndex, 'files' | 'totalBytes' | 'submodules'>;

export function decodeListingIndex(bytes: Buffer, tree: string): ListingIndex | null {
  try {
    const index = indexSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (index.tree !== tree || index.submodules > index.files) return null;
    let rows = 0;
    let first = '';
    for (const page of index.pages) {
      if (page.first <= first || page.size < pageNonceBytes + page.rows * (fixedBytes + index.shaBytes + 1))
        return null;
      first = page.first;
      rows += page.rows;
    }
    return rows === index.files ? index : null;
  } catch {
    return null;
  }
}

/** Write rows in State order to deterministic pages, retaining just one page's
 * bytes until its write finishes. Reply boundaries never affect the index. */
export class ListingPageWriter {
  private readonly page = Buffer.allocUnsafe(importPageBytes);
  private readonly pages: Page[] = [];
  private shaBytes: ListingIndex['shaBytes'] = 20;
  private rows = 0;
  private offset = pageNonceBytes;
  private first = '';
  private last = '';

  constructor(
    private readonly write: (page: Buffer, nonce: Buffer) => Promise<Pick<Page, 'sha256' | 'size'>>,
  ) {}

  append = ({ path, sha, size, mode }: GithubSourceEntry): Promise<void> | void => {
    if (!this.last && sha.length === 64) this.shaBytes = 32;
    const code = modes.indexOf(mode);
    const pathBytes = Buffer.byteLength(path);
    const rowBytes = fixedBytes + this.shaBytes + pathBytes;
    invariant(
      path > this.last &&
        !/[\uD800-\uDFFF]/u.test(path) &&
        gitId.test(sha) &&
        sha.length === this.shaBytes * 2 &&
        code >= 0 &&
        Number.isSafeInteger(size) &&
        size >= 0 &&
        size <= 0xffffffff &&
        rowBytes <= this.page.length - pageNonceBytes,
      'GITHUB_RESPONSE',
      'GitHub returned an invalid or unordered listing row.',
    );
    const append = () => {
      if (!this.rows) this.first = path;
      const at = this.offset;
      this.page.writeUInt32LE(pathBytes, at);
      this.page.writeUInt32LE(size, at + 4);
      this.page[at + 8] = code;
      this.page.write(sha, at + fixedBytes, this.shaBytes, 'hex');
      this.page.write(path, at + fixedBytes + this.shaBytes, pathBytes, 'utf8');
      this.offset += rowBytes;
      this.rows++;
      this.last = path;
    };
    if (this.rows >= pageRows || this.offset + rowBytes > this.page.length) return this.flush().then(append);
    append();
  };

  async finish(tree: string, totals: Totals): Promise<ListingIndex> {
    if (this.rows) await this.flush();
    return { schema: 3, tree, ...totals, shaBytes: this.shaBytes, pages: this.pages };
  }

  private async flush() {
    this.page.fill(0, 0, pageNonceBytes);
    const pin = await this.write(this.page.subarray(0, this.offset), this.page.subarray(0, pageNonceBytes));
    this.pages.push({ ...pin, rows: this.rows, first: this.first });
    this.rows = 0;
    this.offset = pageNonceBytes;
  }
}

/** The file table in columns, with one UTF-8 path buffer. Decode a verified
 * page at a time directly into the finished table's preallocated columns. */
export class ListingTable {
  private constructor(
    private paths: Buffer,
    private starts: Uint32Array,
    private shas: Buffer,
    private shaBytes: number,
    private sizes: Uint32Array,
    private modes: Uint8Array,
    readonly totalBytes: number,
    readonly submodules: number,
  ) {}
  get length() {
    return this.sizes.length;
  }

  static async fromPages(index: ListingIndex, read: (pin: Page) => Promise<Buffer | null>) {
    const fixed = fixedBytes + index.shaBytes;
    const pathBytes = index.pages.reduce(
      (sum, page) => sum + page.size - pageNonceBytes - page.rows * fixed,
      0,
    );
    if (pathBytes > 0xffffffff) return null; // Offsets fit the existing column width.
    const paths = Buffer.allocUnsafe(pathBytes);
    const starts = new Uint32Array(index.files + 1);
    const shas = Buffer.allocUnsafe(index.files * index.shaBytes);
    const sizes = new Uint32Array(index.files);
    const codes = new Uint8Array(index.files);
    let row = 0,
      bytes = 0,
      totalBytes = 0,
      submodules = 0;
    let last = '';
    for (const page of index.pages) {
      const raw = await read(page);
      if (!raw || raw.length !== page.size) return null;
      let offset = pageNonceBytes;
      for (let i = 0; i < page.rows; i++, row++) {
        if (offset + fixed > raw.length) return null;
        const length = raw.readUInt32LE(offset);
        const start = offset + fixed;
        if (!length || start + length > raw.length || bytes + length > paths.length) return null;
        const path = raw.toString('utf8', start, start + length);
        if (path <= last || (i === 0 && path !== page.first)) return null;
        last = path;
        const code = raw[offset + 8]!;
        if (code >= modes.length) return null;
        codes[row] = code;
        sizes[row] = raw.readUInt32LE(offset + 4);
        totalBytes += sizes[row]!;
        submodules += Number(modes[code] === '160000');
        raw.copy(shas, row * index.shaBytes, offset + fixedBytes, start);
        raw.copy(paths, bytes, start, start + length);
        starts[row + 1] = bytes += length;
        offset = start + length;
      }
      if (offset !== raw.length) return null;
    }
    if (
      row !== index.files ||
      bytes !== paths.length ||
      totalBytes !== index.totalBytes ||
      submodules !== index.submodules
    )
      return null;
    return new ListingTable(paths, starts, shas, index.shaBytes, sizes, codes, totalBytes, submodules);
  }
  path(index: number) {
    return this.paths.toString('utf8', this.starts[index]!, this.starts[index + 1]!);
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
  entry(index: number): GithubSourceEntry {
    return { path: this.path(index), sha: this.sha(index), size: this.size(index), mode: this.mode(index) };
  }
  index(path: string) {
    let low = 0,
      high = this.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = this.path(middle);
      if (candidate === path) return middle;
      if (candidate < path) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }
}
const pinsHeaderBytes = 92;
const pinRowBytes = 41;
/** Verified pins of a table's rows, by row: the SHA-256 blob and its size (an LFS path binds
 * its object's size). About 41 bytes a file, where a path Map of objects held about 185. */
export class ImportedPins {
  private blobs: Buffer;
  private sizes: Buffer;
  private done: Buffer;
  count = 0;
  constructor(
    readonly length: number,
    private checkpoint: Buffer = Buffer.alloc(pinsHeaderBytes + length * pinRowBytes),
  ) {
    this.blobs = checkpoint.subarray(pinsHeaderBytes, pinsHeaderBytes + length * 32);
    this.sizes = checkpoint.subarray(pinsHeaderBytes + length * 32, pinsHeaderBytes + length * 40);
    this.done = checkpoint.subarray(pinsHeaderBytes + length * 40);
  }
  set(index: number, blob: string, size: number, lfs = false) {
    if (!this.done[index]) this.count++;
    this.done[index] = lfs ? 2 : 1;
    this.blobs.write(blob, index * 32, 'hex');
    this.sizes.writeDoubleLE(size, index * 8);
  }
  has(index: number) {
    return !!this.done[index];
  }
  isLfs(index: number) {
    return this.done[index] === 2;
  }
  retain(keep: (index: number) => boolean) {
    for (let index = 0; index < this.length; index++) {
      if (!this.has(index) || keep(index)) continue;
      this.done[index] = 0;
      this.blobs.fill(0, index * 32, (index + 1) * 32);
      this.sizes.writeDoubleLE(0, index * 8);
      this.count--;
    }
  }
  blob(index: number) {
    return this.blobs.toString('hex', index * 32, index * 32 + 32);
  }
  size(index: number) {
    return this.sizes.readDoubleLE(index * 8);
  }
  /** Header binds the pin columns to this exact tree and listing. The columns
   * share the checkpoint buffer so read/write needs no second full pin table. */
  encode(tree: string, listing: string, attempt: Buffer) {
    const bytes = this.checkpoint;
    bytes.write('NFP1', 0, 'ascii');
    bytes.writeUInt32LE(this.length, 4);
    bytes[8] = tree.length;
    bytes.fill(0, 12, 44).write(tree, 12, 'hex');
    bytes.write(listing, 44, 'hex');
    // Each attempt owns its scratch key, even when it re-verifies the same pins.
    attempt.copy(bytes, 76, 0, 16);
    return bytes;
  }
  static decode(bytes: Buffer, tree: string, listing: string, length: number): ImportedPins | null {
    if (
      bytes.length !== pinsHeaderBytes + length * pinRowBytes ||
      bytes.toString('ascii', 0, 4) !== 'NFP1' ||
      bytes.readUInt32LE(4) !== length ||
      bytes[8] !== tree.length ||
      bytes.toString('hex', 12, 12 + tree.length / 2) !== tree ||
      bytes.toString('hex', 44, 76) !== listing
    )
      return null;
    const pins = new ImportedPins(length, bytes);
    for (let index = 0; index < length; index++) {
      const status = pins.done[index]!;
      if (!status) continue;
      const size = pins.size(index);
      if (status > 2 || !Number.isSafeInteger(size) || size < 0) return null;
      pins.count++;
    }
    return pins;
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
      yield { sha256: this.blob(i), size: this.size(i) };
    }
  }
}
