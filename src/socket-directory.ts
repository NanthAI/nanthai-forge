// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** macOS limits a Unix socket path to 104 bytes including the terminator (Linux 108). Stay under
 * the smaller one with a margin; longer paths fail `listen` with EINVAL. */
export const SOCKET_PATH_LIMIT = 100;
const SUFFIX = 6; // mkdtemp appends six random characters
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Real directories that can hold a socket directory: TMPDIR first (resolved, as on macOS where
 * /var is a link that adds eight bytes), then the short system root. */
export const socketCandidates = () => [
  real(tmpdir()),
  ...(process.platform === 'win32' ? [] : [real('/tmp')]),
];

/** The candidates where a socket named `name` in a `prefix` directory fits; TMPDIR alone when none does. */
export function socketRoots(prefix: string, name: string): string[] {
  const roots = socketCandidates();
  const need = Buffer.byteLength(join(prefix + 'x'.repeat(SUFFIX), name)) + 1;
  const fits = roots.filter(root => Buffer.byteLength(root) + need <= SOCKET_PATH_LIMIT);
  return [...new Set(fits.length ? fits : [roots[0]!])];
}

/** A private directory for a Unix socket named `name`, under TMPDIR when the path fits and under a
 * short system root when TMPDIR is nested too deeply (clean preflight, CI, long macOS TMPDIR). */
export function socketDirectory(prefix: string, name: string) {
  return mkdtempSync(join(socketRoots(prefix, name)[0]!, prefix));
}

/** Whether `directory` is one this module made for `prefix`, whichever root it landed in. */
export function isSocketDirectory(directory: string, prefix: string) {
  return basename(directory).startsWith(prefix) && socketCandidates().includes(dirname(directory));
}
