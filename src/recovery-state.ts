// SPDX-License-Identifier: Apache-2.0
import { closeSync, openSync, fsyncSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeRecoveryState(path: string, value: unknown) {
  writeRecoveryText(path, JSON.stringify(value) + '\n');
}
export function writeRecoveryText(path: string, value: string) {
  const temporary = `${path}.${randomUUID()}`,
    fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, value);
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
