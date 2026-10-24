// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildExchangeRoot } from './native-exchange-tree.js';
import { invariant } from './errors.js';
import { digest } from './hash.js';
const location = z.union([
  z
    .object({
      size: z.number().safe().nonnegative(),
      path: z.enum(['work.json', 'manifest.json']),
      offset: z.number().safe().nonnegative(),
    })
    .strict(),
  z.object({ size: z.number().safe().nonnegative(), inline: z.string() }).strict(),
]);
const indexSchema = z
  .object({
    schema: z.literal(1),
    rootSha256: z.string(),
    locations: z.record(z.string().regex(/^[0-9a-f]{64}$/), location),
  })
  .strict();
export function preparedMetadata(directory: string, manifest: Buffer) {
  const rootPath = join(directory, 'exchange.json');
  if (!existsSync(rootPath)) return undefined;
  const bytes = readFileSync(rootPath),
    indexPath = join(directory, 'exchange-index.json');
  // Transitional prepared operations retain their original encoding. They can
  // still reconcile; newly prepared operations always pin the compact index.
  const value = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8'))
    : buildExchangeRoot(manifest, readFileSync(join(directory, 'work.json'))).index;
  const index = indexSchema.parse(value);
  invariant(
    index.rootSha256 === digest(bytes),
    'WORK_OPERATION_CHANGED',
    'Original metadata tree index differs from its root.',
  );
  return {
    bytes,
    pins: Object.entries(index.locations).map(([sha256, item]) => ({
      path: `metadata/${sha256}`,
      sha256,
      size: item.size,
    })),
    read(sha256: string) {
      const entry = index.locations[sha256];
      if (!entry) return undefined;
      if ('inline' in entry) return Buffer.from(entry.inline, 'base64');
      const fd = openSync(join(directory, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(fd);
        invariant(
          info.isFile() && info.nlink === 1 && entry.offset + entry.size <= info.size,
          'EXCHANGE_SOURCE_CHANGED',
          'Pinned metadata range is unavailable.',
        );
        const content = Buffer.alloc(entry.size);
        let offset = 0;
        while (offset < entry.size) {
          const count = readSync(fd, content, offset, entry.size - offset, entry.offset + offset);
          invariant(count > 0, 'EXCHANGE_SOURCE_CHANGED', 'Pinned metadata range is incomplete.');
          offset += count;
        }
        return content;
      } finally {
        closeSync(fd);
      }
    },
  };
}
