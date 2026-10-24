// SPDX-License-Identifier: Apache-2.0
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { lstatSync, readlinkSync } from 'node:fs';
import { invariant } from './errors.js';
import { randomUUID, createHash } from 'node:crypto';

export const releaseHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function releaseWrite(path: string, bytes: string | Buffer, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}`;
  const fd = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export const releaseJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
export const releaseSave = (path: string, value: unknown) => releaseWrite(path, JSON.stringify(value) + '\n');
export const releaseQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

/** Snapshot the selection itself; replacing a link must never rewrite its target. */
export function releaseSelection(path: string) {
  try {
    const stat = lstatSync(path);
    invariant(
      stat.isFile() || stat.isSymbolicLink(),
      'BAD_ARGUMENT',
      'CLI selection must name a file, symlink or new path.',
    );
    const kind = stat.isSymbolicLink() ? ('symlink' as const) : ('file' as const);
    const bytes = kind === 'symlink' ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    return { exists: true, kind, mode: stat.mode & 0o777, sha256: releaseHash(bytes), bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      exists: false,
      kind: 'absent' as const,
      mode: 0o755,
      sha256: releaseHash(''),
      bytes: Buffer.alloc(0),
    };
  }
}
