// SPDX-License-Identifier: Apache-2.0
import { closeSync, openSync, writeSync, unlinkSync } from 'node:fs';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readNestedCheckoutNode } from './hosted-checkout-recipe-read.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { exchangeRequest } from './exchange-request.js';
import { mapExchange } from './exchange-parallel.js';
import {
  objectRecipeSchema,
  objectChunkPageSchema,
  readObjectRecipe,
  type ObjectRecipe,
} from './object-chunks.js';
import type { TreeRef } from './native-exchange-tree.js';
import type { ContentPin } from './native-exchange.js';
import type { ConvexExchange } from './exchange-client.js';
import type { DownloadRow } from './blob-download-format.js';
import type { CheckoutObjectTransport } from './hosted-checkout-cache.js';
import { latestClientSourcePack } from './source-pack-client.js';
const rowSchema = z.discriminatedUnion('location', [
  z.object({
    digest: z.string(),
    size: z.number().safe().nonnegative(),
    location: z.literal('r2'),
    url: z.url(),
  }),
  z.object({
    digest: z.string(),
    size: z.number().safe().nonnegative(),
    location: z.literal('convex'),
    url: z.url(),
  }),
  z.object({
    digest: z.string(),
    size: z.number().safe().nonnegative(),
    location: z.literal('recipe'),
    recipe: z.object({ digest: z.string(), size: z.number().safe().nonnegative() }),
  }),
]);
function writeAll(fd: number, bytes: Uint8Array) {
  for (let at = 0; at < bytes.length;) {
    const count = writeSync(fd, bytes, at, bytes.length - at);
    invariant(count > 0, 'EXCHANGE_DOWNLOAD_FAILED', 'Checkout staging write was incomplete.');
    at += count;
  }
}
/** One finite checkout transfer. Metadata and signatures travel together in <=100-pin
 * pages; bytes never pass through a Convex function. The caller reauthorizes before
 * installing files. This memory holds locations only, never a project's file bytes. */
