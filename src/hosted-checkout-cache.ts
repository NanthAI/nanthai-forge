// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { chmod, rename, rm } from 'node:fs/promises';
import { checkoutIo, mapCheckoutIo } from './checkout-io.js';
import { join } from 'node:path';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { syncDirectory } from './state/durability.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import type { ContentPin } from './native-exchange.js';
import type { SourcePackDownload } from './source-pack.js';
import { downloadSourcePack, unpackSourcePackObjects } from './source-pack-archive.js';
import { cloneFile, machineObjectsDirectory, rememberObject } from './machine-object-store.js';
import { neverIndex } from './forge-disk.js';
import { ownerOnly } from './file-mode.js';
import { aheadOf, runDownloadWindows } from './checkout-download-schedule.js';
export interface CheckoutObjectTransport {
  readonly objectPageSize?: number;
  objects(digests: string[]): Promise<ContentPin[]>;
  downloadToFile(pin: ContentPin, path: string): Promise<void>;
  downloadFiles?(files: { pin: ContentPin; path: string }[]): Promise<void>;
  /** The project's latest source pack, or null. Never throws: a pack is only a cache. */
  sourcePack?(): Promise<SourcePackDownload | null>;
  /** Download windows that keep transfer units (pack runs) whole; default sizeGroups. */
  downloadGroups?(pins: ContentPin[]): ContentPin[][];
  /** downloadToFile/downloadFiles check every written file's size and digest before they
   * return, so the cache does not read and hash each new object a second time. */
  readonly verifiesDownloads?: boolean;
  /** Download windows this transport runs at once (default 1). Two let a page's large files
   * stream while the next window's runs download, instead of all waiting for the last page. */
  readonly downloadWindows?: number;
}
/** Metadata pages described ahead of the one being downloaded and installed: with 500-pin pages,
 * a checkout of about 4,000 objects describes every page at once, so a large file on its last
 * page is found (and its walk started) early. The calls are the same; only their overlap grows. */
