// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import type { SourceWorkerReader } from './hosted-source-worker-reader.js';
class NeededObject extends Error {
  constructor(readonly id: string) {
    super('Fetch exact immutable merge input.');
  }
}
/** Retry the fixed synchronous native reducer only at a missing-object read.
 * Verified inputs and generated objects remain on private disk across retries. */
export class LazyMergeSource extends NativeSource {
  readonly generated = new Set<string>();
  readonly states = new Set<string>();
  override state(id: string) {
    const state = super.state(id);
    this.states.add(id);
    return state;
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
}

export async function lazyMerge<T>(
  reader: SourceWorkerReader,
  progress: () => Promise<void>,
  action: () => T,
): Promise<T> {
  for (;;) {
    try {
      return action();
    } catch (error) {
      if (!(error instanceof NeededObject)) throw error;
      await reader.resolve(error.id);
      await progress();
    }
  }
}
