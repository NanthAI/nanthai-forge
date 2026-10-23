// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';

/** Control envelopes are small paged metadata, never source bytes. Bound the
 * actual streamed body before parsing; Content-Length is not trusted. */
export async function readSourceControlReply(response: Response): Promise<unknown> {
  invariant(response.body, 'SOURCE_WORKER_UNAVAILABLE', 'Missing source control reply.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      invariant(size <= 128 * 1024, 'SOURCE_PAGE_INVALID', 'Source control envelopes must be paged.');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
