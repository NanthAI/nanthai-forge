// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import type { HostedAgentExchange } from './hosted-agent-transport.js';
import type { ConvexExchange } from './exchange-client.js';
import type { NativeSource } from './native-source.js';

/** Source identity stays independent of physical storage (current R2 keys). */
export interface ObjectStore {
  get(id: string): Promise<Buffer>;
  put(bytes: Buffer): Promise<string>;
}

/** Verified, disposable local bytes; selection/access is rechecked by callers.
 * Coalesce concurrent gets so a cold tree uses bounded batched R2 reads. */
export class HostedObjectStore implements ObjectStore {
  private readonly cache: HostedCheckoutCache;
  private pending = new Map<
    string,
    { resolve: (bytes: Buffer) => void; reject: (error: unknown) => void }[]
  >();
  private scheduled = false;
  constructor(
    directory: string,
    private readonly exchange: HostedAgentExchange,
  ) {
    this.cache = new HostedCheckoutCache(directory, new ConvexLaneTransport(exchange));
  }
  get(id: string): Promise<Buffer> {
    invariant(/^[0-9a-f]{64}$/.test(id), 'INVALID_NATIVE_SOURCE', 'Select an object digest.');
    return new Promise((resolve, reject) => {
      const waiting = this.pending.get(id) ?? [];
      waiting.push({ resolve, reject });
      this.pending.set(id, waiting);
      if (!this.scheduled) {
        this.scheduled = true;
        void Promise.resolve().then(() => this.flush());
      }
    });
  }
  private async flush() {
    const pending = this.pending;
    this.pending = new Map();
    this.scheduled = false;
    try {
      await this.cache.ensure([...pending.keys()]);
      for (const [id, waiting] of pending) {
        const bytes = readFileSync(join(this.cache.objects, id));
        invariant(digest(bytes) === id, 'SOURCE_HASH_MISMATCH', 'Cached object differs from its pin.');
        for (const item of waiting) item.resolve(bytes);
      }
    } catch (error) {
      for (const waiting of pending.values()) for (const item of waiting) item.reject(error);
    }
  }
  async put(bytes: Buffer) {
    return hostedObjectWriter(this.exchange).put(bytes);
  }
}

/** Only source records and their files are needed to materialise a saved head;
 * historical ancestry remains hosted and is fetched when selected. */
export async function cacheHostedState(source: NativeSource, objects: ObjectStore, head: string) {
  invariant(
    source.put(await objects.get(head)) === head,
    'SOURCE_HASH_MISMATCH',
    'State differs from its pin.',
  );
  const state = source.state(head);
  await Promise.all(
    [...new Set(state.files.map(file => file.blob))].map(async id => {
      invariant(
        source.put(await objects.get(id)) === id,
        'SOURCE_HASH_MISMATCH',
        'Blob differs from its pin.',
      );
    }),
  );
  return state;
}

/** The upload transport already performs missing-only R2 presign and commit.
 * Retain its bounded/file-backed blob path; small save records use put(bytes). */
export function hostedObjectWriter(exchange: Pick<ConvexExchange, 'upload'>): Pick<ObjectStore, 'put'> {
  return {
    async put(bytes) {
      const id = digest(bytes);
      await exchange.upload({ sha256: id, size: bytes.length }, bytes);
      return id;
    },
  };
}
