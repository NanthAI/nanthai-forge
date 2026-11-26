// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
import { parseSecretExample } from './secret-names.js';

export { parseSecretExample, type SecretNameNotice } from './secret-names.js';

/** Exact case and a real regular file keep the allow-list under the protected path.
 * O_NOFOLLOW plus inode comparison also refuses a link substituted between lookup/open. */
export function readSecretExample(root: string) {
  const { names, notices } = readSecretExampleFile(root);
  return { names, notices };
}
/** readSecretExample plus the exact text it parsed ('' when there is no file), so a writer replaces what it read. */
export function readSecretExampleFile(root: string) {
  let fd: number | undefined;
  try {
    const entries = readdirSync(root);
    if (!entries.includes('.env.example')) {
      return {
        text: '',
        names: [],
        notices: entries
          .filter(name => name.toLowerCase() === '.env.example')
          .map(name => ({
            name,
            reason: 'not read; use the exact name .env.example',
          })),
      };
    }
    const path = join(root, '.env.example');
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink())
      throw new ForgeError(
        'SECRETS_ENV_EXAMPLE_NOT_FILE',
        '.env.example must be a regular file, never a link.',
      );
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile())
      throw new ForgeError('SECRETS_ENV_EXAMPLE_NOT_FILE', '.env.example must be a regular file.');
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new ForgeError('UNSAFE_PATH', '.env.example changed while opening it; run again.');
    const text = readFileSync(fd, 'utf8');
    return { text, ...parseSecretExample(text) };
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new ForgeError(
        'SECRETS_ENV_EXAMPLE_NOT_FILE',
        '.env.example must be a regular file, never a link.',
      );
    throw new ForgeError('UNSAFE_PATH', '.env.example could not be read as a regular file.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