export const checkoutDescribeAhead = 7;
/** Windows of at most 16 MiB (one larger object alone). */
export function sizeGroups(pins: ContentPin[]) {
  const groups: ContentPin[][] = [];
  let group: ContentPin[] = [],
    size = 0;
  for (const pin of pins) {
    if (group.length && size + pin.size > 16 * 1024 * 1024) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(pin);
    size += pin.size;
  }
  if (group.length) groups.push(group);
  return groups;
}
/** Below this many missing objects, per-object pages are cheaper than one pack. */
export const checkoutPackMinimum = 500;
/** Disposable bytes only; fresh selection/access checks remain the caller's responsibility. */
export class HostedCheckoutCache {
  downloadMs = 0;
  downloadedObjects = 0;
  downloadedBytes = 0;
  /** Objects taken from the machine store, and from the source pack (with its bytes). */
  machineObjects = 0;
  packObjects = 0;
  packBytes = 0;
  sourcePack: 'used' | 'missing' | 'failed' | null = null;
  readonly objects: string;
  private readonly fallbackObjects: string | null;
  constructor(
    readonly root: string,
    private readonly transport: CheckoutObjectTransport,
    objects = join(root, 'objects'),
    private readonly machine: string | null = machineObjectsDirectory(),
    directMachine = false,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    invariant(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Client cache must be real.');
    // The machine store already contains independent immutable objects. Verify
    // them there and clone once into the editing tree, rather than first cloning
    // every object into another disposable per-Lane store.
    this.objects = directMachine && machine ? machine : objects;
    this.fallbackObjects = this.objects === machine ? objects : machine;
    for (const directory of new Set([objects, this.objects])) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      invariant(!lstatSync(directory).isSymbolicLink(), 'UNSAFE_PATH', 'Client objects must be real.');
    }
    if (this.objects === this.machine) neverIndex(this.objects);
  }
  /** Include every cache device in the open's volume lease, even on fallback. */
  get ioPaths() {
    return [
      this.objects,
      ...(this.fallbackObjects ? [this.fallbackObjects] : []),
      ...(this.machine ? [this.machine] : []),
    ];
  }
  /** `installVerifies`: the caller clones each object and checks its digest before
   * use (Lane install), so a direct machine hit needs only a safe-file check here,
   * not a second read and hash. Damage found at install goes through `repair`. */
  async ensure(ids: string[], options: { installVerifies?: boolean } = {}) {
    const unique = [...new Set(ids)];
    const deferred = options.installVerifies === true && this.objects === this.machine;
    let missing = await this.present(unique, deferred);
    if (missing.length && this.fallbackObjects) missing = await this.fromCache(missing);
    if (missing.length >= checkoutPackMinimum && this.transport.sourcePack && this.sourcePack === null)
      missing = await this.fromPack(missing);
    await this.fetchMissing(missing);
  }
  /** Describe pages of `missing` and download them in windows. */
  private async fetchMissing(missing: string[]) {
    if (!missing.length) return;
    const pageSize = this.transport.objectPageSize ?? 100,
      pages: string[][] = [];
    for (let at = 0; at < missing.length; at += pageSize) pages.push(missing.slice(at, at + pageSize));
    // Later pages' metadata calls overlap earlier pages' transfers and installs (calls unchanged).
    const transport = this.transport;
    async function* described() {
      for await (const [page, pins] of aheadOf(pages, checkoutDescribeAhead, page =>
        transport.objects(page),
      )) {
        invariant(
          pins.length === page.length &&
            pins.every(
              (pin, index) => pin.sha256 === page[index] && Number.isSafeInteger(pin.size) && pin.size >= 0,
            ),
          'INVALID_NATIVE_SOURCE',
          'Source pins differ from selected content.',
        );
        // Transport windows bound both metadata calls and in-memory small-object reads.
        yield transport.downloadGroups?.(pins) ?? sizeGroups(pins);
      }
    }
    await runDownloadWindows(described(), Math.max(1, Math.min(4, transport.downloadWindows ?? 1)), group =>
      this.download(group),
    );
  }
  /** Ids absent or invalid in `objects`. Parallel file reads: per-file latency, not
   * bandwidth, bounds large trees. */
  private async present(ids: string[], deferred: boolean) {
    const cached = await mapCheckoutIo(ids, async id => {
      const path = join(this.objects, id);
      if (!checkoutPathExists(path)) return false;
      const stat = lstatSync(path);
      // A machine entry is disposable, including one with unsafe permissions or
      // links. Refetch it instead of turning cache damage into a denied open.
      if (
        this.objects === this.machine &&
        (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerOnly(stat.mode))
      )
        return false;
      invariant(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        'UNSAFE_PATH',
        'Client object path must be a private regular file.',
      );
      if (deferred) {
        this.machineObjects++;
        return true;
      }
      const actual =
        this.objects === this.machine
          ? await fingerprintPrivateFile(path).catch(() => null)
          : await fingerprintPrivateFile(path);
      const valid = actual?.sha256 === id;
      if (valid && this.objects === this.machine) this.machineObjects++;
      return valid;
    });
    return ids.filter((_, index) => !cached[index]);
  }
  /** Only direct machine-store hits defer verification to install, so only they repair. */
  get repairable() {
    return this.objects === this.machine;
  }
  /** Install verification found these machine entries damaged or gone: drop them and
   * fetch verified bytes again. Only the shared machine store is ever repaired. */
  async repair(ids: string[]) {
    invariant(this.repairable, 'INVALID_NATIVE_SOURCE', 'Cloned source differs from the selected content.');
    const unique = [...new Set(ids)];
    await mapCheckoutIo(unique, id => rm(join(this.objects, id), { force: true }));
    this.machineObjects -= unique.length;
    await this.ensure(unique);
  }
  /** Object stores are caches rebuilt from the server: every reader checks an object's digest
   * before use (`present`, or the install clone with `repair`), so an object torn by a crash is
   * fetched again, never trusted. Objects therefore get no fsync each (that was about 2 ms per
   * object); one directory flush per window covers their names. A checkout flushes its own
   * installed files before its marker is written. */
  private async download(pins: ContentPin[]) {
    const temporary = await checkoutIo(async () => mkdtempSync(join(this.root, 'download-')));
    const files = pins.map(pin => ({ pin, path: join(temporary, pin.sha256) }));
    try {
      const started = performance.now();
      try {
        if (this.transport.downloadFiles) await this.transport.downloadFiles(files);
        else for (const { pin, path } of files) await this.transport.downloadToFile(pin, path);
      } finally {
        this.downloadMs += performance.now() - started;
      }
      const verified = this.transport.verifiesDownloads === true;
      await mapCheckoutIo(files, async ({ pin, path }) => {
        const stat = lstatSync(path);
        invariant(
          stat.isFile() && !stat.isSymbolicLink(),
          'INVALID_NATIVE_SOURCE',
          'Downloaded source must be a regular file.',
        );
        await chmod(path, 0o600);
        // A verifying transport hashed these bytes as it wrote them: check the size only.
        const actual = verified
          ? { sha256: pin.sha256, size: stat.size }
          : await fingerprintPrivateFile(path);
        invariant(
          actual.sha256 === pin.sha256 && actual.size === pin.size,
          'INVALID_NATIVE_SOURCE',
          'Downloaded source is truncated or corrupt.',
        );
      });
      await mapCheckoutIo(files, async ({ pin, path }) => {
        const target = join(this.objects, pin.sha256);
        await rename(path, target);
        await rememberObject(this.machine, target, pin.sha256);
        this.downloadedObjects++;
        this.downloadedBytes += pin.size;
      });
      // One directory flush per window instead of one per object.
      await checkoutIo(async () => syncDirectory(this.objects), 'durability');
    } finally {
      await checkoutIo(async () => rmSync(temporary, { recursive: true, force: true }));
    }
  }
  /** Reuse the machine store, or older per-checkout objects on the direct-machine path. */
  private async fromCache(ids: string[]) {
    const temporary = await checkoutIo(async () => mkdtempSync(join(this.root, 'machine-')));
    try {
      const found = await mapCheckoutIo(ids, async id => {
        const source = join(this.fallbackObjects!, id),
          path = join(temporary, id);
        if (!checkoutPathExists(source)) return false;
        const stat = lstatSync(source);
        if (this.fallbackObjects !== this.machine)
          invariant(
            stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
            'UNSAFE_PATH',
            'Client object path must be a private regular file.',
          );
        try {
          await cloneFile(source, path);
          await chmod(path, 0o600);
          invariant(
            (await fingerprintPrivateFile(path)).sha256 === id,
            'INVALID_NATIVE_SOURCE',
            'Machine object differs.',
          );
        } catch {
          if (this.fallbackObjects === this.machine) await rm(source, { force: true });
          return false;
        }
        await rename(path, join(this.objects, id));
        if (this.fallbackObjects === this.machine) this.machineObjects++;
        return true;
      });
      return ids.filter((_, index) => !found[index]);
    } finally {
      await checkoutIo(async () => rmSync(temporary, { recursive: true, force: true }));
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
    const temporary = await checkoutIo(async () => mkdtempSync(join(this.root, 'pack-')));
    let after: string[] = [],
      early = undefined as Promise<void> | undefined;
    try {
      const archive = join(temporary, 'pack.gz'),
        unpacked = join(temporary, 'objects'),
        wanted = new Set(missing);
      const started = performance.now();
      try {
        await downloadSourcePack(pack, archive);
      } finally {
        this.downloadMs += performance.now() - started;
      }
      // Objects saved after this pack are not in it: they are described and downloaded while the
      // pack unpacks, as soon as its header lists its blobs, instead of after it (fea47345 round 3).
      const written = await unpackSourcePackObjects(
        pack,
        archive,
        unpacked,
        blob => wanted.has(blob) || (this.machine !== null && !checkoutPathExists(join(this.machine, blob))),
        undefined,
        listed => {
          after = missing.filter(id => !listed.has(id));
          early = this.fetchMissing(after);
          early.catch(() => undefined);
        },
      ).catch(async error => {
        await early?.catch(() => undefined);
        throw error;
      });
      await checkoutIo(() => rm(archive, { force: true }));
      await mapCheckoutIo(written, async id => {
        const path = join(unpacked, id);
        if (this.objects !== this.machine) await rememberObject(this.machine, path, id);
        if (wanted.has(id) || this.objects === this.machine) await rename(path, join(this.objects, id));
      });
      for (const id of written) if (wanted.delete(id)) this.packObjects++;
      this.packBytes = pack.size;
      this.sourcePack = 'used';
      await early;
      for (const id of after) wanted.delete(id);
      return missing.filter(id => wanted.has(id));
    } catch {
      // A failed early download fails the checkout (it rethrows here), as it would after the
      // pack; a failed pack falls back to pages for everything the early downloads did not store.
      await early;
      this.sourcePack = 'failed';
      const fetched = new Set(after);
      return missing.filter(id => !fetched.has(id));
    } finally {
      await checkoutIo(async () => rmSync(temporary, { recursive: true, force: true }));
    }
  }
}
