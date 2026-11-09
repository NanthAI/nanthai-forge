// SPDX-License-Identifier: Apache-2.0
import { checkoutIo } from './checkout-io.js';
import { closeSync, openSync, unlinkSync } from 'node:fs';
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
import { packHeaders, verifyPackRange } from './object-pack-range.js';
import { hostedDownloadPageSize } from './hosted-download-page.js';
import {
  readCompleteRuns,
  runGroups,
  writeAll,
  type PackRunBinding,
  type SignedRun,
} from './hosted-checkout-runs.js';
const rowSchema = z.discriminatedUnion('location', [
  z.object({
    digest: z.string(),
    size: z.number().safe().nonnegative(),
    location: z.literal('r2'),
    url: z.url().optional(),
    range: z
      .object({ offset: z.number().safe().nonnegative(), total: z.number().safe().positive() })
      .optional(),
    run: z
      .object({
        id: z.number().safe().nonnegative(),
        offset: z.number().safe().nonnegative(),
        length: z.number().safe().positive(),
        total: z.number().safe().positive(),
        url: z.url().optional(),
      })
      .optional(),
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
type Row = DownloadRow & { url?: string | undefined; run?: PackRunBinding | undefined };
/** Older servers reject the `runs` argument; they keep the 100-pin, per-object pages. */
const olderServer = (error: unknown) => /extra field `?runs/.test(String((error as Error)?.message));
/** One finite checkout transfer. Metadata and signatures travel together in <=100-pin
 * pages; bytes never pass through a Convex function. The caller reauthorizes before
 * installing files. This memory holds locations only, never a project's file bytes. */
export class HostedCheckoutDownloads implements CheckoutObjectTransport {
  private readonly recipes = new Map<string, ObjectRecipe>();
  private readonly rows = new Map<string, Row>();
  private runs = true;
  private pages = 0;
  constructor(private readonly exchange: Pick<ConvexExchange, 'client' | 'projectId'>) {}
  /** One signed page holds up to 500 pins when the server groups pack runs. */
  get objectPageSize() {
    return this.runs ? hostedDownloadPageSize : 100;
  }
  sourcePack() {
    return latestClientSourcePack(this.exchange.client as never, this.exchange.projectId);
  }
  /** Every transport member, bound, for wrappers that add their own `current`: listing
   * members by hand dropped the page size and run windows (100-pin pages, split runs). */
  transport(options: { sourcePack?: boolean } = {}): CheckoutObjectTransport {
    return {
      // Older servers still take 500-pin windows: `objects` re-pages them by 100.
      objectPageSize: this.objectPageSize,
      objects: ids => this.objects(ids),
      downloadToFile: (pin, path) => this.downloadToFile(pin, path),
      downloadFiles: files => this.downloadFiles(files),
      downloadGroups: pins => this.downloadGroups(pins),
      ...(options.sourcePack === false ? {} : { sourcePack: () => this.sourcePack() }),
    };
  }
  private async describe(digests: string[], runs: boolean) {
    const rows = z.array(rowSchema).parse(
      await this.exchange.client.mutation(
        makeFunctionReference<'mutation'>('projectObjectDownloads:describe'),
        {
          projectId: this.exchange.projectId,
          digests,
          signed: true,
          ...(runs ? { runs: true } : {}),
        },
      ),
    );
    invariant(
      rows.length === digests.length && rows.every((row, i) => row.digest === digests[i]),
      'INVALID_NATIVE_SOURCE',
      'Source locations differ from selected content.',
    );
    const page = this.pages++;
    for (const row of rows) {
      const { run, ...rest } = row as typeof row & { run?: SignedRun & { id: number } };
      invariant(
        row.location !== 'r2' || row.url || run,
        'INVALID_NATIVE_SOURCE',
        'Source location is unsigned.',
      );
      this.rows.set(row.digest, run ? { ...rest, run: { ...run, key: `${page}:${run.id}` } } : rest);
    }
    return rows.map(row => ({ sha256: row.digest, size: row.size }));
  }
  async objects(digests: string[]): Promise<ContentPin[]> {
    if (this.runs && digests.length > 1)
      try {
        const pins: ContentPin[] = [];
        for (let at = 0; at < digests.length; at += hostedDownloadPageSize)
          pins.push(...(await this.describe(digests.slice(at, at + hostedDownloadPageSize), true)));
        return pins;
      } catch (error) {
        if (!olderServer(error)) throw error;
        this.runs = false;
      }
    const pins: ContentPin[] = [];
    for (let at = 0; at < digests.length; at += 100)
      pins.push(...(await this.describe(digests.slice(at, at + 100), false)));
    return pins;
  }
  /** Keep each pack run inside one download window (16 MiB, or one run alone). */
  downloadGroups(pins: ContentPin[]): ContentPin[][] {
    return runGroups(pins, digest => this.rows.get(digest));
  }
  private async prepare(pins: ContentPin[]) {
    const missing = [
      ...new Map(pins.filter(pin => !this.rows.has(pin.sha256)).map(pin => [pin.sha256, pin])).values(),
    ];
    if (missing.length) await this.objects(missing.map(pin => pin.sha256));
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
    // A run member read on its own (outside its run) needs its own exact signature.
    if (!row.url) {
      await this.describe([pin.sha256], false);
      row = this.rows.get(pin.sha256)!;
    }
    for (let attempt = 0; ; attempt++) {
      const result = await exchangeRequest(
        'Checkout content download',
        row.url!,
        {
          headers: {
            'accept-encoding': 'identity',
            ...packHeaders(row.location === 'r2' ? row.range : undefined, pin.size),
          },
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
          verifyPackRange(response, row.location === 'r2' ? row.range : undefined, pin.size);
          return { refresh: false as const, value: await consume(response, progressed) };
        },
      );
      if (!result.refresh) return result.value;
      await this.describe([pin.sha256], false);
      row = this.rows.get(pin.sha256)!;
      invariant(
        row.size === pin.size && row.location === 'r2' && !!row.url,
        'INVALID_NATIVE_SOURCE',
        'Source location changed.',
      );
    }
  }
  private async physical(pin: ContentPin): Promise<Buffer> {
    await this.prepare([pin]);
    if (this.rows.get(pin.sha256)?.location === 'recipe')
      return readNestedCheckoutNode(pin, async (ids, refresh) => {
        // Chunk nodes are read one by one, so each needs its own signature (never a run's).
        const missing = refresh
          ? ids
          : ids.filter(id => {
              const row = this.rows.get(id);
              return !row || (row.location === 'r2' && !row.url);
            });
        for (let at = 0; at < missing.length; at += 100)
          await this.describe(missing.slice(at, at + 100), false);
        return ids.map(id => this.rows.get(id)! as DownloadRow & { url?: string });
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
        const fd = await checkoutIo(async () => openSync(path, 'wx', 0o600)),
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
              await checkoutIo(async () => writeAll(fd, chunk.value));
              progressed();
            }
          invariant(
            size === pin.size && hash.digest('hex') === pin.sha256,
            'INVALID_NATIVE_SOURCE',
            'Downloaded source is truncated or corrupt.',
          );
          complete = true;
        } finally {
          await checkoutIo(async () => {
            closeSync(fd);
            if (!complete) unlinkSync(path);
          });
          await reader?.cancel().catch(() => undefined);
          reader?.releaseLock();
        }
      });
    const fd = await checkoutIo(async () => openSync(path, 'wx', 0o600));
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
        await checkoutIo(async () => writeAll(fd, bytes));
    } finally {
      await checkoutIo(async () => closeSync(fd));
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
      const read = await readCompleteRuns(files, this.rows);
      const rest = files.filter(file => !read.has(file.pin.sha256));
      // Large/recipe objects stream one at a time; small files have eight concurrent GETs.
      const small = rest.filter(file => file.pin.size <= 2 * 1024 * 1024);
      await mapExchange(small, 8, file => this.downloadToFile(file.pin, file.path), {
        bytes: 16 * 1024 * 1024,
        size: file => file.pin.size,
      });
      for (const file of rest)
        if (file.pin.size > 2 * 1024 * 1024) await this.downloadToFile(file.pin, file.path);
    } finally {
      // Keep only unused pins from the original metadata page, not signatures
      // for every file/chunk in the checkout. Source bytes remain on disk.
      for (const id of this.rows.keys()) if (consumed.has(id) || !before.has(id)) this.rows.delete(id);
      this.recipes.clear();
    }
  }
}
