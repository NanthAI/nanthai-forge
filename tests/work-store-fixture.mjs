// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { readRecords, recordManifest } from '../dist/work-records.js';

// Assertions compare portable logical snapshots, independent of the local disk layout.
export function readWorkBytes(path, options) {
  const bytes = readFileSync(path);
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* Opaque fixture bytes. */
  }
  const manifest = recordManifest(raw);
  const value = manifest
    ? Buffer.from(JSON.stringify(readRecords(realpathSync(dirname(path)), manifest), null, 2))
    : bytes;
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? value.toString(encoding) : value;
}
