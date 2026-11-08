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
import { codeFileName } from './code-files.js';

export { safeRelative } from './safe-relative.js';
import { safeRelative } from './safe-relative.js';
/** Same canonical path checks, with Node's faster native resolver on macOS. */
export function sourceRealpath(path: string) {
  return process.platform === 'darwin' && systemRealpath.native
    ? systemRealpath.native(path)
    : systemRealpath(path);
}
/** VCS and Forge metadata, and Forge's private evidence folder: never source or published. */
const metadataDirectories = ['.git', '.forge', 'private-artifacts'];
/** Credential stores that a repository never means to publish. */
const credentialDirectories = ['.ssh', '.aws', '.azure', '.gnupg'];
/** Analysis also skips build output and other generated trees by name. Capture and
 * publication never do: they follow `.gitignore`/`.forgeignore`, so a Go `cmd/build`
 * package or a tracked `build/x.sh` is source (see `captureExclusion`). */
const analysisDirectories = [
  ...metadataDirectories,
  '.netlify',
  '.next',
  'node_modules',
  'dist',
  'build',
  'coverage',
  ...credentialDirectories,
];
const sensitiveName = (name: string) =>
  /^(\.env($|\.)|\.npmrc$|\.netrc$|credentials?([.-]|$)|secrets?([.-]|$))/.test(name) ||
  /\.(pem|key|p12|pfx|keystore)$/.test(name);
/** `credentials*`/`secrets*` names that are code modules or packages, never credential values. */
const credentialStem = /^(credentials?|secrets?)([.-]|$)/i;

/** Analysis policy (code maps, presence, document reads): skips generated trees too. */
export function exclusion(path: string): string | null {
  const parts = path.toLowerCase().split('/');
  if (parts.some(p => analysisDirectories.includes(p))) return 'protected-directory';
  if (sensitiveName(parts.at(-1) ?? '')) return 'sensitive-name';
  return null;
}

/** Source capture/publication of a path that is already source: only VCS/Forge metadata,
 * credential stores and real credential names are excluded, in every language. Code modules
 * named `credentials.*`/`secrets.*` and exact env templates are kept. Build folders are
 * excluded only by ignore rules. O(path), no filesystem reads. */
export function sourceExclusion(path: string): string | null {
  const parts = path.toLowerCase().split('/');
  if (parts.some(p => metadataDirectories.includes(p) || credentialDirectories.includes(p)))
    return 'protected-directory';
  const name = path.split('/').at(-1) ?? '';
  if (!sensitiveName(name.toLowerCase())) return null;
  if (
    (credentialStem.test(name) && codeFileName.test(name)) ||
    /(?:^|\.)env\.(example|sample|template)$/i.test(name)
  )
    return null;
  return 'sensitive-name';
}

/** Publication (GitHub mirror and sync) of tracked source: a tracked file is published, like
 * on GitHub, whatever its name (`key1.pem`, `.npmrc`, `.env.development`). Only VCS/Forge
 * metadata and Forge's `private-artifacts` stay out. Credentials are caught by content (the
 * landing secret scan, and the capture check for new files), never by name. O(path). */
export function publicationExclusion(path: string): string | null {
  return path
    .toLowerCase()
    .split('/')
    .some(p => metadataDirectories.includes(p))
    ? 'protected-directory'
    : null;
}

/** New files whose purpose is local credentials: never saved by a content guess. */
export const localCredentialName = (name: string) => /^(\.env(\.local|\..+\.local)?|\.netrc)$/i.test(name);

/** What a new, untracked path's own name excludes from capture before ignore rules apply.
 * Adds to `sourceExclusion`: `node_modules` (dependency installs; Forge links one into
 * every Lane), `.env*` directories (virtualenvs and env stores), and non-code files inside a
 * `credentials`/`secrets` directory. A code package with such a name (`internal/secrets/`)
 * is walked and its code captured. Tracked paths are kept regardless. O(path). */
export function captureExclusion(path: string, directory: boolean): string | null {
  const parts = path.split('/'),
    lower = parts.map(part => part.toLowerCase());
  if (lower.includes('node_modules')) return 'protected-directory';
  if (directory) {
    if (lower.some(p => metadataDirectories.includes(p) || credentialDirectories.includes(p)))
      return 'protected-directory';
    const name = lower.at(-1) ?? '';
    return sensitiveName(name) && !credentialStem.test(name) ? 'sensitive-name' : null;
  }
  const reason = sourceExclusion(path);
  if (reason) return reason;
  if (lower.slice(0, -1).some(part => credentialStem.test(part)) && !codeFileName.test(parts.at(-1) ?? ''))
    return 'sensitive-name';
  return null;
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

export async function fingerprintPrivateFile(
  path: string,
  code = 'INVALID_FILE_EXPORT',
  observe?: (bytes: Buffer) => void,
) {
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
        observe?.(bytes);
      } else
        for await (const bytes of createReadStream(path, { fd, start: 0, autoClose: false })) {
          hash.update(bytes);
          observe?.(bytes);
        }
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
