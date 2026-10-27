// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { objectRecipeSchema, readObjectRecipe } from './object-chunks.js';
import { jobObject } from './hosted-source-job.js';
import { workerObjectSchema, type WorkerObject, type WorkerPin } from './hosted-source-worker-format.js';

/** Trusted transport resolves current job-scoped grants; repo bytes supply no URL.
 * upload consumes the stream completely and commits only the supplied exact pin. */
export interface SourceWorkerTransport {
  describe?(sha256: string): Promise<WorkerObject>;
  read(pin: WorkerPin): Promise<AsyncIterable<Uint8Array>>;
  upload(pin: WorkerPin, bytes: AsyncIterable<Uint8Array>): Promise<void>;
}
export class SourceWorkerReader {
  readonly metrics = {
    downloads: 0,
    downloadedBytes: 0,
    uploads: 0,
    uploadedBytes: 0,
    cacheHits: 0,
    maxChunkBytes: 0,
  };
  resolvedObjects = 0;
  async resolve(sha256: string) {
    invariant(
      this.transport.describe,
      'SOURCE_WORKER_UNAVAILABLE',
      'Compose needs the job-authorized object descriptor transport.',
    );
    const ref = workerObjectSchema.parse(await this.transport.describe(sha256));
    invariant(
      ref.object.sha256 === sha256,
      'SOURCE_HASH_MISMATCH',
      'Object descriptor selected different bytes.',
    );
    await this.file(ref);
    this.resolvedObjects++;
  }
  private readonly saved = new Map<string, WorkerPin>();
  constructor(
    readonly directory: string,
    private readonly transport: SourceWorkerTransport,
    private readonly progress: () => Promise<void> = async () => {},
  ) {}
  /** A job-private verified cache, never a persistent authorization cache. */
  async file(input: WorkerObject): Promise<string> {
    const pin = jobObject.parse(input.object),
      prior = this.saved.get(pin.sha256);
    if (prior) {
      invariant(prior.size === pin.size, 'SOURCE_HASH_MISMATCH', 'Object size changed.');
      this.metrics.cacheHits++;
      return join(this.directory, pin.sha256);
    }
    const path = join(this.directory, pin.sha256),
      temporary = join(this.directory, randomUUID());
    let bytes: AsyncIterable<Uint8Array>;
    if (input.recipe) {
      const recipe = objectRecipeSchema.parse(await this.json(input.recipe));
      invariant(
        recipe.object.sha256 === pin.sha256 && recipe.object.size === pin.size,
        'SOURCE_RECIPE_INVALID',
        'Recipe selects different logical content.',
      );
      bytes = readObjectRecipe(recipe, async ref => readFile(await this.file({ object: ref, recipe: null })));
    } else {
      bytes = await this.transport.read(pin);
      this.metrics.downloads++;
    }
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        size += chunk.length;
        this.metrics.maxChunkBytes = Math.max(this.metrics.maxChunkBytes, chunk.length);
        if (!input.recipe) this.metrics.downloadedBytes += chunk.length;
        if (size > pin.size)
          return done(new ForgeError('SOURCE_HASH_MISMATCH', 'Source exceeds its exact size.'));
        hash.update(chunk);
        void this.progress().then(
          () => done(null, chunk),
          error => done(error),
        );
      },
    });
    try {
      await pipeline(Readable.from(bytes), meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      invariant(
        size === pin.size && hash.digest('hex') === pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Source bytes differ from their exact hash and size.',
      );
      await rename(temporary, path);
      this.saved.set(pin.sha256, pin);
      return path;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async json(pin: WorkerPin): Promise<unknown> {
    invariant(pin.size <= 2 * 1024 * 1024, 'SOURCE_PAGE_INVALID', 'Source protocol metadata must be paged.');
    return JSON.parse(await readFile(await this.file({ object: pin, recipe: null }), 'utf8'));
  }
  async publish(bytes: Buffer): Promise<WorkerPin> {
    const pin = { sha256: digest(bytes), size: bytes.length };
    await this.transport.upload(pin, Readable.from([bytes]));
    this.metrics.uploads++;
    this.metrics.uploadedBytes += bytes.length;
    return pin;
  }
}
