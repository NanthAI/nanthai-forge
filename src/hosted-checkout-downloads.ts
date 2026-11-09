// SPDX-License-Identifier: Apache-2.0
import { checkoutIo } from './checkout-io.js';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
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
    recipe: z.object({
      digest: z.string(),
      size: z.number().safe().nonnegative(),
      url: z.url().optional(),
      range: z
        .object({ offset: z.number().safe().nonnegative(), total: z.number().safe().positive() })
        .optional(),
    }),
  }),
]);
type Row = DownloadRow & { url?: string | undefined; run?: PackRunBinding | undefined };
/** Older servers reject the `runs` argument; they keep the 100-pin, per-object pages. */
const olderServer = (error: unknown) => /extra field `?runs/.test(String((error as Error)?.message));
/** One finite checkout transfer. Metadata and signatures travel together in <=100-pin
 * pages; bytes never pass through a Convex function. The caller reauthorizes before
 * installing files. This memory holds locations only, never a project's file bytes. */
export class HostedCheckoutDownloads implements CheckoutObjectTransport {
  /** Page rows (`objects`), shared by every window until their file is downloaded. */
  private readonly rows = new Map<string, Row>();
  /** Each download window's own signatures, recipes and index pages (dropped with the window),
   * so overlapping windows never remove or replace one another's. */
  private readonly window = new AsyncLocalStorage<Window>();
  private runs = true;
  private pages = 0;
  /** Every written file's size and digest is checked here (stream hash, run hash, recipe identity). */
  readonly verifiesDownloads = true;
  /** Two windows at once; each keeps its own state in `window`. */
  readonly downloadWindows = 2;
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
      verifiesDownloads: this.verifiesDownloads,
      downloadWindows: this.downloadWindows,
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
        // Signing writes nothing: pages described ahead need not wait in the SDK's mutation queue.
        { skipQueue: true },
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
      const rows = this.window.getStore()?.rows ?? this.rows;
      if (row.location === 'recipe') {
        // A signed recipe object comes with its logical row: reading it needs no describe.
        const { url, range, ...recipe } = row.recipe;
        rows.set(row.digest, { ...row, recipe });
        if (url && !rows.get(recipe.digest)?.url)
          rows.set(recipe.digest, { ...recipe, location: 'r2', url, ...(range ? { range } : {}) });
      } else rows.set(row.digest, run ? { ...rest, run: { ...run, key: `${page}:${run.id}` } } : rest);
    }
    return rows.map(row => ({ sha256: row.digest, size: row.size }));
  }
  async objects(digests: string[]): Promise<ContentPin[]> {
    return this.window.exit(() => this.describePages(digests));
  }
  /** This window's row for `digest`, else the shared page row. */
  private row(digest: string): Row | undefined {
    return this.window.getStore()?.rows.get(digest) ?? this.rows.get(digest);
  }
  private async describePages(digests: string[]): Promise<ContentPin[]> {
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
    return runGroups(pins, digest => this.row(digest));
  }
  /** `single`: these pins are read one by one (recipe nodes and chunks), so each needs its own
   * signature in one page call, never a run binding that is then re-signed per object. */
  private async prepare(pins: ContentPin[], single = false) {
    const need = (pin: ContentPin) => {
      const row = this.row(pin.sha256);
      return !row || (single && row.location === 'r2' && !row.url);
    };
    const missing = [...new Map(pins.filter(need).map(pin => [pin.sha256, pin])).values()].map(
      pin => pin.sha256,
    );
    if (single)
      for (let at = 0; at < missing.length; at += 100)
        await this.describe(missing.slice(at, at + 100), false);
    else if (missing.length) await this.describePages(missing);
    for (const pin of pins)
      invariant(
        this.row(pin.sha256)?.size === pin.size,
        'INVALID_NATIVE_SOURCE',
        'Source location differs from selected size.',
      );
  }
  private async read<T>(
    pin: ContentPin,
    consume: (response: Response, progressed: () => void) => Promise<T>,
  ): Promise<T> {
    await this.prepare([pin]);
    let row = this.row(pin.sha256)!;
    invariant(row.location !== 'recipe', 'INVALID_NATIVE_SOURCE', 'Recipe nodes must be physical objects.');
    // A run member read on its own (outside its run) needs its own exact signature.
    if (!row.url) {
      await this.describe([pin.sha256], false);
      row = this.row(pin.sha256)!;
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
      row = this.row(pin.sha256)!;
      invariant(
        row.size === pin.size && row.location === 'r2' && !!row.url,
        'INVALID_NATIVE_SOURCE',
        'Source location changed.',
      );
    }
  }
  private async physical(pin: ContentPin): Promise<Buffer> {
    await this.prepare([pin]);
    if (this.row(pin.sha256)?.location === 'recipe')
      return readNestedCheckoutNode(pin, async (ids, refresh) => {
        // Chunk nodes are read one by one, so each needs its own signature (never a run's).
        const missing = refresh
          ? ids
          : ids.filter(id => {
              const row = this.row(id);
              return !row || (row.location === 'r2' && !row.url);
            });
        for (let at = 0; at < missing.length; at += 100)
          await this.describe(missing.slice(at, at + 100), false);
        return ids.map(id => this.row(id)! as DownloadRow & { url?: string });
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
  async downloadToFile(pin: ContentPin, path: string): Promise<void> {
    if (!this.window.getStore()) return this.window.run(newWindow(), () => this.downloadToFile(pin, path));
    await this.prepare([pin]);
    const row = this.row(pin.sha256)!;
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
        this.state().recipes.get(pin.sha256) ??
        objectRecipeSchema.parse(JSON.parse((await this.physical(recipePin)).toString('utf8')));
      invariant(
        recipe.object.sha256 === pin.sha256 && recipe.object.size === pin.size,
        'INVALID_NATIVE_SOURCE',
        'Recipe differs from selected logical source.',
      );
      // The next nodes are read while this one is written: at most 8 ahead and 4 MiB held.
      const ahead = new Map<string, { bytes: number; read: Promise<Buffer> }>();
      const read = (item: ContentPin) => {
        const known = this.state().indexPages.get(item.sha256) ?? null;
        if (known) return Promise.resolve(known);
        const started = ahead.get(item.sha256);
        ahead.delete(item.sha256);
        return started?.read ?? this.physical(item);
      };
      for await (const bytes of readObjectRecipe(recipe, read, async items => {
        await this.prepare(items, true);
        let held = [...ahead.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        for (const item of items.slice(1, 9)) {
          if (ahead.has(item.sha256) || this.state().indexPages.has(item.sha256)) continue;
          if (held + item.size > 4 * 1024 * 1024) break;
          const started = this.physical(item);
          started.catch(() => undefined);
          ahead.set(item.sha256, { bytes: item.size, read: started });
          held += item.size;
        }
      }))
        await checkoutIo(async () => writeAll(fd, bytes));
    } finally {
      await checkoutIo(async () => closeSync(fd));
    }
  }
  private async prepareRecipes(pins: ContentPin[]) {
    const logical = pins.filter(pin => this.row(pin.sha256)?.location === 'recipe');
    const recipePin = (pin: ContentPin) => {
      const row = this.row(pin.sha256)!;
      invariant(row.location === 'recipe', 'INVALID_NATIVE_SOURCE', 'Select recipe content.');
      return { sha256: row.recipe.digest, size: row.recipe.size };
    };
    await this.prepare(logical.map(recipePin), true);
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
      this.state().recipes.set(pin.sha256, recipe);
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
      await this.prepare(refs, true);
      const pages = await mapExchange(
        refs.filter(ref => ref.height > 0),
        4,
        async ref => {
          const bytes = await this.physical(ref);
          this.state().indexPages.set(ref.sha256, bytes);
          const page = objectChunkPageSchema.parse(JSON.parse(bytes.toString('utf8')));
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
    const own = newWindow();
    try {
      await this.window.run(own, async () => {
        // The recipe walk (one describe and GET per tree level) runs while this window's pack runs
        // and small plain files download, instead of before them (fea47345 round 3).
        const logical = (file: { pin: ContentPin }) => this.row(file.pin.sha256)?.location === 'recipe';
        const walk = this.prepareRecipes(files.map(file => file.pin));
        walk.catch(() => undefined);
        const plain = async () => {
          const read = await readCompleteRuns(
            files.filter(file => !logical(file)),
            new Map([...this.rows, ...own.rows]),
          );
          // Small files have eight concurrent GETs.
          const small = files.filter(
            file => !logical(file) && !read.has(file.pin.sha256) && file.pin.size <= 2 * 1024 * 1024,
          );
          await mapExchange(small, 8, file => this.downloadToFile(file.pin, file.path), {
            bytes: 16 * 1024 * 1024,
            size: file => file.pin.size,
          });
          return read;
        };
        const [walked, readPlain] = await Promise.allSettled([walk, plain()]);
        if (walked.status === 'rejected') throw walked.reason;
        if (readPlain.status === 'rejected') throw readPlain.reason;
        const read = readPlain.value;
        // Large/recipe objects stream to disk, four at a time (each holds at most 4 MiB of
        // read-ahead, so about 16 MiB in all).
        await mapExchange(
          files.filter(
            file => logical(file) || (!read.has(file.pin.sha256) && file.pin.size > 2 * 1024 * 1024),
          ),
          4,
          file => this.downloadToFile(file.pin, file.path),
        );
      });
    } finally {
      // Keep only unused page rows (including pages described ahead), not signatures for every
      // file/chunk in the checkout: this window's own state goes with it. Source bytes stay on disk.
      for (const file of files) {
        const row = this.rows.get(file.pin.sha256);
        if (row?.location === 'recipe') this.rows.delete(row.recipe.digest);
        this.rows.delete(file.pin.sha256);
      }
    }
  }
  private state() {
    const own = this.window.getStore();
    invariant(own, 'INVALID_NATIVE_SOURCE', 'Checkout downloads run inside a window.');
    return own;
  }
}
type Window = { rows: Map<string, Row>; recipes: Map<string, ObjectRecipe>; indexPages: Map<string, Buffer> };
const newWindow = (): Window => ({ rows: new Map(), recipes: new Map(), indexPages: new Map() });
