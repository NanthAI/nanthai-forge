// SPDX-License-Identifier: Apache-2.0
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  realpathSync as systemRealpath,
  createReadStream,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { sourceLanguage } from './languages.js';

export { safeRelative } from './safe-relative.js';
import { safeRelative } from './safe-relative.js';
/** Same canonical path checks, with Node's faster native resolver on macOS. */
export function sourceRealpath(path: string) {
  return process.platform === 'darwin' && systemRealpath.native
    ? systemRealpath.native(path)
    : systemRealpath(path);
}
export function exclusion(path: string): string | null {
  const parts = path.toLowerCase().split('/');
  if (
    parts.some(p =>
      [
        '.git',
        '.forge',
        '.netlify',
        '.next',
        'node_modules',
        'dist',
        'build',
        'coverage',
        'private-artifacts',
        '.ssh',
        '.aws',
        '.azure',
        '.gnupg',
      ].includes(p),
    )
  )
    return 'protected-directory';
  const name = parts.at(-1) ?? '';
  if (
    /^(\.env($|\.)|\.npmrc$|\.netrc$|credentials?([.-]|$)|secrets?([.-]|$))/.test(name) ||
    /\.(pem|key|p12|pfx|keystore)$/.test(name)
  )
    return 'sensitive-name';
  return null;
}

/** Source capture/publication keeps modules and exact env templates, unlike analysis. */
export function sourceExclusion(path: string): string | null {
  const reason = exclusion(path);
  if (reason !== 'sensitive-name') return reason;
  const name = path.split('/').at(-1) ?? '';
  if (
    (/^(credentials?|secrets?)[.-]/i.test(name) && sourceLanguage(path)) ||
    /(?:^|\.)env\.(example|sample|template)$/i.test(name)
  )
    return null;
  return reason;
}

export function readSource(
  root: string,
  path: string,
  maxBytes: number,
  expectedDigest?: string,
): Buffer | null {
  invariant(safeRelative(path), 'UNSAFE_PATH', 'Source path must be a relative contained path.');
  const absolute = join(root, path);
  let current = root;
  try {
    for (const part of path.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    const resolved = sourceRealpath(absolute);
    const contained = relative(root, resolved);
    invariant(
      contained !== '..' && !contained.startsWith(`..${sep}`) && !isAbsolute(contained),
      'UNSAFE_PATH',
      'Source path escapes the worktree.',
    );
    const fd = openSync(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink > 1) return null;
      invariant(
        before.size <= maxBytes,
        'FILE_LIMIT',
        'An included source file exceeds the configured byte limit.',
      );
      const read = () => {
        const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, length);
          if (count === 0) break;
          length += count;
        }
        const bytes = buffer.subarray(0, length);
        invariant(
          bytes.length <= maxBytes,
          'FILE_LIMIT',
          'An included source file grew beyond the configured byte limit.',
        );
        return bytes;
      };
      const data = read();
      let after = fstatSync(fd);
      const sameAuthority = (a: typeof before, b: typeof before) =>
        a.size === b.size && a.mode === b.mode && a.nlink === b.nlink && a.dev === b.dev && a.ino === b.ino;
      const sameContentMetadata = (a: typeof before, b: typeof before) =>
        sameAuthority(a, b) && a.mtimeMs === b.mtimeMs;
      const timestampsChanged = before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
      // Preserve immutable native identities' timestamp-normalization support.
      // The expected digest authenticates the bytes; timestamps do not own them.
      const immutableHydration =
        timestampsChanged &&
        Boolean(expectedDigest) &&
        sameAuthority(before, after) &&
        createHash('sha256').update(data).digest('hex') === expectedDigest;
      invariant(
        sameAuthority(before, after) &&
          data.length === after.size &&
          (sameContentMetadata(before, after) || immutableHydration),
        'SOURCE_CHANGED',
        'Source changed while being read; retry indexing.',
      );
      if (timestampsChanged) {
        // Timestamp hydration needs identical bytes on a complete second read,
        // with stable authority, mtime and settled ctime on the same descriptor.
        const repeated = read(),
          final = fstatSync(fd);
        invariant(
          data.equals(repeated) && sameContentMetadata(after, final) && after.ctimeMs === final.ctimeMs,
          'SOURCE_CHANGED',
          'Source changed while being read; retry indexing.',
        );
        if (expectedDigest)
          invariant(
            createHash('sha256').update(data).digest('hex') === expectedDigest,
            'SOURCE_CHANGED',
            'Source changed while being read; retry indexing.',
          );
        after = final;
      }
      const located = lstatSync(absolute);
      invariant(
        located.isFile() &&
          !located.isSymbolicLink() &&
          sameAuthority(after, located) &&
          sameContentMetadata(after, located) &&
          after.ctimeMs === located.ctimeMs &&
          sourceRealpath(absolute) === resolved,
        'SOURCE_CHANGED',
        'Source changed while being read; retry indexing.',
      );
      return data;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new ForgeError('SOURCE_READ_FAILED', 'A source file could not be read safely.');
  }
}

export async function fingerprintPrivateFile(path: string, code = 'INVALID_FILE_EXPORT') {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new ForgeError(
      code,
      'The retained file is unavailable for safe export. Existing data is preserved.',
    );
  }
  try {
    const before = fstatSync(fd);
    invariant(
      before.isFile() && before.nlink === 1 && !(before.mode & 0o077),
      code,
      'The retained file must be an owner-only regular file.',
    );
    const hashFile = async () => {
      const hash = createHash('sha256');
      if (before.size <= 64 * 1024) {
        // Most checkout objects are tiny. Avoid a stream's buffers/listeners for
        // each one; the same descriptor and metadata checks below still apply.
        const bytes = Buffer.allocUnsafe(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          invariant(
            count > 0,
            code,
            'The retained file ended during validation. Existing source is preserved.',
          );
          offset += count;
        }
        hash.update(bytes);
      } else
        for await (const bytes of createReadStream(path, { fd, start: 0, autoClose: false }))
          hash.update(bytes);
      return hash.digest('hex');
    };
    const sameContentMetadata = (a: typeof before, b: typeof before) =>
      a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode && a.nlink === b.nlink;
    const sha256 = await hashFile();
    const after = fstatSync(fd);
    invariant(
      sameContentMetadata(before, after),
      code,
      'The retained file changed during validation. Existing source is preserved.',
    );
    let final = after;
    if (before.ctimeMs !== after.ctimeMs) {
      // Metadata-only timestamp changes need an identical second read, never an unchecked retry.
      const repeated = await hashFile();
      final = fstatSync(fd);
      invariant(
        repeated === sha256 && sameContentMetadata(after, final) && after.ctimeMs === final.ctimeMs,
        code,
        'The retained file changed during validation. Existing source is preserved.',
      );
    }
    let located;
    try {
      located = lstatSync(path);
    } catch {
      throw new ForgeError(
        code,
        'The retained file changed during validation. Existing source is preserved.',
      );
    }
    invariant(
      located.isFile() &&
        located.dev === before.dev &&
        located.ino === before.ino &&
        sameContentMetadata(final, located) &&
        final.ctimeMs === located.ctimeMs,
      code,
      'The retained file changed during validation. Existing source is preserved.',
    );
    return { sha256, size: before.size };
  } finally {
    closeSync(fd);
  }
}
