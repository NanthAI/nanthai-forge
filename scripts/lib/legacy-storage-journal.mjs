// SPDX-License-Identifier: Apache-2.0
import { open, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncDirectory } from '../../dist/state/durability.js';
/** Fsync the exact original mutation request before it can be sent. */
export async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`,
    file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  syncDirectory(dirname(path));
}
