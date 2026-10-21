// SPDX-License-Identifier: Apache-2.0
import { verifiedBytes } from './verified-blob.js';
import { invariant } from './errors.js';
import {
  downloadPageSchema,
  downloadRecipeSchema,
  type DownloadPin,
  type DownloadRow,
  type DownloadTree,
  type SignedDownload,
} from './blob-download-format.js';
export type DownloadTransport = {
  describe(digests: string[]): Promise<DownloadRow[]>;
  sign(digests: string[]): Promise<SignedDownload[]>;
  fetch?: typeof fetch;
  now?: () => number;
};
/** One reader per client/project. Bytes are immutable; authority is checked afresh even on hits.
 * No timer, background refresh, URL persistence or idle work. The byte cache expires lazily. */
export class ObjectDownloadReader {
  private readonly cache = new Map<string, { bytes: Uint8Array; until: number }>();
  private retained = 0;
  private readonly budget = 16 * 1024 * 1024;
  constructor(private readonly transport: DownloadTransport) {}
  private now() {
    return (this.transport.now ?? Date.now)();
  }
  private remember(pin: DownloadPin, bytes: Uint8Array) {
    if (bytes.length > this.budget) return;
    for (const [key, value] of this.cache)
      if (value.until <= this.now() || this.retained + bytes.length > this.budget) {
        this.cache.delete(key);
        this.retained -= value.bytes.length;
      }
    const previous = this.cache.get(pin.sha256);
    if (previous) this.retained -= previous.bytes.length;
    this.cache.set(pin.sha256, { bytes: bytes.slice(), until: this.now() + 60_000 });
    this.retained += bytes.length;
  }
  private async rows(pins: DownloadPin[]) {
    const result = new Map<string, DownloadRow>();
    for (let at = 0; at < pins.length; at += 100) {
      const page = pins.slice(at, at + 100);
      for (const row of await this.transport.describe(page.map(pin => pin.sha256)))
        result.set(row.digest, row);
      for (const pin of page)
        invariant(
          result.get(pin.sha256)?.size === pin.size,
          'INVALID_WORK_BACKUP',
          'Stored content differs from the selected project binding.',
        );
    }
    return result;
  }
  private async signatures(pins: DownloadPin[]) {
    const result = new Map<string, SignedDownload>();
    for (let at = 0; at < pins.length; at += 100) {
      const page = pins.slice(at, at + 100);
      for (const row of await this.transport.sign(page.map(pin => pin.sha256))) result.set(row.digest, row);
      for (const pin of page)
        invariant(
          result.get(pin.sha256)?.size === pin.size,
          'EXCHANGE_DOWNLOAD_DENIED',
          'Object storage no longer permits this content to be read.',
        );
    }
    return result;
  }
  private async get(row: DownloadRow, signed?: SignedDownload, ranged = false) {
    invariant(row.location !== 'recipe', 'INVALID_WORK_BACKUP', 'Resolve the recipe before reading bytes.');
    let url = row.location === 'r2' ? signed!.url : row.url;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await (this.transport.fetch ?? fetch)(url, {
          ...(ranged && row.size ? { headers: { Range: `bytes=0-${row.size - 1}` } } : {}),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
      } catch {
        // R2's expired responses can omit CORS headers, appearing as a network error.
        invariant(
          row.location === 'r2' && attempt === 0,
          'R2_READ_FAILED',
          'Stored content download failed.',
        );
        url = (await this.signatures([{ sha256: row.digest, size: row.size }])).get(row.digest)!.url;
        continue;
      }
      if (row.location === 'r2' && response.status === 403 && attempt === 0) {
        await response.body?.cancel();
        url = (await this.signatures([{ sha256: row.digest, size: row.size }])).get(row.digest)!.url;
        continue;
      }
      invariant(
        response.ok,
        response.status === 403 ? 'EXCHANGE_DOWNLOAD_DENIED' : 'R2_READ_FAILED',
        `Stored content download failed (HTTP ${response.status}).`,
      );
      if (response.status === 206)
        invariant(
          response.headers.get('content-range') === `bytes 0-${row.size - 1}/${row.size}`,
          'INVALID_WORK_BACKUP',
          'Stored content returned different byte offsets.',
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      invariant(
        bytes.length === row.size,
        'BLOB_DIGEST_MISMATCH',
        'Downloaded content has a different size.',
      );
      return verifiedBytes(bytes, row.digest);
    }
    throw new Error('Unreachable download retry.');
  }
  async read(
    pins: DownloadPin[],
    ranged = false,
    ancestors: ReadonlySet<string> = new Set(),
  ): Promise<Uint8Array[]> {
    const unique = new Map(pins.map(pin => [pin.sha256, pin]));
    if (unique.size !== pins.length) {
      invariant(
        pins.every(pin => unique.get(pin.sha256)!.size === pin.size),
        'INVALID_WORK_BACKUP',
        'Repeated content identities have different sizes.',
      );
      const values = await this.read([...unique.values()], ranged, ancestors);
      const found = new Map([...unique.keys()].map((id, index) => [id, values[index]!]));
      return pins.map(pin => found.get(pin.sha256)!.slice());
    }
    const rows = await this.rows(pins);
    // Select hits once. Signing another object can cross a cache expiry boundary;
    // an already-authorized immutable hit must not fall through to an unsigned GET.
    const hits = new Map<string, Uint8Array>();
    for (const pin of pins) {
      const hit = this.cache.get(pin.sha256);
      if (hit && hit.until > this.now()) hits.set(pin.sha256, hit.bytes);
    }
    const direct = pins.filter(pin => rows.get(pin.sha256)!.location === 'r2' && !hits.has(pin.sha256));
    const signed = await this.signatures([...new Map(direct.map(pin => [pin.sha256, pin])).values()]);
    const result: Uint8Array[] = [];
    // Eight concurrent GETs per batch; arbitrary selections continue through every batch.
    for (let at = 0; at < pins.length; at += 8)
      result.push(
        ...(await Promise.all(
          pins.slice(at, at + 8).map(async pin => {
            const hit = hits.get(pin.sha256);
            if (hit) return hit.slice();
            invariant(!ancestors.has(pin.sha256), 'INVALID_WORK_BACKUP', 'Stored recipe contains a cycle.');
            const row = rows.get(pin.sha256)!;
            let bytes: Uint8Array;
            if (row.location === 'recipe') {
              const next = new Set(ancestors);
              next.add(pin.sha256);
              const [recipeBytes] = await this.read(
                [{ sha256: row.recipe.digest, size: row.recipe.size }],
                false,
                next,
              );
              const recipe = downloadRecipeSchema.parse(JSON.parse(new TextDecoder().decode(recipeBytes)));
              invariant(
                recipe.object.sha256 === pin.sha256 && recipe.object.size === pin.size,
                'INVALID_WORK_BACKUP',
                'Stored recipe differs from its logical binding.',
              );
              bytes = await this.tree(pin, recipe.tree, next);
            } else bytes = await this.get(row, signed.get(pin.sha256), ranged);
            this.remember(pin, bytes);
            return bytes.slice();
          }),
        )),
      );
    // Revocation during a GET or a cache hit must not expose content to the caller.
    await this.rows(pins);
    return result;
  }
  /** Range leaves in full so each leaf's digest can be verified before any slice is used. */
  async tree(
    pin: DownloadPin,
    tree: DownloadTree,
    ancestors: ReadonlySet<string> = new Set(),
    offset = 0,
    length = pin.size,
  ) {
    invariant(
      tree.length === pin.size &&
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(length) &&
        length >= 0 &&
        offset + length <= pin.size,
      'INVALID_WORK_BACKUP',
      'Stored tree has different logical byte offsets.',
    );
    const bytes = new Uint8Array(length);
    let copied = 0;
    const visit = async (ref: DownloadTree, start: number): Promise<void> => {
      if (start >= offset + length || start + ref.length <= offset) return;
      invariant(
        ref.size <= (ref.height ? 2 * 1024 * 1024 : 1024 * 1024),
        'INVALID_WORK_BACKUP',
        'Stored tree has an invalid node encoding.',
      );
      const [content] = await this.read([ref], ref.height === 0, ancestors);
      if (ref.height === 0) {
        invariant(
          ref.length === ref.size,
          'INVALID_WORK_BACKUP',
          'Stored leaf has a different logical size.',
        );
        const from = Math.max(start, offset),
          to = Math.min(start + ref.length, offset + length);
        bytes.set(content!.subarray(from - start, to - start), from - offset);
        copied += to - from;
      } else {
        const page = downloadPageSchema.parse(JSON.parse(new TextDecoder().decode(content)));
        invariant(
          page.children.every(child => child.height < ref.height) &&
            page.children.reduce((sum, child) => sum + child.length, 0) === ref.length,
          'INVALID_WORK_BACKUP',
          'Stored tree has invalid ancestry or length.',
        );
        let position = start;
        for (const child of page.children) {
          await visit(child, position);
          position += child.length;
        }
      }
    };
    await visit(tree, 0);
    invariant(copied === length, 'INVALID_WORK_BACKUP', 'Stored tree range is incomplete.');
    return offset === 0 && length === pin.size ? verifiedBytes(bytes, pin.sha256) : bytes;
  }
  async range(pin: DownloadPin, offset: number, length: number) {
    const rows = await this.rows([pin]),
      row = rows.get(pin.sha256)!;
    if (row.location !== 'recipe') return (await this.read([pin]))[0]!.slice(offset, offset + length);
    const [bytes] = await this.read([{ sha256: row.recipe.digest, size: row.recipe.size }]);
    const recipe = downloadRecipeSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    invariant(
      recipe.object.sha256 === pin.sha256 && recipe.object.size === pin.size,
      'INVALID_WORK_BACKUP',
      'Stored recipe differs from its logical binding.',
    );
    const result = await this.tree(pin, recipe.tree, new Set([pin.sha256]), offset, length);
    await this.rows([pin]);
    return result;
  }
}
