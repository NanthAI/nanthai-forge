// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
import { readR2Exact } from '../src/hosted-r2-retry';
import { packHeaders, verifyPackRange, type PackRange } from '../src/object-pack-range';

export type ExactGrant = { url: string; size: number; range?: PackRange };

/** One small exact-pinned object read (a source result manifest or a finish
 * selection page). Transient failures get the shared bounded retry; the exact
 * codes after it are unchanged: SOURCE_UNAVAILABLE for a failed download and
 * SOURCE_HASH_MISMATCH past the pinned size. Callers check the digest. */
export function readExactObject(
  grant: ExactGrant,
  messages: { failed: string; exceeds: string },
): Promise<Uint8Array> {
  return readR2Exact(
    () =>
      fetch(grant.url, {
        headers: { 'accept-encoding': 'identity', ...packHeaders(grant.range, grant.size) },
        signal: AbortSignal.timeout(10_000),
      }),
    async response => {
      invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', messages.failed);
      verifyPackRange(response, grant.range, grant.size);
      const reader = response.body.getReader(),
        parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          invariant(size <= grant.size, 'SOURCE_HASH_MISMATCH', messages.exceeds);
          parts.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return bytes;
    },
  );
}
