// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Local advisory observations are atomically visible, but do not require a
 * durable writer transaction. States and acknowledgement Work notes remain durable. */
export function writeEditObservation(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* A failed observation is retried by the hook. */
    }
    throw error;
  }
}
