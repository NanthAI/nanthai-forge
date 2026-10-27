// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableReplace } from './native-durability.js';
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
