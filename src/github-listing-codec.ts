// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import { importPageBytes } from './github-import-pages.js';
import type { GithubSourceEntry } from './github-project-source.js';

const modes = ['100644', '100755', '120000', '160000'] as const;
const gitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const pageRows = 65_536;
const lookupRows = 32;
const lookupBytes = 8 * 1024;
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

export type ListedGithubEntry = GithubSourceEntry & { row: number };
type ListingSpan = { offset: number; size: number; sha256: string };
type ListingRange = { pin: Page; first: string; start: number; rows: number; span?: ListingSpan };

/** One page owns its bytes and a row-offset column. File positions are global so
 * an archive member, a fallback fetch and publication use the same pin. */
class ListingPage {
  private constructor(
    private raw: Buffer,
    private starts: Uint32Array,
    private shaBytes: number,
    readonly start: number,
    readonly totalBytes: number,
    readonly submodules: number,
  ) {}
  get length() {
    return this.starts.length - 1;
  }

  static decode(raw: Buffer, range: ListingRange, shaBytes: number) {
    if (raw.length !== (range.span?.size ?? range.pin.size)) return null;
    const fixed = fixedBytes + shaBytes;
    const starts = new Uint32Array(range.rows + 1);
    let offset = range.span ? 0 : pageNonceBytes,
      totalBytes = 0,
      submodules = 0;
    for (let row = 0; row < range.rows; row++) {
      if (offset + fixed > raw.length) return null;
      const length = raw.readUInt32LE(offset);
      const pathStart = offset + fixed;
      if (!length || pathStart + length > raw.length) return null;
      const code = raw[offset + 8]!;
      if (code >= modes.length) return null;
      totalBytes += raw.readUInt32LE(offset + 4);
      submodules += Number(modes[code] === '160000');
      starts[row] = offset;
      offset = pathStart + length;
    }
    if (offset !== raw.length) return null;
    starts[range.rows] = offset;
    return new ListingPage(raw, starts, shaBytes, range.start, totalBytes, submodules);
  }
  path(row: number) {
    return this.raw.toString('utf8', this.starts[row]! + fixedBytes + this.shaBytes, this.starts[row + 1]!);
  }
  size(row: number) {
    return this.raw.readUInt32LE(this.starts[row]! + 4);
  }
  mode(row: number): GithubSourceEntry['mode'] {
    return modes[this.raw[this.starts[row]! + 8]!]!;
  }
  entry(row: number): ListedGithubEntry {
    const shaStart = this.starts[row]! + fixedBytes;
    return {
      row: this.start + row,
      path: this.path(row),
      sha: this.raw.toString('hex', shaStart, shaStart + this.shaBytes),
      size: this.size(row),
      mode: this.mode(row),
    };
  }

  *blocks(pin: Page): Iterable<ListingRange> {
    for (let row = 0; row < this.length;) {
      const offset = this.starts[row]!;
      let end = row + 1;
      while (end < this.length && end - row < lookupRows && this.starts[end + 1]! - offset <= lookupBytes)
        end++;
      const bytes = this.raw.subarray(offset, this.starts[end]!);
      yield {
        pin,
        first: this.path(row),
        start: this.start + row,
        rows: end - row,
        span: { offset, size: bytes.length, sha256: digest(bytes) },
      };
      row = end;
    }
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

type ReadPage = (pin: Page, span?: ListingSpan) => Promise<Buffer | null>;

/** Verify the selected listing before doing acquisition work. Later passes
 * walk its ranges in order. Tar members select small blocks by first path so
 * an out-of-order archive cannot force a whole page read per member.
 * The reader may reuse its backing bytes. Consume each page before reading
 * another page or looking up another range. Individual entries own their values. */
export class ListingPages {
  private loaded: { range: ListingRange; page: ListingPage } | undefined;

  private constructor(
    private readonly index: ListingIndex,
    private readonly ranges: ListingRange[],
    private readonly blocks: ListingRange[],
    private readonly read: ReadPage,
  ) {}

  static async open(index: ListingIndex, read: ReadPage, indexTarMembers = true) {
    const ranges: ListingRange[] = [];
    const blocks: ListingRange[] = [];
    let start = 0,
      totalBytes = 0,
      submodules = 0,
      last = '';
    for (const pin of index.pages) {
      if (pin.first <= last) return null;
      const range = { pin, first: pin.first, start, rows: pin.rows };
      const raw = await read(pin);
      const page = raw && ListingPage.decode(raw, range, index.shaBytes);
      if (!page || page.path(0) !== pin.first) return null;
      for (let row = 0; row < page.length; row++) {
        const path = page.path(row);
        if (path <= last) return null;
        last = path;
      }
      ranges.push(range);
      if (indexTarMembers) for (const block of page.blocks(pin)) blocks.push(block);
      start += page.length;
      totalBytes += page.totalBytes;
      submodules += page.submodules;
    }
    if (start !== index.files || totalBytes !== index.totalBytes || submodules !== index.submodules)
      return null;
    return new ListingPages(index, ranges, blocks, read);
  }

  get length() {
    return this.index.files;
  }
  get totalBytes() {
    return this.index.totalBytes;
  }
  get submodules() {
    return this.index.submodules;
  }

  private async load(range: ListingRange) {
    if (this.loaded?.range === range) return this.loaded.page;
    const raw = await this.read(range.pin, range.span);
    const page = raw && ListingPage.decode(raw, range, this.index.shaBytes);
    invariant(page, 'IMPORT_INCOMPLETE', 'A verified import listing page could not be read.');
    this.loaded = { range, page };
    return page;
  }

  async *pages() {
    for (const range of this.ranges) yield await this.load(range);
  }

  async lookup(path: string) {
    let low = 0,
      high = this.blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.blocks[middle]!.first <= path) low = middle + 1;
      else high = middle;
    }
    if (!low) return undefined;
    const page = await this.load(this.blocks[low - 1]!);
    const row = page.index(path);
    return row < 0 ? undefined : page.entry(row);
  }
}
export const pinsHeaderBytes = 92;
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
  retain(keep: (index: number) => boolean, start = 0, end = this.length) {
    for (let index = start; index < end; index++) {
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
    if (!matchesPinCheckpoint(bytes, bytes.length, tree, listing, length)) return null;
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
}

/** The same identity check applies to a complete checkpoint opened by range. */
export function matchesPinCheckpoint(
  header: Buffer,
  size: number,
  tree: string,
  listing: string,
  length: number,
) {
  return (
    header.length >= pinsHeaderBytes &&
    size === pinsHeaderBytes + length * pinRowBytes &&
    header.toString('ascii', 0, 4) === 'NFP1' &&
    header.readUInt32LE(4) === length &&
    header[8] === tree.length &&
    header.toString('hex', 12, 12 + tree.length / 2) === tree &&
    header.toString('hex', 44, 76) === listing
  );
}
