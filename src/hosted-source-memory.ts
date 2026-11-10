// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { LazyMergeSource, NeededObject } from './hosted-merge-reader.js';
import { parseNativeState, type NativeFile, type NativeState } from './native-state-format.js';
import { SourceWorkerReader, type SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { readObjectRecipe, objectRecipeSchema } from './object-chunks.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { WorkerObject, WorkerPin } from './hosted-source-worker-format.js';
import { sourceValidation } from './hosted-source-validation.js';
import { mapSourceOrdered } from './hosted-source-parallel.js';
import { manifestFromTree, writeOutputTree } from './state-tree-output.js';

/** Parents are compact, verified metadata. A file tree is loaded only when the
 * native merge actually requests it, rather than for every ancestor visited. */
export class MemoryMergeSource extends LazyMergeSource {
  readonly objects = new Map<string, Buffer>();
  /** Merge reader (trees): the first State with a tree pointer this calculation holds; other
   * States are rebuilt from their trees as differences from it. Parsed on first use. */
  treeBase?: { state: string; bytes: Buffer; files?: readonly NativeFile[] };
  private readonly parsed = new Map<string, NativeState>();
  private cutList: string[] | undefined;
  private cutIds = new Set<string>();
  constructor(
    readonly parents: Record<string, string[]>,
    public ancestryBoundary?: string,
    public ancestryCuts?: string[],
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
    if (this.cutList !== this.ancestryCuts) {
      this.cutList = this.ancestryCuts;
      this.cutIds = new Set(this.ancestryCuts);
    }
    const parents = id === this.ancestryBoundary || this.cutIds.has(id) ? [] : this.parents[id];
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
  /** A State's flat file list when this calculation already parsed it; never a read. */
  heldFiles(id: string) {
    const bytes = this.parsed.has(id) ? undefined : this.objects.get(id);
    return this.parsed.get(id)?.files ?? (bytes && parseNativeState(bytes).files);
  }
  override async fetchMissing(reader: SourceWorkerReader, error: NeededObject) {
    await reader.resolveMany([error.id]);
  }
  /** Parents this source already knows, as `state` would return them; undefined needs a read. */
  private knownParents(id: string): string[] | undefined {
    if (this.cutList !== this.ancestryCuts) {
      this.cutList = this.ancestryCuts;
      this.cutIds = new Set(this.ancestryCuts);
    }
    if (id === this.ancestryBoundary || this.cutIds.has(id)) return [];
    return this.parents[id] ?? this.parsed.get(id)?.parents;
  }
  /** The merge bases the native merge selects (the common ancestors that are no other common
   * ancestor's parent), found from known parents only, so their manifests can be read in the same
   * wave as the heads instead of one miss round each. Empty when one head contains the other (no
   * base is read) or an edge is unknown (the merge then reads lazily as before). */
  override mergeBases(left: string, right: string, limit = 8): string[] {
    const ancestors = (head: string) => {
      const seen = new Set<string>(),
        pending = [head];
      while (pending.length) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        const parents = this.knownParents(id);
        if (!parents) return null;
        seen.add(id);
        pending.push(...parents);
      }
      return seen;
    };
    const a = ancestors(left),
      b = a && ancestors(right);
    if (!a || !b || a.has(right) || b.has(left)) return [];
    const common = [...a].filter(id => b.has(id)),
      parents = new Set(common.flatMap(id => this.knownParents(id)!));
    return common
      .filter(id => !parents.has(id))
      .sort()
      .slice(0, limit);
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
    const trees = this.io.trees,
      base = this.source.treeBase;
    if (trees?.read && base && !ref.recipe) {
      base.files ??= parseNativeState(base.bytes).files;
      const rebuilt = await manifestFromTree(trees, ref.object.sha256, {
        state: base.state,
        files: base.files,
      });
      if (rebuilt && rebuilt.length === ref.object.size) {
        const derived = Buffer.from(rebuilt.buffer, rebuilt.byteOffset, rebuilt.length);
        this.source.objects.set(ref.object.sha256, derived);
        return derived;
      }
    }
    let bytes: Buffer;
    if (ref.recipe) {
      invariant(
        ref.recipe.size <= 2 * 1024 * 1024,
        'SOURCE_PAGE_INVALID',
        'Source metadata exceeds its encoding bound.',
      );
      const raw = await this.bytes({ object: ref.recipe, recipe: null });
      const recipe = sourceValidation('SOURCE_RECIPE_INVALID', () =>
        objectRecipeSchema.parse(JSON.parse(raw.toString('utf8'))),
      );
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
    if (trees?.read && !this.source.treeBase && trees.pointer(ref.object.sha256))
      this.source.treeBase = { state: ref.object.sha256, bytes };
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
      // Merge reader: the first State with a tree pointer is read flat and becomes the base the
      // others in this window are rebuilt from, so it must be in hand before they start.
      const trees = this.io.trees;
      if (trees?.read && !this.source.treeBase) {
        const first = window.find(ref => !ref.recipe && trees.pointer(ref.object.sha256));
        if (first) await this.bytes(first);
      }
      // Every byte of this window is retained either way; only the round trips overlap.
      await mapSourceOrdered(window, ref => this.bytes(ref));
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
    // Dual-write (tree form) each State of this window before its upload records it, in order: a
    // later State may build on an earlier one's pointer.
    const trees = this.io.trees;
    if (trees)
      for (const value of bytes) {
        if (!value.subarray(0, 256).includes('"kind":"forge-source-state"')) continue;
        await writeOutputTree(trees, value, {
          files: id => this.source.heldFiles(id),
          bytes: async files => {
            // Held bytes first, then the project's own key for a raw object (no descriptor call;
            // it also reaches a blob this job wrote that no row names yet), then descriptors.
            const direct = await mapSourceOrdered(
              files,
              async file =>
                this.source.objects.get(file.blob) ?? (await trees.direct?.({ sha256: file.blob })),
            );
            const rest = files.filter((_, i) => !direct[i]);
            if (rest.length) await this.resolveMany(rest.map(file => file.blob));
            return files.map((file, i) => direct[i] ?? this.source.objects.get(file.blob)!);
          },
        });
      }
    const pins = await super.publishMany(bytes);
    for (let i = 0; i < pins.length; i++) this.source.objects.set(pins[i]!.sha256, bytes[i]!);
    return pins;
  }
}
