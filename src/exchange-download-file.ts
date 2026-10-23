// SPDX-License-Identifier: Apache-2.0
import { openSync, closeSync, writeSync, fsyncSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mapExchange } from './exchange-parallel.js';
import { invariant } from './errors.js';
import type { ContentPin } from './native-exchange.js';
export const exchangeRangeBytes = 2 * 1024 * 1024;
/** Caller supplies an exclusive private staging path, never an existing owner file. */
export async function downloadExchangeFile(
  pin: ContentPin,
  path: string,
  read: (offset: number) => Promise<Buffer>,
) {
  const fd = openSync(path, 'wx', 0o600),
    hash = createHash('sha256');
  let written = 0,
    complete = false;
  try {
    for (let start = 0; start < pin.size || start === 0; start += 4 * exchangeRangeBytes) {
      const offsets = Array.from(
        { length: Math.max(1, Math.min(4, Math.ceil((pin.size - start) / exchangeRangeBytes))) },
        (_, index) => start + index * exchangeRangeBytes,
      );
      // Drain every started range before cleaning an incomplete destination.
      const parts = await mapExchange(offsets, 4, async offset => {
        const bytes = await read(offset);
        invariant(
          bytes.length === Math.min(exchangeRangeBytes, pin.size - offset),
          'INVALID_WORK_BACKUP',
          'Exchange response differs from the selected content range.',
        );
        return bytes;
      });
      for (const bytes of parts) {
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset);
          invariant(count > 0, 'EXCHANGE_DOWNLOAD_FAILED', 'Private content staging write was incomplete.');
          offset += count;
        }
        written += bytes.length;
      }
    }
    invariant(
      written === pin.size && hash.digest('hex') === pin.sha256,
      'INVALID_WORK_BACKUP',
      'Downloaded content differs from its digest.',
    );
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) unlinkSync(path);
  }
}
