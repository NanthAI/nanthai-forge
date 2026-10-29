// SPDX-License-Identifier: Apache-2.0
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { syncDirectory, syncFile } from './native-durability.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import type { ContentPin } from './native-exchange.js';
export interface CheckoutObjectTransport {
  objects(digests: string[]): Promise<ContentPin[]>;
  downloadToFile(pin: ContentPin, path: string): Promise<void>;
  downloadFiles?(files: { pin: ContentPin; path: string }[]): Promise<void>;
}
/** Disposable bytes only; fresh selection/access checks remain the caller's responsibility. */
export class HostedCheckoutCache {
  downloadedObjects = 0;
  downloadedBytes = 0;
  readonly objects: string;
  constructor(
    readonly root: string,
    private readonly transport: CheckoutObjectTransport,
    objects = join(root, 'objects'),
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    invariant(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Client cache must be real.');
    this.objects = objects;
    mkdirSync(this.objects, { recursive: true, mode: 0o700 });
    invariant(!lstatSync(this.objects).isSymbolicLink(), 'UNSAFE_PATH', 'Client objects must be real.');
  }
  async ensure(ids: string[]) {
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const path = join(this.objects, id);
      if (checkoutPathExists(path)) {
        const stat = lstatSync(path);
        invariant(
          stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
          'UNSAFE_PATH',
          'Client object path must be a private regular file.',
        );
        const actual = await fingerprintPrivateFile(path);
        if (actual.sha256 === id) continue;
      }
      missing.push(id);
    }
    for (let at = 0; at < missing.length; at += 100) {
      const page = missing.slice(at, at + 100);
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
      for (const { pin, path } of files) {
        invariant(
          lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
          'INVALID_NATIVE_SOURCE',
          'Downloaded source must be a regular file.',
        );
        chmodSync(path, 0o600);
        const actual = await fingerprintPrivateFile(path);
        invariant(
          actual.sha256 === pin.sha256 && actual.size === pin.size,
          'INVALID_NATIVE_SOURCE',
          'Downloaded source is truncated or corrupt.',
        );
        syncFile(path);
        const target = join(this.objects, pin.sha256);
        renameSync(path, target);
        syncDirectory(dirname(target));
        this.downloadedObjects++;
        this.downloadedBytes += pin.size;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
