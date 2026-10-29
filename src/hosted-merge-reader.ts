// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import type { SourceWorkerReader } from './hosted-source-worker-reader.js';
export class NeededObject extends Error {
  state = false;
  constructor(readonly id: string) {
    super('Fetch exact immutable merge input.');
  }
}
/** Native calculation stays synchronous. Missing ancestry is read in parent
 * frontiers; missing merge bytes are grouped by differing paths, never all files. */
export class LazyMergeSource extends NativeSource {
  readonly generated = new Set<string>();
  readonly states = new Set<string>();
  private readonly expanded = new Set<string>();
  override state(id: string) {
    try {
      const state = super.state(id);
      this.states.add(id);
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
  override put(bytes: Buffer): string {
    const id = super.put(bytes);
    this.generated.add(id);
    return id;
  }
  async fetchMissing(reader: SourceWorkerReader, error: NeededObject) {
    if (error.state) {
      let frontier = [...this.states, error.id].filter(id => !this.expanded.has(id));
      while (frontier.length) {
        await reader.resolveMany(frontier.filter(id => !existsSync(join(this.directory, id))));
        const next = new Set<string>();
        for (const id of frontier) {
          this.expanded.add(id);
          for (const parent of this.state(id).parents) if (!this.expanded.has(parent)) next.add(parent);
        }
        frontier = [...next];
      }
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
    const needed = new Set([error.id]);
    for (const id of this.states)
      for (const file of this.state(id).files)
        if (different.has(file.path) && !existsSync(join(this.directory, file.blob))) needed.add(file.blob);
    await reader.resolveMany([...needed]);
  }
}

export async function lazyMerge<T>(
  reader: SourceWorkerReader,
  progress: () => Promise<void>,
  action: () => T,
  source?: LazyMergeSource,
): Promise<T> {
  for (;;) {
    try {
      return action();
    } catch (error) {
      if (!(error instanceof NeededObject)) throw error;
      if (source) await source.fetchMissing(reader, error);
      else await reader.resolve(error.id);
      await progress();
    }
  }
}
