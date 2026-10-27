// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { RecoveryStateQueue } from './recovery-state-queue.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { fingerprintPrivateFile } from './files.js';
import { syncDirectory } from './native-durability.js';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { saveObjectSchema } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { writeRecoveryState } from './recovery-state.js';
import type { RecoveryTransport } from './recovery-source.js';
import type { z } from 'zod';
type Pin = z.infer<typeof saveObjectSchema>;

/** Only protocol metadata is inspected for content pins; arbitrary source blobs
 * are never interpreted as instructions or metadata. */
export function* recoveryContentPins(value: unknown): Generator<Pin> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* recoveryContentPins(item);
    return;
  }
  const pin = saveObjectSchema.safeParse(value);
  if (pin.success) {
    yield pin.data;
    return;
  }
  for (const item of Object.values(value)) yield* recoveryContentPins(item);
}

export class RecoveryObjects {
  constructor(
    readonly source: NativeSource,
    private readonly directory: string,
    private readonly transport: RecoveryTransport,
  ) {}
  async state(id: string) {
    invariant(this.transport.objects, 'SOURCE_UNAVAILABLE', 'Recovery requires project-scoped object reads.');
    const [pin] = await this.transport.objects([id]);
    invariant(pin?.sha256 === id, 'SOURCE_UNAVAILABLE', 'The exact hosted source object is unavailable.');
    return this.states([pin]);
  }
  /** Registration pins seed the whole frontier before ancestry is traversed. */
  async states(pins: Iterable<Pin>): Promise<Pin> {
    return new RecoveryStateQueue(this.source, this.directory, this.transport, this).run(pins);
  }
  /** Metadata and opaque objects retain durable content-addressed receipts;
   * State ancestry uses the iterative discovery queue above. */
  async retain(pin: Pin, state = false, inspect = true): Promise<Pin> {
    if (state) return this.states([pin]);
    const marker = join(this.directory, `${inspect ? 'metadata' : 'opaque'}-${pin.sha256}.json`);
    if (existsSync(marker)) {
      const receipt = JSON.parse(readFileSync(marker, 'utf8'));
      const original = saveObjectSchema.parse(receipt.pin),
        root = saveObjectSchema.parse(receipt.root);
      invariant(
        original.sha256 === pin.sha256 && original.size === pin.size,
        'INVALID_WORK_BACKUP',
        'Cached recovery object pins differ.',
      );
      const bytes = this.source.object(root.sha256);
      invariant(bytes.length === root.size, 'INVALID_WORK_BACKUP', 'Recovery object receipt differs.');
      return root;
    }
    // Large opaque blobs stream through the verified checkout cache. Small
    // prefetched blobs use the bounded native read below, avoiding a separate
    // stream/buffer allocation for every tiny historical file.
    if (!inspect && pin.size > 2 * 1024 * 1024 && this.transport.downloadToFile) {
      this.source.put(Buffer.alloc(0)); // Initialize and validate private object directories.
      const target = join(this.source.directory, pin.sha256);
      if (!existsSync(target)) {
        const cache = new HostedCheckoutCache(join(this.directory, 'streamed'), {
          objects: async ids => {
            invariant(
              ids.length === 1 && ids[0] === pin.sha256,
              'INVALID_WORK_BACKUP',
              'Retain the selected opaque object.',
            );
            return [pin];
          },
          downloadToFile: (selected, path) => this.transport.downloadToFile!(selected, path),
        });
        await cache.ensure([pin.sha256]);
        renameSync(join(cache.objects, pin.sha256), target);
        syncDirectory(this.source.directory);
      }
      const observed = await fingerprintPrivateFile(target, 'INVALID_WORK_BACKUP');
      invariant(
        observed.sha256 === pin.sha256 && observed.size === pin.size,
        'INVALID_WORK_BACKUP',
        'Hosted recovery blob differs from its selected pin.',
      );
      const value = Buffer.from(
        canonicalPayload({
          kind: 'forge-hosted-recovery-object',
          previous: null,
          object: pin,
          nested: false,
        }),
      );
      const root = { sha256: this.source.put(value), size: value.length };
      writeRecoveryState(marker, { pin, root });
      return root;
    }
    let bytes: Buffer;
    const path = join(this.source.directory, pin.sha256);
    if (existsSync(path)) bytes = this.source.object(pin.sha256);
    else {
      bytes = await this.transport.download(pin);
      invariant(digest(bytes) === pin.sha256, 'INVALID_WORK_BACKUP', 'Hosted recovery object bytes differ.');
      this.source.put(bytes);
    }
    invariant(bytes.length === pin.size, 'INVALID_WORK_BACKUP', 'Hosted recovery object size differs.');
    // A linked inventory keeps even a State with many files out of an expanding receipt.
    let previous: Pin | null = null;
    const include = (object: Pin, nested = true) => {
      const value = Buffer.from(
        canonicalPayload({ kind: 'forge-hosted-recovery-object', previous, object, nested }),
      );
      previous = { sha256: this.source.put(value), size: value.length };
    };
    if (inspect) {
      let value;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        /* Opaque object. */
      }
      if (typeof value?.kind === 'string' && value.kind.startsWith('forge-hosted-'))
        for (const child of recoveryContentPins(value)) include(await this.retain(child));
    }
    include(pin, false);
    writeRecoveryState(marker, { pin, root: previous });
    return previous!;
  }
}
