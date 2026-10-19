// SPDX-License-Identifier: Apache-2.0
import {
  mkdtempSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { invariant } from './errors.js';
// One rename publishes a complete retry payload. A partial staging directory is
// never interpreted as a committed request, and concurrent originals cannot be replaced.
export function commitExchangeDirectory(directory: string, files: Record<string, string | Buffer>) {
  const parent = dirname(directory),
    temporary = mkdtempSync(join(parent, `.${basename(directory)}-preparing-`));
  try {
    for (const [name, bytes] of Object.entries(files)) {
      const fd = openSync(join(temporary, name), 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    let fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, directory);
    } catch (error) {
      if (!existsSync(directory)) throw error;
      invariant(
        Object.entries(files).every(
          ([name, bytes]) =>
            existsSync(join(directory, name)) &&
            readFileSync(join(directory, name)).equals(Buffer.from(bytes)),
        ),
        'WORK_OPERATION_CHANGED',
        'A concurrent exchange retained different original bytes.',
      );
    }
    fd = openSync(parent, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
