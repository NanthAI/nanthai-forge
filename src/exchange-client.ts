import { pendingProgressGuard } from './long-action.js';
import { CUTOVER_CLI_VERSION } from './cutover-version.js';
// SPDX-License-Identifier: Apache-2.0
import {
  METADATA_PUBLICATION,
  publicationPages,
  publicationHash,
  type PublicationMetadata,
} from './publication-metadata.js';
import { cachedExchangeMetadata, retainExchangeMetadata } from './exchange-receive-cache.js';
import { ExchangeDownloadCache } from './exchange-download-cache.js';
import { SignedDownloadCache, type SignedObject } from './exchange-r2-read.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { hostedMainSchema, type MainExpectation } from './hosted-main.js';
import { exchangeConvexFetch } from './exchange-convex-fetch.js';
import { retryExchange } from './exchange-retry.js';
import type { SourceReturnProgress } from './source-return-progress.js';
import { hostedActionError } from './hosted-action-error.js';
import { resolveAuthToken } from './auth-store.js';
import { ConvexHttpClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { ContentPin, ExchangeTransport } from './native-exchange.js';
import { mapExchange } from './exchange-parallel.js';
import { uploadPhysicalObjects } from './exchange-upload.js';
import { ConvexExchangeBlobs } from './exchange-blobs.js';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';
import { buildObjectRecipe, ObjectRecipeBuilder } from './object-chunks.js';
import { SourceFileReader } from './source-file-reader.js';
import { downloadExchangeFile } from './exchange-download-file.js';
import { resolveExchangeRoot, isExchangeRoot } from './native-exchange-tree.js';
const query = (name: string) => makeFunctionReference<'query'>(name);
const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
const action = (name: string) => makeFunctionReference<'action'>(name);
const chunked = (pin: ContentPin) => {
  const path = (pin as ContentPin & { path?: string }).path;
  return (
    pin.size > 2 * 1024 * 1024 &&
    path !== 'manifest.json' &&
    path !== 'work.json' &&
    !path?.startsWith('metadata/')
  );
};
export class ConvexExchange implements ExchangeTransport {
  readonly metadataTrees = true;
  authorityEpoch: number | undefined;
  metadataCacheDirectory?: string;
  private readonly downloadCache = new ExchangeDownloadCache();
  private readonly signedDownloads = new WeakMap<ConvexHttpClient, SignedDownloadCache>();
  readonly workRecords = true;
  onCall?: (name: string, pending: boolean) => void;
  onWorkProgress?: (done: number, total: number) => void;
  onDownloadProgress?: (pin: ContentPin, done: number) => void;
  onReturnProgress?: (progress: SourceReturnProgress) => void;
  uploadBatchSize?: number;
  readonly client: ConvexHttpClient;
  /** Byte transport; built on the current client so a replaced client is honored. */
  private get blobs() {
    let cache = this.signedDownloads.get(this.client);
    if (!cache) this.signedDownloads.set(this.client, (cache = new SignedDownloadCache()));
    return new ConvexExchangeBlobs(
      this.client,
      cache,
      (pin, done) => this.onDownloadProgress?.(pin, done),
      (name, pending) => this.onCall?.(name, pending),
    );
  }
  /** Digests just found not to be R2 objects, so a large-object read need not ask again. */
  private readonly unsigned = new Set<string>();
  private readonly logicalMetadata = new Map<string, { bytes: Buffer; backupId: string }>();
  constructor(
    url: string,
    token: string | undefined,
    readonly projectId: string,
    readonly operationId: string,
    readonly previous: string | null,
    public deferHistory = false,
    public proposalId?: string,
  ) {
    token = resolveAuthToken(url, token);
    invariant(
      token,
      'AUTH_REQUIRED',
      'Run nforge login or set FORGE_AUTH_TOKEN to your current Forge sign-in token.',
    );
    this.client = new ConvexHttpClient(url, {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: exchangeConvexFetch({}, (name, pending) => this.onCall?.(name, pending)),
    });
    this.client.setAuth(token);
  }
  async current(expected?: MainExpectation) {
    // Authority discovery selects the source API; server main never falls back
    // to the uploaded owner's historical generation.
    const value = await this.client.query(query('projectHostedAgent:capabilities'), {
      projectId: this.projectId,
      clientVersion: CUTOVER_CLI_VERSION,
    });
    const discovery = typeof value === 'string' ? JSON.parse(value) : value;
    const authority = sourceAuthoritySchema.parse(discovery.authority);
    const server = authority.mode === 'server';
    const selected = await this.client.query(
      query(server ? 'projectHostedChannels:current' : 'projectMain:current'),
      {
        projectId: this.projectId,
        ...(server ? {} : { maxSchema: 2, ...(expected ? { expected } : {}) }),
      },
    );
    const main = hostedMainSchema.parse(typeof selected === 'string' ? JSON.parse(selected) : selected);
    invariant(
      !server ||
        (main.schema === 2 && main.authority.mode === 'server' && main.authority.epoch === authority.epoch),
      'SOURCE_AUTHORITY_CHANGED',
      'Hosted main and discovered authority differ.',
    );
    invariant(main.projectId === this.projectId, 'PROJECT_UNAVAILABLE', 'Select this hosted project.');
    invariant(
      !expected || (expected.head === main.head && expected.receiptId === main.receipt.id),
      'CHANNEL_CHANGED',
      'Hosted main changed from the expected head and receipt.',
    );
    return main;
  }
  async objects(digests: string[]): Promise<ContentPin[]> {
    return this.client.query(query('projectMain:objects'), { projectId: this.projectId, digests });
  }
  checkpointKey(backupId = this.previous ?? undefined) {
    return backupId ? JSON.stringify([this.client.url, this.projectId, backupId]) : undefined;
  }
  async missing(pins: ContentPin[]): Promise<string[]> {
    return this.client.query(query('projectObjects:missing'), {
      projectId: this.projectId,
      objects: pins.map(pin => ({ digest: pin.sha256, size: pin.size })),
    });
  }
  async upload(pin: ContentPin, bytes: Buffer) {
    return this.uploadBatch([{ pin, bytes }]);
  }
  async uploadBatch(objects: { pin: ContentPin; bytes: Buffer }[]) {
    // Small objects keep the existing raw representation. Large logical IDs stay
    // unchanged; only their missing immutable regions are transferred.
    if (objects.every(object => !chunked(object.pin))) return this.uploadRawBatch(objects);
    let uploadedObjects = 0,
      uploadedBytes = 0,
      uploadedLogicalObjects = 0;
    for (const object of objects) {
      const receipt = chunked(object.pin)
        ? await this.uploadChunked(object.pin, object.bytes)
        : await this.uploadRawBatch([object]);
      uploadedObjects += receipt.uploadedObjects;
      uploadedBytes += receipt.uploadedBytes;
      uploadedLogicalObjects += receipt.uploadedLogicalObjects ?? receipt.uploadedObjects;
    }
    return { uploadedObjects, uploadedBytes, uploadedLogicalObjects };
  }
  async uploadLazyBatch(
    objects: { pin: ContentPin; read: () => Buffer | Promise<Buffer> }[],
    options: { batchSize?: number; onRaw?: (sha256: string) => void } = {},
  ) {
    if (objects.every(object => !chunked(object.pin)))
      return this.uploadPhysical(objects, options.batchSize, options.onRaw);
    let uploadedObjects = 0,
      uploadedBytes = 0,
      uploadedLogicalObjects = 0;
    for (const object of objects) {
      const sent = chunked(object.pin)
        ? await this.uploadChunked(object.pin, await object.read())
        : await this.uploadPhysical([object], options.batchSize, options.onRaw);
      uploadedObjects += sent.uploadedObjects;
      uploadedBytes += sent.uploadedBytes;
      uploadedLogicalObjects += (
        'uploadedLogicalObjects' in sent ? sent.uploadedLogicalObjects : sent.uploadedObjects
      ) as number;
    }
    return { uploadedObjects, uploadedBytes, uploadedLogicalObjects };
  }
  async uploadFile(pin: ContentPin, root: string, path: string) {
    const reader = new SourceFileReader(root, path);
    try {
      invariant(
        reader.size === pin.size,
        'EXCHANGE_SOURCE_CHANGED',
        'Large source differs from its original size.',
      );
      const content = new Map<string, { pin: ContentPin; read: () => Buffer }>();
      const builder = new ObjectRecipeBuilder((bytes, offset) => {
        const value = { sha256: digest(bytes), size: bytes.length };
        if (offset === null) {
          const retained = Buffer.from(bytes);
          content.set(value.sha256, { pin: value, read: () => retained });
        } else
          content.set(value.sha256, {
            pin: value,
            read: () => reader.read(offset, value.size, value.sha256),
          });
        return value;
      });
      const observed = reader.scan(bytes => builder.update(bytes), pin.sha256);
      const built = builder.finish(observed);
      return await this.uploadRecipe(pin, built.bytes, [...content.values()]);
    } finally {
      reader.close();
    }
  }
  private async uploadChunked(pin: ContentPin, bytes: Buffer) {
    const built = buildObjectRecipe(bytes);
    invariant(
      built.recipe.object.size === pin.size && built.recipe.object.sha256 === pin.sha256,
      'EXCHANGE_SOURCE_CHANGED',
      'Large content differs from its original logical pin.',
    );
    return this.uploadRecipe(
      pin,
      built.bytes,
      [...built.objects].map(([sha256, bytes]) => ({
        pin: { sha256, size: bytes.length },
        read: () => bytes,
      })),
    );
  }
  private async uploadRecipe(
    pin: ContentPin,
    recipe: Buffer,
    content: { pin: ContentPin; read: () => Buffer }[],
  ) {
    const recipePin = { sha256: digest(recipe), size: recipe.length };
    content.push({ pin: recipePin, read: () => recipe });
    const pages: (typeof content)[] = [];
    for (let offset = 0; offset < content.length; offset += 100)
      pages.push(content.slice(offset, offset + 100));
    const missing = await mapExchange(
      pages,
      4,
      async page => new Set(await this.missing(page.map(item => item.pin))),
    );
    const pending = pages.flatMap((page, index) => page.filter(item => missing[index]!.has(item.pin.sha256)));
    const { uploadedObjects, uploadedBytes } = await this.uploadPhysical(pending);
    await this.client.action(action('projectObjectRecipes:complete'), {
      projectId: this.projectId,
      digest: pin.sha256,
      size: pin.size,
      recipeDigest: recipePin.sha256,
      recipeSize: recipePin.size,
    });
    return { uploadedObjects, uploadedBytes, uploadedLogicalObjects: uploadedObjects ? 1 : 0 };
  }
  private uploadPhysical(
    objects: { pin: ContentPin; read: () => Buffer | Promise<Buffer> }[],
    batchSize = this.uploadBatchSize,
    onRaw?: (sha256: string) => void,
  ) {
    return uploadPhysicalObjects(this.client, this.projectId, objects, {
      blobs: this.blobs,
      ...(batchSize ? { batchSize } : {}),
      ...(onRaw ? { onRaw } : {}),
    });
  }
  private async uploadRawBatch(
    objects: { pin: ContentPin; bytes: Buffer }[],
  ): Promise<{ uploadedObjects: number; uploadedBytes: number; uploadedLogicalObjects?: number }> {
    return this.uploadPhysical(objects.map(({ pin, bytes }) => ({ pin, read: () => bytes })));
  }

  async published(pin: ContentPin): Promise<string | null> {
    return retryExchange('publication receipt', this.operationId, () =>
      this.client.action(action('projectExchangeActions:published'), {
        ...(this.authorityEpoch === undefined ? {} : { authorityEpoch: this.authorityEpoch }),
        projectId: this.projectId,
        operationId: this.operationId,
        previous: this.previous,
        ...(this.deferHistory ? { deferHistory: true } : {}),
        digest: pin.sha256,
        size: pin.size,
      }),
    );
  }
  async publishMetadata(
    pin: ContentPin,
    build: () => PublicationMetadata,
    ownerDerived?: ContentPin,
  ): Promise<string | null> {
    if (this.proposalId || this.deferHistory) return null;
    const capability = await retryExchange('publication capabilities', this.operationId, async () => {
      try {
        return await this.client.query(query('projectPublicationStore:capabilities'), {
          projectId: this.projectId,
        });
      } catch (error) {
        // An older deployment has no capability endpoint. Other failures stay
        // explicit and must never silently select another publication route.
        if (
          error instanceof Error &&
          error.message.includes('projectPublicationStore:capabilities') &&
          /Could not find public function|Function .* is unavailable/.test(error.message)
        )
          return null;
        throw error;
      }
    });
    if (capability !== METADATA_PUBLICATION) return null;
    const payload = build(),
      { pages, digest: metadataDigest } = publicationPages(payload),
      request = publicationHash(
        JSON.stringify([
          this.projectId,
          this.operationId,
          this.previous,
          pin.sha256,
          pin.size,
          ...(this.authorityEpoch ? ['authority-epoch', this.authorityEpoch] : []),
        ]),
      );
    let cursor: { id: string; cursor: number; chain: string } = await retryExchange(
      'publication begin',
      this.operationId,
      () =>
        this.client.mutation(mutation('projectPublicationStore:begin'), {
          projectId: this.projectId,
          operationId: this.operationId,
          request,
          digest: pin.sha256,
          size: pin.size,
          metadataDigest,
          pages: pages.length,
        }),
    );
    while (cursor.cursor < pages.length) {
      const args = {
        id: cursor.id,
        position: cursor.cursor,
        previous: cursor.chain,
        body: pages[cursor.cursor]!,
      };
      cursor = await retryExchange('publication page', this.operationId, () =>
        this.client.mutation(mutation('projectPublicationStore:append'), args),
      );
    }
    return this.publish(pin, true, ownerDerived);
  }
  async publishedOwnerDerived(backupId: string): Promise<ContentPin | null> {
    return retryExchange('published owner display pin', this.operationId, () =>
      this.client.query(query('projectPublicationStore:publishedDisplay'), {
        projectId: this.projectId,
        backupId,
      }),
    );
  }
  async ownerDisplayBaseline(): Promise<boolean> {
    return retryExchange('owner display baseline', this.operationId, () =>
      this.client.query(query('projectPublicationStore:displayBaseline'), { projectId: this.projectId }),
    );
  }
  async publish(pin: ContentPin, metadataOnly = false, ownerDerived?: ContentPin): Promise<string> {
    try {
      return await retryExchange(
        'checkpoint publication',
        this.operationId,
        () =>
          this.client.action(action('projectExchangeActions:publish'), {
            ...(this.authorityEpoch === undefined ? {} : { authorityEpoch: this.authorityEpoch }),
            displayProtocol: 3,
            ...(ownerDerived ? { ownerDerived } : {}),
            projectId: this.projectId,
            operationId: this.operationId,
            previous: this.previous,
            ...(this.deferHistory ? { deferHistory: true } : {}),
            ...(metadataOnly ? { metadataOnly: 1 } : {}),
            digest: pin.sha256,
            size: pin.size,
          }),
        { retries: 1, retryCodes: ['EXCHANGE_REQUEST_FAILED', 'EXCHANGE_REQUEST_TIMEOUT'] },
      );
    } catch (error) {
      const data =
        error instanceof ConvexError && error.data && typeof error.data === 'object' ? error.data : null;
      if (
        (data as { code?: unknown } | null)?.code === 'PROJECT_CHANGED' ||
        (error instanceof ForgeError && error.code === 'PROJECT_CHANGED')
      )
        throw new ForgeError(
          'PROJECT_CHANGED',
          'Another push changed this project since your previous checkpoint, so nothing was published. Pull the latest checkpoint, reconcile your changes, then push again.',
        );
      if (
        error instanceof ForgeError &&
        ['HOSTED_ACTION_FAILED', 'EXCHANGE_REQUEST_FAILED', 'EXCHANGE_REQUEST_TIMEOUT'].includes(error.code)
      )
        throw new ForgeError('WORK_PUBLICATION_FAILED', error.message);
      throw error;
    }
  }
  async manifest(
    backupId: string,
  ): Promise<{ json: string; digest: string; size: number; sourceDigest?: string }> {
    const original = this.proposalId
      ? await this.client.action(action('projectProposalObjects:checkpoint'), { proposalId: this.proposalId })
      : await this.client.action(action('projectExchangeActions:checkpoint'), { backupId });
    const bytes = Buffer.from(original.json);
    invariant(
      bytes.length === original.size && digest(bytes) === original.digest,
      'INVALID_WORK_BACKUP',
      'Checkpoint root differs from its selected digest.',
    );
    const cached = this.metadataCacheDirectory
      ? cachedExchangeMetadata(this.metadataCacheDirectory, bytes)
      : undefined;
    if (cached) {
      this.logicalMetadata.set(digest(cached.work), { bytes: cached.work, backupId });
      return {
        json: cached.manifest.toString('utf8'),
        digest: digest(cached.manifest),
        size: cached.manifest.length,
        sourceDigest: original.sourceDigest ?? original.digest,
      };
    }
    if (!isExchangeRoot(JSON.parse(original.json))) return original;
    const resolved = await resolveExchangeRoot(bytes, pins => this.downloadBatch(pins), {
      onWorkProgress: this.onWorkProgress,
    });
    if (this.metadataCacheDirectory)
      retainExchangeMetadata(this.metadataCacheDirectory, bytes, resolved.manifest, resolved.work);
    this.logicalMetadata.set(digest(resolved.work), { bytes: resolved.work, backupId });
    return {
      json: resolved.manifest.toString('utf8'),
      digest: digest(resolved.manifest),
      size: resolved.manifest.length,
      sourceDigest: original.sourceDigest ?? original.digest,
    };
  }
  async downloadBatch(pins: ContentPin[]): Promise<Buffer[]> {
    const cached = pins.map(pin => this.downloadCache.get(pin));
    const hits = pins.filter((_, index) => cached[index]);
    const missing = pins.filter((_, index) => !cached[index]);
    const fetched = missing.length ? await this.fetchBatch(missing) : [];
    fetched.forEach((bytes, index) => {
      if (!this.logicalMetadata.has(missing[index]!.sha256)) this.downloadCache.put(missing[index]!, bytes);
    });
    if (hits.length) {
      const current = await this.objects(hits.map(pin => pin.sha256));
      invariant(
        current.length === hits.length &&
          current.every((pin, i) => pin.sha256 === hits[i]!.sha256 && pin.size === hits[i]!.size),
        'INVALID_WORK_BACKUP',
        'Cached content differs from current project bindings.',
      );
    }
    let offset = 0;
    return cached.map(bytes => bytes ?? fetched[offset++]!);
  }
  private async fetchBatch(all: ContentPin[]): Promise<Buffer[]> {
    // Committed R2 objects come straight from R2; everything else uses the Convex paths below.
    const direct = all.some(pin => this.logicalMetadata.has(pin.sha256))
      ? new Map<string, Buffer>()
      : await this.blobs.getSigned(this.projectId, all);
    const pins = all.filter(pin => !direct.has(pin.sha256));
    for (const pin of pins) if (pin.size > 2 * 1024 * 1024) this.unsigned.add(pin.sha256);
    const rest = pins.length ? await this.fetchConvexBatch(pins) : [];
    let next = 0;
    return all.map(pin => direct.get(pin.sha256) ?? rest[next++]!);
  }
  private async fetchConvexBatch(pins: ContentPin[]): Promise<Buffer[]> {
    if (pins.some(pin => this.logicalMetadata.has(pin.sha256)))
      return mapExchange(pins, 4, pin => this.download(pin), {
        bytes: 16 * 1024 * 1024,
        size: pin => pin.size,
      });
    const groups: ContentPin[][] = [];
    for (const pin of pins) {
      const last = groups.at(-1);
      if (last && last.length < 8 && last.reduce((sum, p) => sum + p.size, 0) + pin.size <= 2 * 1024 * 1024)
        last.push(pin);
      else groups.push([pin]);
    }
    const results = await mapExchange(
      groups,
      4,
      async group => {
        if (group[0]!.size > 2 * 1024 * 1024) return [await this.download(group[0]!)];
        const rows = await this.blobs.getGroup(this.projectId, group);
        invariant(
          rows.length === group.length,
          'INVALID_WORK_BACKUP',
          'Exchange download omitted requested content.',
        );
        return rows.map((row, index) => {
          const pin = group[index]!,
            bytes = Buffer.from(row.data);
          invariant(
            row.digest === pin.sha256 &&
              row.size === pin.size &&
              bytes.length === pin.size &&
              digest(bytes) === pin.sha256,
            'INVALID_WORK_BACKUP',
            'Exchange content differs from the selected digest.',
          );
          return bytes;
        });
      },
      { bytes: 16 * 1024 * 1024, size: group => group.reduce((sum, pin) => sum + pin.size, 0) },
    );
    return results.flat();
  }
  async download(pin: ContentPin): Promise<Buffer> {
    // Logical metadata has checkpoint-specific authority below, rather than an object binding.
    if (!this.logicalMetadata.has(pin.sha256)) {
      const cached = this.downloadCache.get(pin);
      if (cached) {
        const [current] = await this.objects([pin.sha256]);
        invariant(
          current?.sha256 === pin.sha256 && current.size === pin.size,
          'INVALID_WORK_BACKUP',
          'Cached content differs from current project bindings.',
        );
        return cached;
      }
    }
    const bytes = await this.fetchDownload(pin);
    if (!this.logicalMetadata.has(pin.sha256)) this.downloadCache.put(pin, bytes);
    return bytes;
  }
  private async fetchDownload(pin: ContentPin) {
    const logical = this.logicalMetadata.get(pin.sha256);
    if (logical) {
      await this.client.action(
        action(this.proposalId ? 'projectProposalObjects:checkpoint' : 'projectExchangeActions:checkpoint'),
        this.proposalId ? { proposalId: this.proposalId } : { backupId: logical.backupId },
      );
      invariant(
        logical.bytes.length === pin.size && digest(logical.bytes) === pin.sha256,
        'INVALID_WORK_BACKUP',
        'Logical metadata differs from selected bytes.',
      );
      return Buffer.from(logical.bytes);
    }
    if (!this.unsigned.delete(pin.sha256)) {
      const direct = (await this.blobs.getSigned(this.projectId, [pin])).get(pin.sha256);
      if (direct) return direct;
    }
    const chunkBytes = 2 * 1024 * 1024,
      offsets = Array.from(
        { length: Math.max(1, Math.ceil(pin.size / chunkBytes)) },
        (_, index) => index * chunkBytes,
      );
    let done = 0;
    const parts = await mapExchange(offsets, 4, async offset => {
      const part = await this.blobs.getPart(this.projectId, pin, offset);
      const bytes = Buffer.from(part.data),
        expected = Math.min(chunkBytes, pin.size - offset);
      invariant(
        part.digest === pin.sha256 && part.size === pin.size && bytes.length === expected,
        'INVALID_WORK_BACKUP',
        'Exchange response differs from the selected content range.',
      );
      done += bytes.length;
      this.onDownloadProgress?.(pin, done);
      return bytes;
    });
    const bytes = Buffer.concat(parts);
    invariant(
      digest(bytes) === pin.sha256,
      'INVALID_WORK_BACKUP',
      'Downloaded content differs from its digest.',
    );
    return bytes;
  }
  /** Prepare bounded signature windows without loading the selected object bytes. */
  async prepareDownloads(pins: ContentPin[]) {
    let cache = this.signedDownloads.get(this.client);
    if (!cache) this.signedDownloads.set(this.client, (cache = new SignedDownloadCache()));
    const missing = pins.filter(pin => !cache.get(this.projectId, pin));
    for (let at = 0; at < missing.length; at += 100) {
      const page = missing.slice(at, at + 100),
        wanted = new Map(page.map(pin => [pin.sha256, pin]));
      const signed: SignedObject[] = await this.client.mutation(
        mutation('projectObjectDownloads:signDownloads'),
        {
          projectId: this.projectId,
          digests: page.map(pin => pin.sha256),
        },
      );
      for (const object of signed) {
        invariant(
          wanted.get(object.digest)?.size === object.size,
          'INVALID_WORK_BACKUP',
          'Object storage listing differs from the selected content.',
        );
        cache.put(this.projectId, object);
        this.unsigned.delete(object.digest);
        wanted.delete(object.digest);
      }
      for (const id of wanted.keys()) this.unsigned.add(id);
    }
  }
  async downloadToFile(pin: ContentPin, path: string): Promise<void> {
    const logical = this.logicalMetadata.get(pin.sha256);
    if (logical)
      await this.client.action(
        action(this.proposalId ? 'projectProposalObjects:checkpoint' : 'projectExchangeActions:checkpoint'),
        this.proposalId ? { proposalId: this.proposalId } : { backupId: logical.backupId },
      );
    const direct = logical
      ? undefined
      : this.downloadCache.get(pin)
        ? await this.download(pin)
        : this.unsigned.delete(pin.sha256)
          ? undefined
          : (await this.blobs.getSigned(this.projectId, [pin])).get(pin.sha256);
    await downloadExchangeFile(pin, path, async offset => {
      if (direct) return direct.subarray(offset, Math.min(offset + 2 * 1024 * 1024, direct.length));
      if (logical)
        return logical.bytes.subarray(offset, Math.min(offset + 2 * 1024 * 1024, logical.bytes.length));
      const part = await this.blobs.getPart(this.projectId, pin, offset);
      invariant(
        part.digest === pin.sha256 && part.size === pin.size,
        'INVALID_WORK_BACKUP',
        'Exchange response differs from the selected content.',
      );
      return Buffer.from(part.data);
    });
  }
  async registerLogs(backupId: string, hasLogs: boolean) {
    if (!hasLogs) return;
    await this.client.action(action('projectCheckLogRetentionActions:registerBackup'), {
      projectId: this.projectId,
      backupId,
      hasLogs,
    });
  }
  async migrate(
    backupId: string,
    operationId: string,
    originalDigest: string,
    manifest: ContentPin,
  ): Promise<unknown> {
    return this.client.action(action('projectExchangeMigration:migrate'), {
      backupId,
      operationId,
      originalDigest,
      manifestDigest: manifest.sha256,
      manifestSize: manifest.size,
    });
  }
  async journalPage(afterRevision?: number, snapshot?: string): Promise<unknown> {
    try {
      const json = await this.client.query(query('projectWorkJournal:page'), {
        projectId: this.projectId,
        ...(afterRevision === undefined ? {} : { afterRevision }),
        ...(snapshot === undefined ? {} : { snapshot }),
      });
      return JSON.parse(json);
    } catch (error) {
      if (
        error instanceof Error &&
        /Could not find public function.*projectWorkJournal:page/.test(error.message)
      )
        throw new ForgeError('JOURNAL_PAGING_UNAVAILABLE', 'Hosted journal paging is not deployed.');
      throw hostedActionError(error, 'journal page');
    }
  }
  async journal(): Promise<string> {
    return retryExchange('Work journal read', this.operationId, () =>
      this.client.action(action('projectWorkActions:exportJournal'), { projectId: this.projectId }),
    );
  }
  async returnSource(
    backupId: string,
    expectedBackupId: string,
    revision: number,
    operationId: string,
    ownerDerived?: ContentPin,
  ) {
    let active = true,
      probing = false;
    const started = Date.now();
    const probe = this.onReturnProgress
      ? setInterval(() => {
          if (probing) return;
          probing = true;
          void this.client
            .action(action('projectSourceReturn:returnSource'), {
              projectId: this.projectId,
              backupId,
              expectedBackupId,
              revision,
              operationId,
              continuation: true,
              statusOnly: true,
              ...(ownerDerived ? { ownerDerived } : {}),
            })
            .then(result => {
              if (active && result?.pending && result.progress)
                this.onReturnProgress?.({
                  ...JSON.parse(result.progress),
                  elapsedMs: Date.now() - started,
                  resumed: false,
                });
            })
            .catch(() => {
              // A progress probe is advisory; the original action reports its result/error.
            })
            .finally(() => {
              probing = false;
            });
        }, 30000)
      : undefined;
    try {
      let first = true;
      const guard = pendingProgressGuard('source return', operationId);
      while (true) {
        const statusProbe = first && !!this.onReturnProgress;
        const result = await retryExchange('source return', operationId, () =>
          this.client.action(action('projectSourceReturn:returnSource'), {
            projectId: this.projectId,
            backupId,
            expectedBackupId,
            revision,
            operationId,
            continuation: true,
            ...(ownerDerived ? { ownerDerived } : {}),
            ...(first && this.onReturnProgress ? { statusOnly: true } : {}),
          }),
        );
        if (!(result && typeof result === 'object' && 'pending' in result && result.pending === true)) {
          const accounting =
            result && typeof result === 'object' && 'accounting' in result ? result.accounting : undefined;
          this.onReturnProgress?.({
            phase: 'complete',
            step: 0,
            done: 1,
            total: 1,
            elapsedMs: Date.now() - started,
            etaSeconds: 0,
            resumed: false,
            ...(accounting && typeof accounting === 'object' ? accounting : {}),
          });
          return result;
        }
        // The initial status probe does no work and cannot count as a stalled continuation.
        if (!(first && this.onReturnProgress)) guard(result.progress);
        if (result.progress)
          this.onReturnProgress?.({
            ...JSON.parse(result.progress),
            resumed: first && result.resumed === true,
          });
        first = false;
        if (!statusProbe) await new Promise<void>(resolve => setImmediate(resolve));
      }
    } catch (error) {
      throw hostedActionError(error, 'source return');
    } finally {
      active = false;
      clearInterval(probe);
    }
  }
}
