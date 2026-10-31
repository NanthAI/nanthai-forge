// SPDX-License-Identifier: Apache-2.0
'use node';
import { createHash } from 'node:crypto';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { presignPut, r2Config, headObject, checksumOf } from './r2';
import { exchangeFetch } from '../src/exchange-request';
import { ObjectRecipeBuilder } from '../src/object-chunks';
import { digest } from '../src/hash';
import { mapExchange } from '../src/exchange-parallel';
import { invariant } from '../src/errors';
import { importPageBytes, importPageFiles } from '../src/github-import-pages';
export type Completions = { id: Id<'projectObjects'>; storageId?: Id<'_storage'>; key?: string }[];
export type Recipes = { digest: string; size: number; recipeDigest: string; recipeSize: number }[];
/** Retains at most an 8 MiB physical window plus one stream read/chunk. */
export class ImportUpload {
  private objects = new Map<string, Buffer>();
  private bytes = 0;
  peakBufferedBytes = 0;
  private completions: Completions = [];
  private recipes: Recipes = [];
  /** Objects newly written by this upload; already stored ones are skipped. */
  uploaded = 0;
  constructor(
    private ctx: ActionCtx,
    private projectId: Id<'hostedProjects'>,
    private actor: string,
    private concurrency = 8,
  ) {}
  put = (bytes: Buffer) => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    if (!this.objects.has(pin.sha256)) {
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
    for (let start = 0; start < pending.length; start += importPageFiles) {
      const page = pending.slice(start, start + importPageFiles);
      const prepared = await this.ctx.runMutation(internal.projectGithubImportBatch.prepare, {
        projectId: this.projectId,
        actor: this.actor,
        objects: page.map(([digest, bytes]) => ({ digest, size: bytes.length })),
      });
      await mapExchange(page, this.concurrency, async ([digest, bytes], i) => {
        const target = prepared[i]!;
        if (target.stored) return;
        this.uploaded++;
        // Every import object uploads to R2; prepare always returns its key.
        invariant(target.key, 'R2_REQUIRED', 'Import objects upload to R2 only.');
        const config = r2Config(),
          put = await presignPut(config, target.key, { digest, size: bytes.length });
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
  async commit() {
    if (!this.completions.length && !this.recipes.length) return;
    await this.ctx.runMutation(internal.projectGithubImportBatch.complete, {
      projectId: this.projectId,
      actor: this.actor,
      ...this.receipt(),
    });
  }
  receipt() {
    const value = { objects: this.completions, recipes: this.recipes };
    this.completions = [];
    this.recipes = [];
    return value;
  }
  recipe(pin: { blob: string; size: number }, bytes: Buffer) {
    const ref = this.put(bytes);
    this.recipes.push({ digest: pin.blob, size: pin.size, recipeDigest: ref.sha256, recipeSize: ref.size });
  }
  /** Stream arbitrarily large logical metadata without a whole-repository buffer. */
  async stream(parts: AsyncIterable<Buffer>) {
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
    this.recipe(pin, recipe.bytes);
    await this.drain(true);
    await this.commit();
    return { sha256: pin.blob, size };
  }
}
