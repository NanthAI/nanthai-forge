// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { LazyMergeSource, NeededObject } from './hosted-merge-reader.js';
import { parseNativeState, type NativeState } from './native-state-format.js';
import { SourceWorkerReader, type SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { readObjectRecipe, objectRecipeSchema } from './object-chunks.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { WorkerObject, WorkerPin } from './hosted-source-worker-format.js';

/** Parents are compact, verified metadata. A file tree is loaded only when the
 * native merge actually requests it, rather than for every ancestor visited. */
export class MemoryMergeSource extends LazyMergeSource {
  readonly objects = new Map<string, Buffer>();
  private readonly parsed = new Map<string, NativeState>();
  constructor(
    readonly parents: Record<string, string[]>,
    public ancestryBoundary?: string,
  ) {
    super(null);
  }
  override object(id: string): Buffer {
    const bytes = this.objects.get(id);
    if (!bytes) throw new NeededObject(id);
    return bytes;
  }
  override put(bytes: Buffer) {
    const id = digest(bytes);
    this.objects.set(id, bytes);
    this.generated.add(id);
    return id;
  }
  override state(id: string): NativeState {
    // This is an explicit proven graph cut, not a claim about stored parents.
    // File bytes still come from the exact original hash-verified State.
    const parents = id === this.ancestryBoundary ? [] : this.parents[id];
    if (!parents) return this.fullState(id);
    const fullFiles = () => this.fullState(id).files;
    return {
      schema: 1,
      kind: 'forge-source-state',
      parents,
      message: '',
      at: '',
      get files() {
        return fullFiles();
      },
    };
  }
  private fullState(id: string) {
    let value = this.parsed.get(id);
    if (!value) {
      value = parseNativeState(this.object(id));
      this.parsed.set(id, value);
      this.parents[id] = value.parents;
      this.states.add(id);
    }
    return value;
  }
  override async fetchMissing(reader: SourceWorkerReader, error: NeededObject) {
    if (this.parents[error.id]) {
      await reader.resolveMany([error.id]);
      return;
    }
    await reader.resolveMany([error.id]);
  }
}

/** No filesystem, checkout, import or repository execution. The cache belongs
 * to one bounded calculation and is discarded when its action returns. */
export class MemorySourceReader extends SourceWorkerReader {
  constructor(
    readonly source: MemoryMergeSource,
    private readonly io: SourceWorkerTransport,
  ) {
    super('', io);
  }
  override async bytes(ref: WorkerObject): Promise<Buffer> {
    const prior = this.source.objects.get(ref.object.sha256);
    if (prior) {
      invariant(prior.length === ref.object.size, 'SOURCE_HASH_MISMATCH', 'Object size changed.');
      this.metrics.cacheHits++;
      return prior;
    }
    let bytes: Buffer;
    if (ref.recipe) {
      const recipe = objectRecipeSchema.parse(await this.json(ref.recipe));
      invariant(
        recipe.object.sha256 === ref.object.sha256 && recipe.object.size === ref.object.size,
        'SOURCE_RECIPE_INVALID',
        'Recipe selects different logical content.',
      );
      const parts: Buffer[] = [];
      for await (const chunk of readObjectRecipe(recipe, pin => this.bytes({ object: pin, recipe: null })))
        parts.push(chunk);
      bytes = Buffer.concat(parts);
    } else {
      const hash = createHash('sha256'),
        parts: Buffer[] = [];
      let length = 0;
      for await (const part of await this.io.read(ref.object)) {
        length += part.length;
        invariant(length <= ref.object.size, 'SOURCE_HASH_MISMATCH', 'Source exceeds its exact size.');
        hash.update(part);
        parts.push(Buffer.from(part));
        this.metrics.maxChunkBytes = Math.max(this.metrics.maxChunkBytes, part.length);
      }
      invariant(
        length === ref.object.size && hash.digest('hex') === ref.object.sha256,
        'SOURCE_HASH_MISMATCH',
        'Source bytes differ from their exact hash and size.',
      );
      bytes = Buffer.concat(parts);
      this.metrics.downloads++;
      this.metrics.downloadedBytes += length;
    }
    this.source.objects.set(ref.object.sha256, bytes);
    return bytes;
  }
  override async file(ref: WorkerObject) {
    await this.bytes(ref);
    return '';
  }
  override async files(refs: WorkerObject[]) {
    for (let offset = 0; offset < refs.length; offset += 100) {
      const window = refs.slice(offset, offset + 100);
      await this.io.prepareRead?.(window.filter(ref => !ref.recipe).map(ref => ref.object));
      for (const ref of window) await this.bytes(ref);
    }
  }
  override async resolveMany(ids: readonly string[]) {
    const pending = [...new Set(ids)].filter(id => !this.source.objects.has(id));
    for (let offset = 0; offset < pending.length; offset += 100) {
      const group = pending.slice(offset, offset + 100);
      invariant(
        this.io.describeBatch,
        'SOURCE_WORKER_UNAVAILABLE',
        'Resolve exact source metadata in batches.',
      );
      const refs = await this.io.describeBatch(group);
      invariant(
        refs.length === group.length && refs.every((ref, i) => ref.object.sha256 === group[i]),
        'SOURCE_HASH_MISMATCH',
        'Source descriptors changed order or identity.',
      );
      await this.files(refs);
      this.resolvedObjects += refs.length;
    }
  }
  override async publishMany(bytes: Buffer[]): Promise<WorkerPin[]> {
    const pins = await super.publishMany(bytes);
    for (let i = 0; i < pins.length; i++) this.source.objects.set(pins[i]!.sha256, bytes[i]!);
    return pins;
  }
}
