// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { chmod, open, rename, rm } from 'node:fs/promises';
import { mapExchange } from './exchange-parallel.js';
import { join } from 'node:path';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { syncDirectory } from './native-durability.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import type { ContentPin } from './native-exchange.js';
import type { SourcePackDownload } from './source-pack.js';
import { downloadSourcePack, fileDigest, unpackSourcePackObjects } from './source-pack-archive.js';
import { cloneFile, machineObjectsDirectory, rememberObject } from './machine-object-store.js';
export interface CheckoutObjectTransport {
  readonly objectPageSize?: number;
  objects(digests: string[]): Promise<ContentPin[]>;
  downloadToFile(pin: ContentPin, path: string): Promise<void>;
  downloadFiles?(files: { pin: ContentPin; path: string }[]): Promise<void>;
  /** The project's latest source pack, or null. Never throws: a pack is only a cache. */
  sourcePack?(): Promise<SourcePackDownload | null>;
}
/** Below this many missing objects, per-object pages are cheaper than one pack. */
export const checkoutPackMinimum = 500;
/** Concurrent local file operations (clone, hash, fsync); APFS latency dominates large trees. */
export const checkoutIoConcurrency = 16;
/** Disposable bytes only; fresh selection/access checks remain the caller's responsibility. */
export class HostedCheckoutCache {
  downloadedObjects = 0;
  downloadedBytes = 0;
  /** Objects taken from the machine store, and from the source pack (with its bytes). */
  machineObjects = 0;
  packObjects = 0;
  packBytes = 0;
  sourcePack: 'used' | 'missing' | 'failed' | null = null;
  readonly objects: string;
  constructor(
    readonly root: string,
    private readonly transport: CheckoutObjectTransport,
    objects = join(root, 'objects'),
    private readonly machine: string | null = machineObjectsDirectory(),
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    invariant(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Client cache must be real.');
    this.objects = objects;
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    invariant(!lstatSync(this.objects).isSymbolicLink(), 'UNSAFE_PATH', 'Client objects must be real.');
  }
  async ensure(ids: string[]) {
    const unique = [...new Set(ids)];
    // Parallel file reads: per-file latency, not bandwidth, bounds large trees.
    const cached = await mapExchange(unique, checkoutIoConcurrency, async id => {
      const path = join(this.objects, id);
      if (!checkoutPathExists(path)) return false;
      const stat = lstatSync(path);
      invariant(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        'UNSAFE_PATH',
        'Client object path must be a private regular file.',
      );
      return (await fingerprintPrivateFile(path)).sha256 === id;
    });
    let missing = unique.filter((_, index) => !cached[index]);
    if (missing.length && this.machine) missing = await this.fromMachine(missing);
    if (missing.length >= checkoutPackMinimum && this.transport.sourcePack && this.sourcePack === null)
      missing = await this.fromPack(missing);
    const pageSize = this.transport.objectPageSize ?? 100;
    for (let at = 0; at < missing.length; at += pageSize) {
      const page = missing.slice(at, at + pageSize);
      const pins = await this.transport.objects(page);
      invariant(
        pins.length === page.length &&
          pins.every(
            (pin, index) => pin.sha256 === page[index] && Number.isSafeInteger(pin.size) && pin.size >= 0,
          ),
        'INVALID_NATIVE_SOURCE',
        'Source pins differ from selected content.',
      );
      // Transport windows bound both metadata calls and in-memory small-object reads.
      let group: ContentPin[] = [],
        size = 0;
      for (const pin of pins) {
        if (group.length && size + pin.size > 16 * 1024 * 1024) {
          await this.download(group);
          group = [];
          size = 0;
        }
        group.push(pin);
        size += pin.size;
      }
      if (group.length) await this.download(group);
    }
  }
  private async download(pins: ContentPin[]) {
    const temporary = mkdtempSync(join(this.root, 'download-'));
    const files = pins.map(pin => ({ pin, path: join(temporary, pin.sha256) }));
    try {
      if (this.transport.downloadFiles) await this.transport.downloadFiles(files);
      else for (const { pin, path } of files) await this.transport.downloadToFile(pin, path);
      await mapExchange(files, checkoutIoConcurrency, async ({ pin, path }) => {
        invariant(
          lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
          'INVALID_NATIVE_SOURCE',
          'Downloaded source must be a regular file.',
        );
        await chmod(path, 0o600);
        const actual = await fingerprintPrivateFile(path);
        invariant(
          actual.sha256 === pin.sha256 && actual.size === pin.size,
          'INVALID_NATIVE_SOURCE',
          'Downloaded source is truncated or corrupt.',
        );
        const handle = await open(path, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const target = join(this.objects, pin.sha256);
        await rename(path, target);
        await rememberObject(this.machine, target, pin.sha256);
        this.downloadedObjects++;
        this.downloadedBytes += pin.size;
      });
      // One directory flush per window instead of one per object.
      syncDirectory(this.objects);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  /** Verified clones from the machine store; a bad entry is dropped and fetched again. */
  private async fromMachine(ids: string[]) {
    const temporary = mkdtempSync(join(this.root, 'machine-'));
    try {
      const found = await mapExchange(ids, checkoutIoConcurrency, async id => {
        const source = join(this.machine!, id),
          path = join(temporary, id);
        if (!checkoutPathExists(source)) return false;
        try {
          await cloneFile(source, path);
          await chmod(path, 0o600);
          invariant((await fileDigest(path)) === id, 'INVALID_NATIVE_SOURCE', 'Machine object differs.');
        } catch {
          await rm(source, { force: true });
          return false;
        }
        await rename(path, join(this.objects, id));
        this.machineObjects++;
        return true;
      });
      return ids.filter((_, index) => !found[index]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  /** One pack GET replaces per-object signing pages. Every written object passed its
   * own digest check; anything the pack lacks still comes object by object. */
  private async fromPack(missing: string[]) {
    const pack = await this.transport.sourcePack!().catch(() => null);
    if (!pack) {
      this.sourcePack = 'missing';
      return missing;
    }
    const temporary = mkdtempSync(join(this.root, 'pack-'));
    try {
      const archive = join(temporary, 'pack.gz'),
        unpacked = join(temporary, 'objects'),
        wanted = new Set(missing);
      await downloadSourcePack(pack, archive);
      const written = await unpackSourcePackObjects(
        pack,
        archive,
        unpacked,
        blob => wanted.has(blob) || (this.machine !== null && !checkoutPathExists(join(this.machine, blob))),
      );
      await rm(archive, { force: true });
      await mapExchange(written, checkoutIoConcurrency, async id => {
        const path = join(unpacked, id);
        await rememberObject(this.machine, path, id);
        if (wanted.has(id)) await rename(path, join(this.objects, id));
      });
      for (const id of written) if (wanted.delete(id)) this.packObjects++;
      this.packBytes = pack.size;
      this.sourcePack = 'used';
      return missing.filter(id => wanted.has(id));
    } catch {
      this.sourcePack = 'failed';
      return missing;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