export class HostedCheckoutDownloads implements CheckoutObjectTransport {
  private readonly recipes = new Map<string, ObjectRecipe>();
  private readonly rows = new Map<string, DownloadRow & { url?: string }>();
  constructor(private readonly exchange: Pick<ConvexExchange, 'client' | 'projectId'>) {}
  sourcePack() {
    return latestClientSourcePack(this.exchange.client as never, this.exchange.projectId);
  }
  async objects(digests: string[]): Promise<ContentPin[]> {
    const rows = z
      .array(rowSchema)
      .parse(
        await this.exchange.client.mutation(
          makeFunctionReference<'mutation'>('projectObjectDownloads:describe'),
          { projectId: this.exchange.projectId, digests, signed: true },
        ),
      );
    invariant(
      rows.length === digests.length && rows.every((row, i) => row.digest === digests[i]),
      'INVALID_NATIVE_SOURCE',
      'Source locations differ from selected content.',
    );
    for (const row of rows) this.rows.set(row.digest, row);
    return rows.map(row => ({ sha256: row.digest, size: row.size }));
  }
  private async prepare(pins: ContentPin[]) {
    const missing = [
      ...new Map(pins.filter(pin => !this.rows.has(pin.sha256)).map(pin => [pin.sha256, pin])).values(),
    ];
    for (let at = 0; at < missing.length; at += 100)
      await this.objects(missing.slice(at, at + 100).map(pin => pin.sha256));
    for (const pin of pins)
      invariant(
        this.rows.get(pin.sha256)?.size === pin.size,
        'INVALID_NATIVE_SOURCE',
        'Source location differs from selected size.',
      );
  }
  private async read<T>(
    pin: ContentPin,
    consume: (response: Response, progressed: () => void) => Promise<T>,
  ): Promise<T> {
    await this.prepare([pin]);
    let row = this.rows.get(pin.sha256)!;
    invariant(row.location !== 'recipe', 'INVALID_NATIVE_SOURCE', 'Recipe nodes must be physical objects.');
    for (let attempt = 0; ; attempt++) {
      const result = await exchangeRequest(
        'Checkout content download',
        row.url!,
        {
          headers: { 'accept-encoding': 'identity' },
        },
        async (response, progressed) => {
          if (response.status === 403 && row.location === 'r2' && attempt === 0) {
            await response.body?.cancel();
            return { refresh: true as const };
          }
          invariant(
            response.ok,
            'EXCHANGE_DOWNLOAD_DENIED',
            `Stored content download failed (HTTP ${response.status}).`,
          );
          return { refresh: false as const, value: await consume(response, progressed) };
        },
      );
      if (!result.refresh) return result.value;
      await this.objects([pin.sha256]);
      row = this.rows.get(pin.sha256)!;
      invariant(
        row.size === pin.size && row.location === 'r2',
        'INVALID_NATIVE_SOURCE',
        'Source location changed.',
      );
    }
  }
  private async physical(pin: ContentPin): Promise<Buffer> {
    await this.prepare([pin]);
    if (this.rows.get(pin.sha256)?.location === 'recipe')
      return readNestedCheckoutNode(pin, async (ids, refresh) => {
        const missing = refresh ? ids : ids.filter(id => !this.rows.has(id));
        if (missing.length) await this.objects(missing);
        return ids.map(id => this.rows.get(id)!);
      });
    return this.read(pin, async (response, progressed) => {
      const chunks: Uint8Array[] = [],
        reader = response.body?.getReader();
      let size = 0;
      if (reader)
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            invariant(
              size <= pin.size,
              'INVALID_NATIVE_SOURCE',
              'Downloaded source exceeds its selected size.',
            );
            chunks.push(chunk.value);
            progressed();
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      const bytes = Buffer.concat(chunks);
      invariant(
        bytes.length === pin.size && digest(bytes) === pin.sha256,
        'INVALID_NATIVE_SOURCE',
        'Downloaded source is truncated or corrupt.',
      );
      return bytes;
    });
  }
  async downloadToFile(pin: ContentPin, path: string) {
    await this.prepare([pin]);
    const row = this.rows.get(pin.sha256)!;
    if (row.location !== 'recipe')
      return this.read(pin, async (response, progressed) => {
        // Open/clean each attempt inside the request deadline; retries never append
        // to a previous partial file. Raw logical files have no in-memory size cap.
        const fd = openSync(path, 'wx', 0o600),
          hash = createHash('sha256'),
          reader = response.body?.getReader();
        let size = 0,
          complete = false;
        try {
          if (reader)
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length;
              invariant(
                size <= pin.size,
                'INVALID_NATIVE_SOURCE',
                'Downloaded source exceeds its selected size.',
              );
              hash.update(chunk.value);
              writeAll(fd, chunk.value);
              progressed();
            }
          invariant(
            size === pin.size && hash.digest('hex') === pin.sha256,
            'INVALID_NATIVE_SOURCE',
            'Downloaded source is truncated or corrupt.',
          );
          complete = true;
        } finally {
          closeSync(fd);
          if (!complete) unlinkSync(path);
          await reader?.cancel().catch(() => undefined);
          reader?.releaseLock();
        }
      });
    const fd = openSync(path, 'wx', 0o600);
    try {
      const recipePin = { sha256: row.recipe.digest, size: row.recipe.size };
      const recipe =
        this.recipes.get(pin.sha256) ??
        objectRecipeSchema.parse(JSON.parse((await this.physical(recipePin)).toString('utf8')));
      invariant(
        recipe.object.sha256 === pin.sha256 && recipe.object.size === pin.size,
        'INVALID_NATIVE_SOURCE',
        'Recipe differs from selected logical source.',
      );
      for await (const bytes of readObjectRecipe(
        recipe,
        item => this.physical(item),
        items => this.prepare(items),
      ))
        writeAll(fd, bytes);
    } finally {
      closeSync(fd);
    }
  }
  private async prepareRecipes(pins: ContentPin[]) {
    const logical = pins.filter(pin => this.rows.get(pin.sha256)?.location === 'recipe');
    const recipePin = (pin: ContentPin) => {
      const row = this.rows.get(pin.sha256)!;
      invariant(row.location === 'recipe', 'INVALID_NATIVE_SOURCE', 'Select recipe content.');
      return { sha256: row.recipe.digest, size: row.recipe.size };
    };
    await this.prepare(logical.map(recipePin));
    const recipes = await mapExchange(logical, 4, async pin => {
      const recipe = objectRecipeSchema.parse(
        JSON.parse((await this.physical(recipePin(pin))).toString('utf8')),
      );
      invariant(
        recipe.object.sha256 === pin.sha256 &&
          recipe.object.size === pin.size &&
          recipe.tree.length === pin.size,
        'INVALID_NATIVE_SOURCE',
        'Recipe differs from selected logical source.',
      );
      this.recipes.set(pin.sha256, recipe);
      return recipe;
    });
    // Batch every tree level across all logical objects in this <=100-file window.
    // Only index pages are read here; leaves stream later, one bounded chunk at a time.
    let pending: TreeRef[] = recipes.map(recipe => recipe.tree);
    while (pending.length) {
      const refs = [...new Map(pending.map(ref => [JSON.stringify(ref), ref])).values()];
      for (const ref of refs)
        invariant(
          ref.size <= (ref.height === 0 ? 1024 * 1024 : 2 * 1024 * 1024),
          'INVALID_NATIVE_SOURCE',
          'Recipe node exceeds its bounded encoding.',
        );
      await this.prepare(refs);
      const pages = await mapExchange(
        refs.filter(ref => ref.height > 0),
        4,
        async ref => {
          const page = objectChunkPageSchema.parse(JSON.parse((await this.physical(ref)).toString('utf8')));
          invariant(
            page.children.every(child => child.height < ref.height) &&
              page.children.reduce((sum, child) => sum + child.length, 0) === ref.length,
            'INVALID_NATIVE_SOURCE',
            'Recipe ancestry or length is invalid.',
          );
          return page.children;
        },
        { bytes: 16 * 1024 * 1024, size: ref => ref.size },
      );
      pending = pages.flat();
    }
  }
  async downloadFiles(files: { pin: ContentPin; path: string }[]) {
    const before = new Set(this.rows.keys()),
      consumed = new Set(files.map(file => file.pin.sha256));
    try {
      await this.prepareRecipes(files.map(file => file.pin));
      // Large/recipe objects stream one at a time; small files have four concurrent GETs.
      const small = files.filter(file => file.pin.size <= 2 * 1024 * 1024);
      await mapExchange(small, 4, file => this.downloadToFile(file.pin, file.path), {
        bytes: 16 * 1024 * 1024,
        size: file => file.pin.size,
      });
      for (const file of files)
        if (file.pin.size > 2 * 1024 * 1024) await this.downloadToFile(file.pin, file.path);
    } finally {
      // Keep only unused pins from the original metadata page, not signatures
      // for every file/chunk in the checkout. Source bytes remain on disk.
      for (const id of this.rows.keys()) if (consumed.has(id) || !before.has(id)) this.rows.delete(id);
      this.recipes.clear();
    }
  }
}
