// SPDX-License-Identifier: Apache-2.0
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import type { WorkerPin } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';

export async function readSourceExact(io: SourceWorkerTransport, pin: WorkerPin) {
  const bytes = new Uint8Array(pin.size);
  let offset = 0;
  for await (const part of await io.read(pin)) {
    invariant(offset + part.length <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source exceeds its exact size.');
    bytes.set(part, offset);
    offset += part.length;
  }
  invariant(
    offset === pin.size && digest(bytes) === pin.sha256,
    'SOURCE_HASH_MISMATCH',
    'Source bytes differ from their exact pin.',
  );
  return bytes;
}
