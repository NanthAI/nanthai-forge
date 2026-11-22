// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { StateSize } from './state/size.js';
import type { ObjectPack } from './object-pack-range.js';

export type CatalogEntry = {
  digest: string;
  size: number;
  stateGeneration?: number;
  stateSize?: StateSize;
  recipe?: { digest: string; size: number };
  pack?: ObjectPack;
};
const pin = /^[0-9a-f]{64}$/;

/** The objects an archive import has stored, keyed by SHA-256, with the subset of Map's
 * interface the import uses. Rows are columns (binary digest, size, pack and offset) in an
 * open-addressing index: about 70 bytes an object, where a Map of entry objects held about
 * 270. Recipes, State generations and pack names are few and kept beside the columns.
 * Entries are made on demand; callers never get a reference into the table. */
export class CatalogTable {
  size = 0;
  private digests = Buffer.alloc(0);
  private sizes = new Float64Array(0);
  private packs = new Int32Array(0);
  private offsets = new Float64Array(0);
  private slots = new Int32Array(0);
  private packNames: { digest: string; size: number }[] = [];
  private packIndex = new Map<string, number>();
  private extra = new Map<number, Pick<CatalogEntry, 'recipe' | 'stateGeneration' | 'stateSize'>>();
  private probe = Buffer.alloc(32);
  private importSources = new Uint8Array(0);

  has(digest: string) {
    return this.find(digest) >= 0;
  }
  get(digest: string): CatalogEntry | undefined {
    const row = this.find(digest);
    return row < 0 ? undefined : this.entry(row, digest);
  }
  sizeOf(digest: string) {
    return this.sizes[this.find(digest)];
  }
  /** Map semantics: a digest stored again replaces its row. */
  set(digest: string, entry: CatalogEntry) {
    if (!pin.test(digest) || entry.digest !== digest)
      throw new TypeError('A catalog row is keyed by its own SHA-256.');
    let row = this.find(digest);
    if (row < 0) {
      if (this.size === this.sizes.length) this.grow();
      row = this.size++;
      this.digests.write(digest, row * 32, 'hex');
      if (this.size * 2 > this.slots.length) this.rehash(this.slots.length * 2 || 1024);
      else this.place(row);
    }
    this.sizes[row] = entry.size;
    if (entry.pack) {
      let name = this.packIndex.get(entry.pack.digest);
      if (name === undefined) {
        name = this.packNames.push({ digest: entry.pack.digest, size: entry.pack.size }) - 1;
        this.packIndex.set(entry.pack.digest, name);
      }
      this.packs[row] = name;
      this.offsets[row] = entry.pack.offset;
    } else this.packs[row] = -1;
    if (entry.recipe || entry.stateGeneration !== undefined || entry.stateSize !== undefined)
      this.extra.set(row, {
        ...(entry.recipe ? { recipe: { digest: entry.recipe.digest, size: entry.recipe.size } } : {}),
        ...(entry.stateGeneration === undefined ? {} : { stateGeneration: entry.stateGeneration }),
        ...(entry.stateSize === undefined ? {} : { stateSize: { ...entry.stateSize } }),
      });
    else this.extra.delete(row);
    return this;
  }
  *values(): Generator<CatalogEntry> {
    for (let row = 0; row < this.size; row++) yield this.entry(row);
  }
  /** Verify the file pin and remember only membership, even when many paths share it. */
  markImportSource(digest: string, size: number) {
    const row = this.find(digest);
    invariant(
      row >= 0 && this.sizes[row] === size,
      'IMPORT_INCOMPLETE',
      'A source blob is missing from the stored catalog.',
    );
    this.importSources[row] = 1;
  }
  /** Share the source sort with final catalog publication. The manifest adds
   * only its own metadata objects, which merge into the existing order. */
  importOrder() {
    const addedAt = this.size;
    const order = this.order(0);
    return {
      sources: () => this.orderedSources(order),
      entries: () => this.mergeNewEntries(order, addedAt),
    };
  }
  private *orderedSources(order: Uint32Array) {
    for (const row of order)
      if (this.importSources[row]) yield { sha256: this.digestAt(row), size: this.sizes[row]! };
  }
  private *mergeNewEntries(order: Uint32Array, addedAt: number) {
    const added = this.order(addedAt);
    let next = 0;
    for (const row of order) {
      while (next < added.length && this.compare(added[next]!, row) < 0) yield this.entry(added[next++]!);
      yield this.entry(row);
    }
    while (next < added.length) yield this.entry(added[next++]!);
  }
  /** Every entry in ascending digest order (the catalog's row order). */
  *sorted(): Generator<CatalogEntry> {
    for (const row of this.order(0)) yield this.entry(row);
  }
  private order(start: number) {
    const rows = new Uint32Array(this.size - start);
    for (let row = 0; row < rows.length; row++) rows[row] = start + row;
    return rows.sort((a, b) => this.compare(a, b));
  }
  private compare(a: number, b: number) {
    const digests = this.digests;
    return digests.compare(digests, b * 32, b * 32 + 32, a * 32, a * 32 + 32);
  }
  private digestAt(row: number) {
    return this.digests.toString('hex', row * 32, row * 32 + 32);
  }
  private entry(row: number, digest = this.digestAt(row)) {
    const pack = this.packs[row]!,
      extra = this.extra.get(row);
    const entry: CatalogEntry = { digest, size: this.sizes[row]! };
    if (extra?.stateGeneration !== undefined) entry.stateGeneration = extra.stateGeneration;
    if (extra?.stateSize) entry.stateSize = { ...extra.stateSize };
    if (extra?.recipe) entry.recipe = { ...extra.recipe };
    if (pack >= 0) entry.pack = { ...this.packNames[pack]!, offset: this.offsets[row]! };
    return entry;
  }
  private find(digest: string) {
    // Keys are lowercase SHA-256 hex (set checks); anything not 32 hex bytes is absent.
    if (!this.size || digest.length !== 64 || this.probe.write(digest, 0, 'hex') !== 32) return -1;
    const mask = this.slots.length - 1;
    for (let slot = this.probe.readUInt32BE(0) & mask; ; slot = (slot + 1) & mask) {
      const row = this.slots[slot]! - 1;
      if (row < 0) return -1;
      if (this.digests.compare(this.probe, 0, 32, row * 32, row * 32 + 32) === 0) return row;
    }
  }
  private place(row: number) {
    const mask = this.slots.length - 1;
    let slot = this.digests.readUInt32BE(row * 32) & mask;
    while (this.slots[slot]) slot = (slot + 1) & mask;
    this.slots[slot] = row + 1;
  }
  private rehash(slots: number) {
    this.slots = new Int32Array(slots);
    for (let row = 0; row < this.size; row++) this.place(row);
  }
  private grow() {
    const capacity = Math.max(1024, this.sizes.length * 2);
    const digests = Buffer.alloc(capacity * 32);
    this.digests.copy(digests);
    this.digests = digests;
    for (const name of ['sizes', 'offsets'] as const) {
      const next = new Float64Array(capacity);
      next.set(this[name]);
      this[name] = next;
    }
    const packs = new Int32Array(capacity);
    packs.set(this.packs);
    this.packs = packs;
    const sources = new Uint8Array(capacity);
    sources.set(this.importSources);
    this.importSources = sources;
  }
}
