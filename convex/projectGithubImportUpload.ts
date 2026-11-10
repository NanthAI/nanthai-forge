// SPDX-License-Identifier: Apache-2.0
'use node';
import { createHash } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { presignPut, r2Config, headObject, checksumOf, r2Key } from './r2';
import { exchangeFetch } from '../src/exchange-request';
import { withExchangeObservation, currentExchangeObservation } from '../src/exchange-observation';
import { ObjectRecipeBuilder } from '../src/object-chunks';
import { digest } from '../src/hash';
import { mapExchange } from '../src/exchange-parallel';
import { invariant } from '../src/errors';
import { importPageBytes, importPageFiles } from '../src/github-import-pages';
import type { CatalogEntry } from '../src/import-catalog-table';
export type Completions = {
  id: Id<'projectObjects'>;
  storageId?: Id<'_storage'>;
  key?: string;
}[];
export type Recipes = {
  digest: string;
  size: number;
  stateGeneration?: number;
  recipeDigest: string;
  recipeSize: number;
}[];
export type { CatalogEntry };
/** Catalog mode (archive imports): stored objects are this set (a CatalogTable in an
 * import; a Map in a test), not projectObjects rows. Each window is one receipt;
 * publication writes the sorted catalog. */
export type ImportCatalog = {
  stored: {
    has(digest: string): boolean;
    get(digest: string): CatalogEntry | undefined;
    set(digest: string, entry: CatalogEntry): unknown;
  };
  record: (objects: CatalogEntry[], state?: { sha256: string; size: number }) => Promise<void>;
};
/** Retains one bounded source window plus its pack copy and one stream chunk. */
export class ImportUpload {
  private objects = new Map<string, Buffer>();
  private bytes = 0;
  peakBufferedBytes = 0;
  /** Bytes staged for the next drain, so callers can size a fetch window. */
  get stagedBytes() {
    return this.bytes;
  }
  private completions: Completions = [];
  private recipes: Recipes = [];
  private entries: CatalogEntry[] = [];
  /** Objects newly written by this upload; already stored ones are skipped. */
  uploaded = 0;
  putAttempts = 0;
  putBytes = 0;
  uploadMillis = 0;
  constructor(
    private ctx: ActionCtx,
    private projectId: Id<'hostedProjects'>,
    private actor: string,
    private concurrency = 8,
    private catalog?: ImportCatalog,
  ) {}
  put = (bytes: Buffer) => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    if (!this.objects.has(pin.sha256) && !this.catalog?.stored.has(pin.sha256)) {
      this.objects.set(pin.sha256, Buffer.from(bytes));
      this.bytes += bytes.length;
      this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.bytes);
    }
    return pin;
  };
  async drain(force = false) {
    if (!force && this.bytes < importPageBytes && this.objects.size < importPageFiles) return false;
    if (!this.objects.size) return false;
    // A provider read may emit more than one chunk, so also partition by count.
    const pending = [...this.objects];
    this.objects.clear();
    this.bytes = 0;
    if (this.catalog) {
      await this.storeCatalogWindow(pending);
      return true;
    }
    for (let start = 0; start < pending.length; start += importPageFiles) {
      const page = pending.slice(start, start + importPageFiles);
      const prepared = await this.ctx.runMutation(internal.projectGithubImportBatch.prepare, {
        projectId: this.projectId,
        actor: this.actor,
        objects: page.map(([digest, bytes]) => ({
          digest,
          size: bytes.length,
        })),
      });
      await mapExchange(page, this.concurrency, async ([digest, bytes], i) => {
        const target = prepared[i]!;
        if (target.stored) return;
        this.uploaded++;
        // Every import object uploads to R2; prepare always returns its key.
        invariant(target.key, 'R2_REQUIRED', 'Import objects upload to R2 only.');
        const config = r2Config(),
          put = await presignPut(config, target.key, {
            digest,
            size: bytes.length,
          });
        const response = await exchangeFetch('R2 import page upload', put.url, {
          method: 'PUT',
          headers: put.headers,
          body: new Uint8Array(bytes),
        });
        invariant(
          response.ok || response.status === 412,
          'R2_UPLOAD_FAILED',
          'Object storage could not upload source.',
        );
        // The signed SHA-256 checksum and length make a successful PUT a
        // verified write. Only an existing key (412) needs its bytes checked.
        if (!response.ok) {
          const head = await headObject(config, target.key);
          invariant(
            head.status === 'ok' &&
              head.size === bytes.length &&
              (!head.checksum || head.checksum === checksumOf(digest)),
            'R2_VERIFY_FAILED',
            'Object storage could not verify source.',
          );
        }
        this.completions.push({ id: target.id, key: target.key });
      });
      if (start + importPageFiles < pending.length) await this.commit();
    }
    return true;
  }
  /** One immutable pack per bounded window; empty and singleton objects stay raw. */
  private async storeCatalogWindow(pending: [string, Buffer][]) {
    const started = Date.now();
    const config = r2Config(),
      stored = this.catalog!.stored;
    const fresh = pending.filter(([id]) => !stored.has(id));
    const packed = fresh.filter(([, bytes]) => bytes.length > 0);
    const groups =
      packed.length > 1
        ? [packed, ...fresh.filter(([, bytes]) => !bytes.length).map(row => [row])]
        : fresh.map(row => [row]);
    await mapExchange(groups, this.concurrency, async group => {
      const bytes = group.length > 1 ? Buffer.concat(group.map(([, bytes]) => bytes)) : group[0]![1];
      const packDigest = group.length > 1 ? digest(bytes) : group[0]![0];
      this.peakBufferedBytes = Math.max(
        this.peakBufferedBytes,
        group.length > 1 ? bytes.length * 2 : bytes.length,
      );
      const key = r2Key(this.projectId, packDigest),
        put = await presignPut(config, key, {
          digest: packDigest,
          size: bytes.length,
        });
      const { value: response } = await withExchangeObservation(async () => {
        try {
          return await exchangeFetch('R2 import page upload', put.url, {
            method: 'PUT',
            headers: put.headers,
            body: new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length),
          });
        } finally {
          const measured = currentExchangeObservation()!.measured;
          this.putAttempts += measured.requests;
          this.putBytes += measured.requestBodyBytes;
        }
      });
      invariant(
        response.ok || response.status === 412,
        'R2_UPLOAD_FAILED',
        'Object storage could not upload source.',
      );
      if (!response.ok) {
        const head = await headObject(config, key);
        invariant(
          head.status === 'ok' &&
            head.size === bytes.length &&
            (!head.checksum || head.checksum === checksumOf(packDigest)),
          'R2_VERIFY_FAILED',
          'Object storage could not verify source.',
        );
      }
      let offset = 0;
      for (const [id, content] of group) {
        const entry: CatalogEntry = {
          digest: id,
          size: content.length,
          ...(group.length > 1 ? { pack: { digest: packDigest, size: bytes.length, offset } } : {}),
        };
        stored.set(id, entry);
        this.entries.push(entry);
        this.uploaded++;
        offset += content.length;
      }
      // The physical pack is source too. A later upload of these exact bytes
      // must reuse a protected binding, never create a disposable log/artifact
      // row whose cleanup could delete a pack referenced by accepted source.
      if (group.length > 1 && !stored.has(packDigest)) {
        const physical = { digest: packDigest, size: bytes.length };
        stored.set(packDigest, physical);
        this.entries.push(physical);
      }
    });
    this.uploadMillis += Date.now() - started;
    console.log(
      `FORGE_IMPORT_METRIC ${JSON.stringify({ projectId: this.projectId, phase: 'upload', at: Date.now(), objects: pending.length, putAttempts: this.putAttempts, putBytes: this.putBytes, uploadMillis: this.uploadMillis, peakBufferedBytes: this.peakBufferedBytes })}`,
    );
  }
  async commit(state?: { sha256: string; size: number }) {
    if (this.catalog) {
      const objects = this.catalogReceipt();
      if (objects.length) await this.catalog.record(objects, state);
      return;
    }
    if (!this.completions.length && !this.recipes.length) return;
    await this.ctx.runMutation(internal.projectGithubImportBatch.complete, {
      projectId: this.projectId,
      actor: this.actor,
      ...this.receipt(),
    });
  }
  /** Stored raw objects, plus recipes whose recipe object is already stored. */
  catalogReceipt() {
    const stored = this.catalog!.stored,
      ready = this.recipes.filter(pin => stored.has(pin.recipeDigest));
    this.recipes = this.recipes.filter(pin => !stored.has(pin.recipeDigest));
    for (const pin of ready) {
      const entry = {
        digest: pin.digest,
        size: pin.size,
        ...(pin.stateGeneration === undefined ? {} : { stateGeneration: pin.stateGeneration }),
        recipe: { digest: pin.recipeDigest, size: pin.recipeSize },
      };
      if (stored.has(pin.digest)) continue;
      stored.set(pin.digest, entry);
      this.entries.push(entry);
    }
    const objects = this.entries;
    this.entries = [];
    return objects;
  }
  receipt() {
    const value = { objects: this.completions, recipes: this.recipes };
    this.completions = [];
    this.recipes = [];
    return value;
  }
  recipe(pin: { blob: string; size: number }, bytes: Buffer, stateGeneration?: number) {
    const ref = this.put(bytes);
    this.recipes.push({
      ...(stateGeneration === undefined ? {} : { stateGeneration }),
      digest: pin.blob,
      size: pin.size,
      recipeDigest: ref.sha256,
      recipeSize: ref.size,
    });
  }
  /** Stream arbitrarily large logical metadata without a whole-repository buffer.
   * `markState` records the finished object on the import job with its last window. */
  async stream(parts: AsyncIterable<Buffer>, stateGeneration?: number, markState = false) {
    const hash = createHash('sha256');
    let size = 0;
    const builder = new ObjectRecipeBuilder(this.put);
    for await (const bytes of parts) {
      hash.update(bytes);
      size += bytes.length;
      builder.update(bytes);
      if (await this.drain()) await this.commit();
    }
    const pin = { blob: hash.digest('hex'), size };
    const recipe = builder.finish({ sha256: pin.blob, size });
    this.recipe(pin, recipe.bytes, stateGeneration);
    await this.drain(true);
    await this.commit(markState ? { sha256: pin.blob, size } : undefined);
    return { sha256: pin.blob, size };
  }
}
