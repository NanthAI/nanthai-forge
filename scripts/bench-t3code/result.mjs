// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** All cell outcomes retain the gate evidence, including refusals; results are write-once. */
export function writeCellResult(directory, result, extra) {
  const file = join(directory, 'result.json');
  if (existsSync(file)) return;
  writeFileSync(file, JSON.stringify({ ...result, ...extra }, null, 1) + '\n', { flag: 'wx' });
}
