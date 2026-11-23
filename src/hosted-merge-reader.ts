// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NativeAncestry } from './native-ancestry.js';
import { NativeSource } from './native-source.js';
import type { SourceWorkerReader } from './hosted-source-worker-reader.js';

type MergeRoots = [left: string, right: string];
type AncestryScope = {
  roots: MergeRoots;
  boundary?: string | null;
  tips?: Map<string, ReturnType<NativeSource['state']>>;
};

export class NeededObject extends Error {
  state = false;
  constructor(
    readonly id: string,
    /** Every object of one known set that is missing, fetched in one window. */
    readonly ids: readonly string[] = [id],
  ) {
    super('Fetch exact immutable merge input.');
  }
}
/** Native calculation stays synchronous. Missing ancestry is read in parent
 * frontiers; missing merge bytes are grouped by differing paths, never all files. */
export class LazyMergeSource extends NativeSource {
  readonly generated = new Set<string>();
  readonly states = new Set<string>();
  private readonly verifiedParents: Record<string, string[]> = {};
  private ancestryScope: AncestryScope | undefined;
  private writtenState: { id: string; state: ReturnType<NativeSource['state']> } | undefined;

  withAncestry<T>(scope: AncestryScope, action: () => T): T {
    const previous = this.ancestryScope;
    this.ancestryScope = scope;
    try {
      return action();
    } finally {
      // Keep at most the two tip trees, and release them before any async hydration.
      delete scope.tips;
      this.ancestryScope = previous;
    }
  }

  override ancestry() {
    const scope = this.ancestryScope;
    if (!scope) return super.ancestry();
    return new NativeAncestry(id =>
      id === scope.boundary ? [] : (this.verifiedParents[id] ?? this.state(id).parents),
    );
  }

  override state(id: string) {
    const scope = this.ancestryScope,
      cached = id === this.writtenState?.id ? this.writtenState.state : scope?.tips?.get(id);
    if (cached) return cached;
    try {
      const state = super.state(id);
      this.states.add(id);
      this.verifiedParents[id] = state.parents;
      // Reuse the disk-verified State read back by writeState, for the next
      // merge or the final file listing. Retain at most one generated tree.
      if (this.generated.has(id)) this.writtenState = { id, state };
      if (scope?.roots.includes(id)) (scope.tips ??= new Map()).set(id, state);
      return state;
    } catch (error) {
      if (error instanceof NeededObject) error.state = true;
      throw error;
    }
  }
  override object(id: string): Buffer {
    if (!existsSync(join(this.directory, id))) throw new NeededObject(id);
    return super.object(id);
  }
  override prefetch(ids: readonly string[]) {
    const missing = [...new Set(ids)].filter(id => !existsSync(join(this.directory, id)));
    if (missing.length) throw new NeededObject(missing[0]!, missing);
  }
  override put(bytes: Buffer): string {
    const id = super.put(bytes);
    this.generated.add(id);
    return id;
  }
  /** States a merge of these heads will read, known without reading a manifest. The disk source
   * learns parents only from manifests, so it predicts none and reads lazily. */
  mergeBases(_left: string, _right: string): string[] {
    return [];
  }
  async fetchMissing(reader: SourceWorkerReader, error: NeededObject, scope?: AncestryScope) {
    if (error.state) {
      if (scope && scope.boundary === undefined) await this.prepareAncestry(reader, scope);
      // A cut settles ancestry alone. A base tree requested by the merge
      // still needs its original, verified manifest.
      else await reader.resolveMany(error.ids);
      return;
    }
    // An unchanged file has one blob across these exact States and needs no IO.
    // Only retain compact path/hash metadata; actual source streams to private disk.
    const first = new Map<string, string>(),
      different = new Set<string>();
    for (const id of this.states)
      for (const file of this.state(id).files) {
        const prior = first.get(file.path);
        if (prior && prior !== file.blob) different.add(file.path);
        else if (!prior) first.set(file.path, file.blob);
      }
    const needed = new Set([error.id, ...error.ids]);
    for (const id of this.states)
      for (const file of this.state(id).files)
        if (different.has(file.path) && !existsSync(join(this.directory, file.blob))) needed.add(file.blob);
    await reader.resolveMany([...needed]);
  }

  private async prepareAncestry(reader: SourceWorkerReader, scope: AncestryScope) {
    // Load the proof only when the whole worker actually prepares a merge.
    const { sourceAncestryCut } = await import('./hosted-source-ancestry-cut.js');
    const parents: Record<string, string[]> = {};
    let frontier = [...new Set(scope.roots)],
      expanded = 0,
      nextProof = 0,
      closed = false;
    let checkedSingleton = false;
    while (frontier.length) {
      // A single open leaf can close the graph immediately. For deep plural
      // frontiers, double the verified prefix between full proof scans so a
      // late (or absent) convergence does not make the walk quadratic.
      const singleton = !closed && frontier.length === 1 && !checkedSingleton;
      if (expanded <= 100 || expanded >= nextProof || singleton) {
        const boundary = sourceAncestryCut(parents, frontier, scope.roots);
        if (boundary) {
          scope.boundary = boundary;
          return;
        }
        if (expanded && singleton) checkedSingleton = true;
        nextProof = 2 * expanded;
      }
      // Advance one shallowest depth, using cached verified edges at that depth.
      await reader.resolveMany(
        frontier.filter(id => !this.verifiedParents[id] && !existsSync(join(this.directory, id))),
      );
      expanded += frontier.length;
      const next = new Set<string>();
      for (const id of frontier) {
        const edges = (parents[id] = this.verifiedParents[id] ?? this.state(id).parents);
        closed ||= !edges.length;
        for (const parent of edges) next.add(parent);
      }
      frontier = [...next].filter(id => !parents[id]);
    }
    scope.boundary = sourceAncestryCut(parents, [], scope.roots);
  }
}

export async function lazyMerge<T>(
  reader: SourceWorkerReader,
  progress: () => Promise<void>,
  action: () => T,
  source?: LazyMergeSource,
  roots?: MergeRoots,
): Promise<T> {
  const scope = roots ? { roots } : undefined;
  for (;;) {
    try {
      return source && scope ? source.withAncestry(scope, action) : action();
    } catch (error) {
      if (!(error instanceof NeededObject)) throw error;
      if (source) await source.fetchMissing(reader, error, scope);
      else await reader.resolve(error.id);
      await progress();
    }
  }
}
