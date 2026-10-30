// SPDX-License-Identifier: Apache-2.0
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, sep } from 'node:path';
import { safeRelative } from './files.js';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';

const authority = (a: Stats, b: Stats) =>
  a.size === b.size && a.mode === b.mode && a.nlink === b.nlink && a.dev === b.dev && a.ino === b.ino;
const content = (a: Stats, b: Stats) => authority(a, b) && a.mtimeMs === b.mtimeMs;
/** Descriptor-scoped bounded reads. Nothing survives as proof for a later operation. */
export class SourceFileReader {
  private readonly fd: number;
  private readonly before: Stats;
  private readonly path: string;
  private readonly resolved: string;
  readonly size: number;
  constructor(
    root: string,
    path: string,
    private readonly code = 'EXCHANGE_SOURCE_CHANGED',
  ) {
    invariant(safeRelative(path), 'UNSAFE_PATH', 'Source path must be a relative contained path.');
    root = realpathSync(root);
    this.path = join(root, path);
    try {
      let current = root;
      for (const part of path.split('/')) {
        current = join(current, part);
        invariant(!lstatSync(current).isSymbolicLink(), code, 'Selected source is redirected.');
      }
      this.resolved = realpathSync(this.path);
      const contained = relative(root, this.resolved);
      invariant(
        contained !== '..' && !contained.startsWith(`..${sep}`) && !isAbsolute(contained),
        'UNSAFE_PATH',
        'Source path escapes its owner.',
      );
      this.fd = openSync(
        this.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        this.before = fstatSync(this.fd);
        invariant(
          this.before.isFile() && this.before.nlink === 1,
          code,
          'Selected source must be an independent regular file.',
        );
        this.size = this.before.size;
      } catch (error) {
        closeSync(this.fd);
        throw error;
      }
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError(code, 'Selected source is unavailable for a safe read.');
    }
  }
  close() {
    closeSync(this.fd);
  }
  private located(observed: Stats) {
    let located: Stats;
    try {
      located = lstatSync(this.path);
    } catch {
      throw new ForgeError(this.code, 'Selected source disappeared during its read.');
    }
    invariant(
      located.isFile() &&
        !located.isSymbolicLink() &&
        content(observed, located) &&
        observed.ctimeMs === located.ctimeMs &&
        realpathSync(this.path) === this.resolved,
      this.code,
      'Selected source changed during its read.',
    );
  }
  scan(visit: (bytes: Buffer, offset: number) => void, expectedDigest?: string, scratch?: Buffer) {
    const buffer = scratch ?? Buffer.allocUnsafe(1024 * 1024);
    invariant(buffer.length > 0, this.code, 'A source scan needs a non-empty read buffer.');
    const pass = (visitor?: typeof visit) => {
      const hash = createHash('sha256');
      let offset = 0;
      while (offset < this.size) {
        const length = readSync(this.fd, buffer, 0, Math.min(buffer.length, this.size - offset), offset);
        invariant(length > 0, this.code, 'Selected source ended before its original length.');
        const bytes = buffer.subarray(0, length);
        hash.update(bytes);
        visitor?.(bytes, offset);
        offset += length;
      }
      return hash.digest('hex');
    };
    const sha256 = pass(visit),
      after = fstatSync(this.fd);
    const changed = this.before.mtimeMs !== after.mtimeMs || this.before.ctimeMs !== after.ctimeMs;
    invariant(
      authority(this.before, after) && (content(this.before, after) || expectedDigest === sha256),
      this.code,
      'Selected source changed during its read.',
    );
    let final = after;
    if (changed) {
      const repeated = pass();
      final = fstatSync(this.fd);
      invariant(
        repeated === sha256 && content(after, final) && after.ctimeMs === final.ctimeMs,
        this.code,
        'Selected source changed during its repeated read.',
      );
    }
    this.located(final);
    invariant(
      !expectedDigest || sha256 === expectedDigest,
      this.code,
      'Selected source differs from its original digest.',
    );
    return { sha256, size: this.size };
  }
  read(offset: number, size: number, sha256: string) {
    invariant(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(size) &&
        size >= 0 &&
        offset + size <= this.size,
      this.code,
      'Selected source range is invalid.',
    );
    const bytes = Buffer.allocUnsafe(size);
    let length = 0;
    while (length < size) {
      const count = readSync(this.fd, bytes, length, size - length, offset + length);
      invariant(count > 0, this.code, 'Selected source range disappeared.');
      length += count;
    }
    const after = fstatSync(this.fd);
    invariant(
      authority(this.before, after) && digest(bytes) === sha256,
      this.code,
      'Selected source range differs from its original digest.',
    );
    this.located(after);
    return bytes;
  }
}
