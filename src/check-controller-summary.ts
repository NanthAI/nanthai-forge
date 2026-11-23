// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableReplace } from './state/durability.js';
/** Controller diagnostics are a bounded summary, never provider command output. */
export function appendControllerSummary(directory: string, line: string) {
  const path = join(directory, 'controller-summary.txt');
  let previous = '';
  try {
    previous = readFileSync(path, 'utf8');
  } catch {
    /* First observation. */
  }
  durableReplace(path, (previous + line + '\n').slice(-4096));
}
