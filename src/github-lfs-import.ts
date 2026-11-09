// SPDX-License-Identifier: Apache-2.0
import type { GithubFetch } from './github.js';
import type { GithubSourceEntry } from './github-project-source.js';
import { networkFetch } from './network-fetch.js';
import { objectChunkBytes } from './object-chunks.js';
import { mapExchange } from './exchange-parallel.js';
import { ForgeError } from './errors.js';
import {
  formatLfsPointer,
  isGitattributesPath,
  isLfsPath,
  lfsBatch,
  lfsBatchObjects,
  lfsRules,
  parseLfsPointer,
  streamLfsObject,
  type LfsPointer,
} from './github-lfs.js';

type Pin = { blob: string; size: number };
export type LfsImportIO = {
  repository: string;
  /** Undefined for a public repository: the batch API is read anonymously. */
  token?: string;
  stored(oid: string): boolean;
  put(bytes: Buffer): { sha256: string; size: number };
  /** Streams one large object into a chunk recipe bound to `pointer`. */
  large(
    pointer: LfsPointer,
    read: (consume: (part: Buffer) => Promise<void>) => Promise<void>,
  ): Promise<void>;
  record(entry: GithubSourceEntry, pin: Pin): void;
  drain(): Promise<void>;
  over(): boolean;
  request?: GithubFetch;
};
const gib = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
const attributeBytes = 1024 * 1024;

/** Archive imports hold pointer-shaped files until every `.gitattributes` has
 * been seen; only paths Git would smudge (`filter=lfs`) become their objects.
 * A limit of 0 keeps every pointer as committed bytes. */
export class LfsImport {
  private held = new Map<string, { entry: GithubSourceEntry; pointer: LfsPointer; bytes?: Buffer }>();
  private attributes: { path: string; text: string }[] = [];
  /** Unique LFS bytes bound into the State (counted once per oid). */
  objectBytes = 0;
  objects = 0;
  fetched = 0;
  constructor(private limitBytes: number) {}

  /** True when the caller must not store these committed bytes yet. */
  hold(entry: GithubSourceEntry, bytes: Buffer): boolean {
    if (entry.mode !== '100644' && entry.mode !== '100755') return false;
    if (isGitattributesPath(entry.path) && bytes.length <= attributeBytes)
      this.attributes.push({ path: entry.path, text: bytes.toString('utf8') });
    if (this.limitBytes === 0) return false;
    const pointer = parseLfsPointer(bytes);
    if (!pointer) return false;
    // Canonical pointers are regenerated; only unusual spellings keep bytes.
    const canonical = formatLfsPointer(pointer).equals(bytes);
    this.held.set(entry.path, { entry, pointer, ...(canonical ? {} : { bytes: Buffer.from(bytes) }) });
    return true;
  }
  isHeld = (path: string) => this.held.has(path);

  /** Binds held paths: pointers Git would not smudge keep their bytes; LFS paths
   * bind their object, fetched once per oid unless an earlier run stored it. */
  async resolve(io: LfsImportIO): Promise<void> {
    const rules = lfsRules(this.attributes);
    const wanted = new Map<string, { pointer: LfsPointer; entries: GithubSourceEntry[] }>();
    for (const { entry, pointer, bytes } of this.held.values()) {
      if (!isLfsPath(rules, entry.path)) {
        const pin = io.put(bytes ?? formatLfsPointer(pointer));
        io.record(entry, { blob: pin.sha256, size: pin.size });
        continue;
      }
      const object = wanted.get(pointer.oid) ?? { pointer, entries: [] };
      object.entries.push(entry);
      wanted.set(pointer.oid, object);
    }
    this.held.clear();
    const objects = [...wanted.values()];
    this.objects = objects.length;
    this.objectBytes = objects.reduce((sum, object) => sum + object.pointer.size, 0);
    if (this.objectBytes > this.limitBytes) {
      const largest = objects.reduce((a, b) => (b.pointer.size > a.pointer.size ? b : a));
      throw new ForgeError(
        'GITHUB_LFS_LIMIT',
        `This commit's ${objects.length} Git LFS objects total ${gib(this.objectBytes)}, over this import's ${gib(this.limitBytes)} LFS limit (largest: ${largest.entries[0]!.path}, ${gib(largest.pointer.size)}). Nothing was downloaded and main was not published. Retry with a new operation and lfsLimitBytes up to 8 GiB, or lfsLimitBytes 0 to keep LFS pointers as committed bytes.`,
      );
    }
    const bind = (object: (typeof objects)[number]) => {
      for (const entry of object.entries)
        io.record(entry, { blob: object.pointer.oid, size: object.pointer.size });
    };
    const pending = objects.filter(object => {
      if (!io.stored(object.pointer.oid)) return true;
      bind(object);
      return false;
    });
    const request = io.request ?? networkFetch;
    for (let at = 0; at < pending.length && !io.over(); at += lfsBatchObjects) {
      const page = pending.slice(at, at + lfsBatchObjects);
      const replies = new Map(
        (
          await lfsBatch(
            io.repository,
            'download',
            page.map(object => object.pointer),
            io.token,
            request,
          )
        ).map(reply => [reply.oid, reply]),
      );
      const action = (object: (typeof page)[number]) => {
        const reply = replies.get(object.pointer.oid);
        if (reply?.download) return reply.download;
        throw new ForgeError(
          'GITHUB_LFS_OBJECT_MISSING',
          `GitHub LFS has no object for ${object.entries[0]!.path} (${reply?.error?.message ?? 'not returned'}). Main was not published. Retry with a new operation and lfsLimitBytes 0 to keep LFS pointers as committed bytes.`,
        );
      };
      const small = page.filter(object => object.pointer.size <= objectChunkBytes);
      for (let i = 0; i < small.length && !io.over(); i += 8) {
        await mapExchange(small.slice(i, i + 8), 8, async object => {
          const parts: Buffer[] = [];
          await streamLfsObject(
            object.pointer,
            action(object),
            async part => {
              parts.push(Buffer.from(part));
            },
            request,
          );
          io.put(Buffer.concat(parts));
          this.fetched++;
          bind(object);
        });
        await io.drain();
      }
      for (const object of page.filter(object => object.pointer.size > objectChunkBytes)) {
        if (io.over()) break;
        await io.large(object.pointer, consume =>
          streamLfsObject(object.pointer, action(object), consume, request),
        );
        this.fetched++;
        bind(object);
      }
    }
  }
}
