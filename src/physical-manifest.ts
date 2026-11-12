// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './state/hash.js';
import { sha256Hex } from './verified-blob.js';
import { invariant } from './errors.js';
import {
  decodePhysicalEntries,
  physicalBucket,
  type PhysicalEntry,
  type PhysicalPin,
} from './physical-manifest-codec.js';
import { physicalKey } from './physical-manifest-binary.js';
import { decodePhysicalRoot } from './physical-manifest-root.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const physicalPinSchema = z.object({
  sha256: hash,
  size,
  pack: z
    .object({
      digest: hash,
      size,
      offset: size,
      nonce: z
        .string()
        .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
        .optional(),
    })
    .optional(),
});
export const physicalManifestSchema = z.object({
  schema: z.literal(1),
  kind: z.literal('forge-physical-manifest'),
  state: hash,
  chunks: z
    .array(physicalPinSchema.extend({ bucket: z.number().int().min(0).max(1023), members: hash.optional() }))
    .max(1024),
});
export type PhysicalManifest = z.infer<typeof physicalManifestSchema>;
type Read = (pin: PhysicalPin) => Promise<Uint8Array>;
/** Each R2 body is checked before parsing or using any of its bindings. */
export async function readPhysicalPin(pin: PhysicalPin, read: Read) {
  const bytes = await read(pin);
  invariant(
    bytes.length === pin.size && (await sha256Hex(bytes)) === pin.sha256,
    'SOURCE_HASH_MISMATCH',
    'Physical manifest differs from its exact hash and size.',
  );
  return bytes;
}
/** One verified recipe root plus only the requested digest buckets. The cache is
 * private to one authorized operation and holds no source body bytes or grants. */
export class PhysicalManifestReader {
  private readonly chunks = new Map<number, Promise<PhysicalEntry[]>>();
  private constructor(
    readonly root: PhysicalManifest,
    private readonly read: Read,
  ) {}
  static async open(state: string, pin: PhysicalPin, read: Read) {
    const bytes = await readPhysicalPin(pin, read);
    const root = physicalManifestSchema.parse(
      bytes[0] === 70
        ? decodePhysicalRoot(bytes)
        : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    invariant(
      root.state === state &&
        root.chunks.every(
          (chunk, index) =>
            (!index || root.chunks[index - 1]!.bucket < chunk.bucket) &&
            (!chunk.pack ||
              (chunk.size > 0 &&
                Number.isSafeInteger(chunk.pack.offset + chunk.size) &&
                chunk.pack.offset + chunk.size <= chunk.pack.size)),
        ),
      'SOURCE_HASH_MISMATCH',
      'Physical manifest selects a different State or invalid chunks.',
    );
    return new PhysicalManifestReader(root, read);
  }
  /** Copy only a selected parent chunk, byte for byte, after its hash check. */
  async readChunk(bucket: number) {
    const pin = this.root.chunks.find(chunk => chunk.bucket === bucket);
    invariant(pin, 'SOURCE_HASH_MISMATCH', 'Physical manifest chunk is not in the selected root.');
    return readPhysicalPin(pin, this.read);
  }
  /** Read one covering range per exact metadata key; check each selected chunk
   * separately and never parse the superseded bytes between live chunks. */
  async readChunks(buckets: readonly number[]) {
    const groups = new Map<string, PhysicalManifest['chunks']>();
    for (const bucket of buckets) {
      const pin = this.root.chunks.find(chunk => chunk.bucket === bucket);
      invariant(pin, 'SOURCE_HASH_MISMATCH', 'Physical manifest chunk is not in the selected root.');
      const key = physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce);
      groups.set(key, [...(groups.get(key) ?? []), pin]);
    }
    const result = new Map<number, Uint8Array>();
    for (const pins of groups.values()) {
      const first = pins[0]!;
      if (!first.pack) {
        result.set(first.bucket, await this.readChunk(first.bucket));
        continue;
      }
      const start = Math.min(...pins.map(pin => pin.pack!.offset)),
        end = Math.max(...pins.map(pin => pin.pack!.offset + pin.size));
      invariant(
        pins.every(pin => pin.pack?.size === first.pack!.size),
        'SOURCE_HASH_MISMATCH',
        'Physical metadata pack sizes differ.',
      );
      const bytes = await this.read({ ...first, size: end - start, pack: { ...first.pack, offset: start } });
      invariant(
        bytes.length === end - start,
        'SOURCE_HASH_MISMATCH',
        'Physical metadata range is incomplete.',
      );
      for (const pin of pins) {
        const chunk = bytes.slice(pin.pack!.offset - start, pin.pack!.offset - start + pin.size);
        invariant(
          chunk.length === pin.size && (await sha256Hex(chunk)) === pin.sha256,
          'SOURCE_HASH_MISMATCH',
          'Physical manifest differs from its exact hash and size.',
        );
        result.set(pin.bucket, chunk);
      }
    }
    return result;
  }
  private chunk(bucket: number) {
    let pending = this.chunks.get(bucket);
    if (!pending) {
      const pin = this.root.chunks.find(chunk => chunk.bucket === bucket);
      pending = pin
        ? this.readChunk(bucket).then(bytes => {
            const entries = decodePhysicalEntries(bytes, bucket);
            invariant(
              !pin.members || digest(entries.map(entry => entry.sha256).join('')) === pin.members,
              'SOURCE_HASH_MISMATCH',
              'Physical manifest membership fingerprint changed.',
            );
            return entries;
          })
        : Promise.resolve([]);
      this.chunks.set(bucket, pending);
    }
    return pending;
  }
  async lookup(ids: readonly string[]): Promise<(PhysicalEntry | null)[]> {
    invariant(
      ids.every(id => /^[a-f0-9]{64}$/.test(id)),
      'SOURCE_HASH_MISMATCH',
      'Select exact physical manifest members.',
    );
    const buckets = new Map<number, Map<string, PhysicalEntry>>();
    for (const bucket of new Set(ids.map(physicalBucket)))
      buckets.set(bucket, new Map((await this.chunk(bucket)).map(entry => [entry.sha256, entry])));
    return ids.map(id => buckets.get(physicalBucket(id))!.get(id) ?? null);
  }
  async *all(retain = true): AsyncGenerator<PhysicalEntry> {
    for (const pin of this.root.chunks) {
      yield* await this.chunk(pin.bucket);
      if (!retain) this.chunks.delete(pin.bucket);
    }
  }
}
/** Missing/corrupt derived bindings never select different source. Fall back to
 * the exact selected digests in the existing catalog and name the path taken. */
export async function manifestOrCatalog<T>(
  manifest: () => Promise<T | null>,
  catalog: () => Promise<T>,
  log: (message: string) => void,
) {
  try {
    const result = await manifest();
    if (result !== null) {
      log('source bindings: physical manifest');
      return result;
    }
    log('source bindings: catalog (physical manifest missing)');
  } catch {
    // Do not log network errors: their messages can contain signed URLs.
    log('source bindings: catalog (physical manifest invalid or unavailable)');
  }
  return catalog();
}
