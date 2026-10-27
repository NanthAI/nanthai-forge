// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { saveObjectSchema } from './hosted-save.js';
import { parseNativeState, type NativeSource } from './native-source.js';
import { writeRecoveryState } from './recovery-state.js';
import type { RecoveryObjects } from './recovery-hosted-objects.js';
import type { RecoveryTransport } from './recovery-source.js';
type Pin = z.infer<typeof saveObjectSchema>;
const discoverySchema = z.object({
  pin: saveObjectSchema,
  parents: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  unknown: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
});

/** Local receipts describe retained bytes, never current hosted authority. The
 * caller still verifies every hosted table page and the selected main/epoch.
 * Only hashes/pins survive a State iteration, not its parsed tree or bytes. */
export class RecoveryStateQueue {
  constructor(
    private readonly source: NativeSource,
    private readonly directory: string,
    private readonly transport: RecoveryTransport & { prepareDownloads?(pins: Pin[]): Promise<void> },
    private readonly retained: RecoveryObjects,
  ) {}
  private put(value: unknown): Pin {
    const bytes = Buffer.from(canonicalPayload(value));
    return { sha256: this.source.put(bytes), size: bytes.length };
  }
  private receipt(id: string, kind: string, expected?: Pin): Pin | undefined {
    const path = join(this.directory, `${kind}-${id}.json`);
    if (!existsSync(path)) return;
    const receipt = JSON.parse(readFileSync(path, 'utf8')),
      pin = saveObjectSchema.parse(receipt.pin),
      root = saveObjectSchema.parse(receipt.root);
    invariant(
      pin.sha256 === id && (!expected || expected.size === pin.size),
      'INVALID_WORK_BACKUP',
      'Recovery receipt identity differs.',
    );
    invariant(
      this.source.object(root.sha256).length === root.size,
      'INVALID_WORK_BACKUP',
      'Recovery receipt bytes differ.',
    );
    return root;
  }
  /** Reuse the existing batch transport in a 2 MiB / 100-object byte window.
   * Large opaque bodies retain their existing streaming path. */
  private async prefetch(pins: Pin[]) {
    let window: Pin[] = [],
      size = 0;
    const flush = async () => {
      if (!window.length) return;
      const bytes = this.transport.downloadBatch
        ? await this.transport.downloadBatch(window)
        : await Promise.all(window.map(pin => this.transport.download(pin)));
      invariant(bytes.length === window.length, 'INVALID_WORK_BACKUP', 'Recovery download omitted content.');
      for (const [index, pin] of window.entries()) {
        const value = bytes[index]!;
        invariant(
          value.length === pin.size && digest(value) === pin.sha256,
          'INVALID_WORK_BACKUP',
          'Hosted recovery object bytes differ.',
        );
        this.source.put(value);
      }
      window = [];
      size = 0;
    };
    for (const pin of pins) {
      if (existsSync(join(this.source.directory, pin.sha256)) || pin.size > 2 * 1024 * 1024) continue;
      if (window.length && (window.length === 100 || size + pin.size > 2 * 1024 * 1024)) await flush();
      window.push(pin);
      size += pin.size;
    }
    await flush();
  }
  private async resolve(ids: string[]): Promise<Pin[]> {
    invariant(this.transport.objects, 'SOURCE_UNAVAILABLE', 'Recovery requires project-scoped object reads.');
    const pins = await this.transport.objects(ids);
    invariant(
      pins.length === ids.length &&
        pins.every((pin, index) => saveObjectSchema.safeParse(pin).success && pin.sha256 === ids[index]),
      'SOURCE_UNAVAILABLE',
      'The exact hosted source objects are unavailable.',
    );
    return pins;
  }
  private discover(pin: Pin, opaque: Set<string>, unknown: Set<string>) {
    const id = pin.sha256,
      path = join(this.directory, `discovered-${id}.json`);
    if (existsSync(path)) {
      const discovery = discoverySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      invariant(
        discovery.pin.sha256 === id && discovery.pin.size === pin.size,
        'INVALID_WORK_BACKUP',
        'Discovered State pins differ.',
      );
      return discovery;
    }
    const bytes = this.source.object(id);
    invariant(bytes.length === pin.size, 'INVALID_WORK_BACKUP', 'Hosted recovery State size differs.');
    const parsed = parseNativeState(bytes),
      fresh = new Set<string>();
    for (const file of parsed.files)
      if (!opaque.has(file.blob) && !unknown.has(file.blob)) fresh.add(file.blob);
    if (parsed.git && !opaque.has(parsed.git.bundle) && !unknown.has(parsed.git.bundle))
      fresh.add(parsed.git.bundle);
    const discovery = { pin, parents: parsed.parents, unknown: [...fresh] };
    writeRecoveryState(path, discovery);
    return discovery;
  }
  async run(seeds: Iterable<Pin>): Promise<Pin> {
    const pending = new Map<string, Pin | null>(),
      done = new Map<string, Pin>(),
      unknown = new Set<string>(),
      opaque = new Set<string>();
    let root: Pin | null = null;
    const include = (object: Pin, nested: boolean) => {
      root = this.put({ kind: 'forge-hosted-recovery-object', previous: root, object, nested });
    };
    for (const seed of seeds) {
      const pin = saveObjectSchema.parse(seed),
        previous = pending.get(pin.sha256);
      invariant(!previous || previous.size === pin.size, 'INVALID_WORK_BACKUP', 'State pins differ.');
      pending.set(pin.sha256, pin);
    }
    // Completed seeds already own their entire closure. Reuse their original
    // shared receipt instead of rebuilding an inventory of every retained blob.
    const completed = new Map<string, Pin>();
    let allComplete = pending.size > 0;
    for (const [id, pin] of pending) {
      const cached = this.receipt(id, 'state', pin!);
      if (!cached) {
        allComplete = false;
        break;
      }
      completed.set(cached.sha256, cached);
    }
    if (allComplete) {
      if (completed.size === 1) return completed.values().next().value!;
      for (const pin of completed.values()) include(pin, true);
      return root!;
    }
    for (const name of readdirSync(this.directory))
      if (/^opaque-[a-f0-9]{64}\.json$/.test(name)) opaque.add(name.slice(7, -5));
    // Registered States are all seeded first. Missing registration coverage is
    // resolved explicitly through the same queue, never assumed absent.
    while (pending.size) {
      const page: string[] = [],
        missing: string[] = [];
      let bytes = 0;
      for (const [id, pin] of pending) {
        if (page.length && (page.length === 100 || bytes + (pin?.size ?? 0) > 2 * 1024 * 1024)) break;
        page.push(id);
        bytes += pin?.size ?? 0;
      }
      for (const id of page)
        if (!pending.get(id) && !this.receipt(id, 'state', pending.get(id) ?? undefined)) missing.push(id);
      if (missing.length) for (const pin of await this.resolve(missing)) pending.set(pin.sha256, pin);
      const pins = page.flatMap(id =>
        this.receipt(id, 'state', pending.get(id) ?? undefined) ? [] : [pending.get(id)!],
      );
      await this.prefetch(pins);
      for (const id of page) {
        const complete = this.receipt(id, 'state', pending.get(id) ?? undefined);
        pending.delete(id);
        if (complete) {
          include(complete, true);
          continue;
        }
        const pin = pins.find(pin => pin.sha256 === id)!;
        if (!existsSync(join(this.source.directory, id))) {
          const bytes = await this.transport.download(pin);
          invariant(
            bytes.length === pin.size && digest(bytes) === id,
            'INVALID_WORK_BACKUP',
            'Hosted recovery State differs.',
          );
          this.source.put(bytes);
        }
        const discovery = this.discover(pin, opaque, unknown);
        for (const hash of discovery.unknown) unknown.add(hash);
        done.set(id, pin);
        include(pin, false);
        for (const parent of discovery.parents)
          if (!done.has(parent) && !pending.has(parent)) pending.set(parent, null);
      }
    }
    // Completed opaque receipts are already part of the closure. Their hash set
    // deduplicates historical references before any project object query.
    for (const id of opaque) include(this.receipt(id, 'opaque')!, true);
    const ids = [...unknown].filter(id => !opaque.has(id));
    for (let at = 0; at < ids.length; at += 100) {
      const page = ids.slice(at, at + 100),
        local: Pin[] = [],
        missing: string[] = [];
      for (const id of page) {
        if (existsSync(join(this.source.directory, id))) {
          const pin = await fingerprintPrivateFile(join(this.source.directory, id), 'INVALID_WORK_BACKUP');
          invariant(pin.sha256 === id, 'INVALID_WORK_BACKUP', 'Local recovery source differs.');
          local.push(pin);
        } else missing.push(id);
      }
      const pins = [...local, ...(missing.length ? await this.resolve(missing) : [])];
      const large = pins.filter(
        pin => pin.size > 2 * 1024 * 1024 && !existsSync(join(this.source.directory, pin.sha256)),
      );
      if (large.length) await this.transport.prepareDownloads?.(large);
      await this.prefetch(pins);
      for (const pin of pins) include(await this.retained.retain(pin, false, false), true);
    }
    root ??= this.put({ kind: 'forge-hosted-recovery-empty' });
    // A completed State points at the shared deduplicated closure. Publishing
    // these receipts last makes interrupted discovery/downloads safe to replay.
    for (const pin of done.values())
      writeRecoveryState(join(this.directory, `state-${pin.sha256}.json`), { pin, root });
    return root;
  }
}
