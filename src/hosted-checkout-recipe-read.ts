// SPDX-License-Identifier: Apache-2.0
import { ObjectDownloadReader } from './blob-download.js';
import { exchangeFetch } from './exchange-request.js';
import { invariant } from './errors.js';
import type { DownloadRow } from './blob-download-format.js';
import type { ContentPin } from './native-exchange.js';
type Row = DownloadRow & { url?: string };
/** Existing storage permits a bounded recipe node to itself use a recipe.
 * Resolve that representation with the existing ancestry/hash-verified reader;
 * the enclosing checkout still reauthorizes before installing any source. */
export async function readNestedCheckoutNode(
  pin: ContentPin,
  metadata: (ids: string[], refresh?: boolean) => Promise<Row[]>,
) {
  const signed = new Set<string>();
  const reader = new ObjectDownloadReader({
    describe: ids => metadata(ids),
    sign: async ids => {
      const rows = await metadata(
        ids,
        ids.some(id => signed.has(id)),
      );
      for (const id of ids) signed.add(id);
      return rows.map(row => {
        invariant(row.location === 'r2' && row.url, 'INVALID_NATIVE_SOURCE', 'Select signed source content.');
        return { digest: row.digest, size: row.size, url: row.url };
      });
    },
    fetch: (url, init) => exchangeFetch('Checkout recipe download', url, init),
  });
  return Buffer.from((await reader.read([pin]))[0]!);
}
