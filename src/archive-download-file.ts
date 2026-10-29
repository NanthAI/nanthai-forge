// SPDX-License-Identifier: Apache-2.0
import { openSync, closeSync, writeSync, fsyncSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { downloadExchangeFile } from './exchange-download-file.js';
import { exchangeRequest } from './exchange-request.js';
import { invariant } from './errors.js';
import type { ContentPin } from './native-exchange.js';
export type ArchivePart = { data: ArrayBuffer; digest: string; size: number; direct?: boolean; url?: string };
/** One signing call, a streaming direct GET and an exact whole-archive hash.
 * The compatibility path keeps bounded parallel Convex ranges for old rows. */
export async function downloadArchiveFile(
  pin: ContentPin,
  path: string,
  read: (offset: number) => Promise<ArchivePart>,
) {
  const first = await read(0);
  const check = (part: ArchivePart) =>
    invariant(
      part.digest === pin.sha256 && part.size === pin.size,
      'INVALID_WORK_BACKUP',
      'Downloaded archive differs from the selected checkpoint.',
    );
  check(first);
  if (!first.direct)
    return downloadExchangeFile(pin, path, async offset => {
      const part = offset === 0 ? first : await read(offset);
      check(part);
      return Buffer.from(part.data);
    });
  invariant(first.url, 'INVALID_WORK_BACKUP', 'Direct archive destination is unavailable.');
  await exchangeRequest(
    'direct archive download',
    first.url,
    { headers: { 'accept-encoding': 'identity' } },
    async (response, progressed) => {
      invariant(response.ok && response.body, 'INVALID_WORK_BACKUP', 'Stored archive is unavailable.');
      const fd = openSync(path, 'wx', 0o600),
        reader = response.body.getReader(),
        hash = createHash('sha256');
      let size = 0,
        complete = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          progressed();
          size += chunk.value.length;
          invariant(size <= pin.size, 'INVALID_WORK_BACKUP', 'Archive exceeds its exact size.');
          hash.update(chunk.value);
          let at = 0;
          while (at < chunk.value.length) {
            const count = writeSync(fd, chunk.value, at);
            invariant(count > 0, 'EXCHANGE_DOWNLOAD_FAILED', 'Archive staging write was incomplete.');
            at += count;
          }
        }
        invariant(
          size === pin.size && hash.digest('hex') === pin.sha256,
          'INVALID_WORK_BACKUP',
          'Downloaded archive differs from its digest.',
        );
        fsyncSync(fd);
        complete = true;
      } finally {
        closeSync(fd);
        if (!complete) unlinkSync(path);
        await reader.cancel().catch(() => undefined);
      }
    },
  );
}
