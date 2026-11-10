// SPDX-License-Identifier: Apache-2.0
import type { ObjectPack } from './object-pack-range.js';

export type CatalogEntry = {
  digest: string;
  size: number;
  stateGeneration?: number;
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
  private extra = new Map<number, Pick<CatalogEntry, 'recipe' | 'stateGeneration'>>();
  private probe = Buffer.alloc(32);

  has(digest: string) {
    return this.find(digest) >= 0;
  }
  get(digest: string): CatalogEntry | undefined {
    const row = this.find(digest);
    return row < 0 ? undefined : this.entry(row, digest);
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
    if (entry.recipe || entry.stateGeneration !== undefined)
      this.extra.set(row, {
        ...(entry.recipe ? { recipe: { digest: entry.recipe.digest, size: entry.recipe.size } } : {}),
        ...(entry.stateGeneration === undefined ? {} : { stateGeneration: entry.stateGeneration }),
      });
    else this.extra.delete(row);
    return this;
  }
  *values(): Generator<CatalogEntry> {
    for (let row = 0; row < this.size; row++) yield this.entry(row);
  }
  /** Every entry in ascending digest order (the catalog's row order). */
  *sorted(): Generator<CatalogEntry> {
    const digests = this.digests;
    const order = new Uint32Array(this.size);
    for (let row = 0; row < this.size; row++) order[row] = row;
    order.sort((a, b) => digests.compare(digests, b * 32, b * 32 + 32, a * 32, a * 32 + 32));
    for (const row of order) yield this.entry(row);
  }
  private entry(row: number, digest = this.digests.toString('hex', row * 32, row * 32 + 32)) {
    const pack = this.packs[row]!,
      extra = this.extra.get(row);
    const entry: CatalogEntry = { digest, size: this.sizes[row]! };
    if (extra?.stateGeneration !== undefined) entry.stateGeneration = extra.stateGeneration;
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
  }
}
