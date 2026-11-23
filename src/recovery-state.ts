// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { closeSync, openSync, fsyncSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncDirectory } from './state/durability.js';

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
  syncDirectory(dirname(path));
}
