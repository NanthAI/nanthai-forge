// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import type { WorkerPin } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';

/** Raw bytes one action already read, so a later calculation round in the same action (a text
 * merge, then the conflict markers of the same three inputs) costs no second R2 read. Only bytes
 * that matched their exact pin are kept, and every reader still verifies what it is given. The
 * cache lives for one action and holds at most `limit` bytes; beyond that reads pass through. */
export function cachedReads<T extends Pick<SourceWorkerTransport, 'read'>>(
  io: T,
  cache: { bytes: Map<string, Buffer>; held: number },
  limit: number,
): T {
  const delegated = io as Pick<SourceWorkerTransport, 'readInto' | 'rememberBytes'>;
  return {
    ...io,
    ...(delegated.readInto
      ? {
          readInto: async (pin: WorkerPin, destination: Uint8Array) => {
            const prior = cache.bytes.get(pin.sha256);
            if (prior && prior.length === pin.size) {
              destination.set(prior);
              return true;
            }
            return delegated.readInto!(pin, destination);
          },
        }
      : {}),
    rememberBytes: (pin: WorkerPin, bytes: Uint8Array) => {
      delegated.rememberBytes?.(pin, bytes);
      // This hook is called only after the whole-object hash check. It also keeps
      // destination reads in the same action cache as ordinary streams.
      if (!cache.bytes.has(pin.sha256) && cache.held + pin.size <= limit && bytes.length === pin.size) {
        cache.bytes.set(pin.sha256, Buffer.from(bytes));
        cache.held += pin.size;
      }
    },
    read: async (pin: WorkerPin) => {
      const prior = cache.bytes.get(pin.sha256);
      if (prior && prior.length === pin.size)
        return (async function* () {
          yield prior;
        })();
      const stream = await io.read(pin);
      if (cache.held + pin.size > limit) return stream;
      return (async function* () {
        const parts: Buffer[] = [];
        for await (const part of stream) {
          parts.push(Buffer.from(part));
          yield part;
        }
        const bytes = Buffer.concat(parts);
        if (
          bytes.length === pin.size &&
          cache.held + bytes.length <= limit &&
          !cache.bytes.has(pin.sha256) &&
          digest(bytes) === pin.sha256
        ) {
          cache.bytes.set(pin.sha256, bytes);
          cache.held += bytes.length;
        }
      })();
    },
  };
}
