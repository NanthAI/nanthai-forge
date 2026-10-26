// SPDX-License-Identifier: Apache-2.0
// Explicit release preparation only. Ordinary checks never update the baseline.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateSnapshot } from './schema-snapshot.mjs';
import { snapshotPath, checkSchemaCompatibility } from './check-schema-compat.mjs';

export function refreshSchemaSnapshot(root) {
  // Do not erase evidence of an undeclared breaking change by refreshing first.
  const { undeclared } = checkSchemaCompatibility(root);
  if (undeclared.length)
    throw new Error(`Declare migrations before refresh: ${undeclared.map(issue => issue.path).join(', ')}`);
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const snapshot = generateSnapshot(root, undefined, version);
  const target = resolve(root, snapshotPath),
    temporary = `${target}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(temporary, target);
  return snapshot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    refreshSchemaSnapshot(process.cwd());
    console.log(`Refreshed ${snapshotPath}; commit this release baseline with the source.`);
  } catch (error) {
    console.error(`SCHEMA_SNAPSHOT_INVALID: ${error.message}`);
    process.exitCode = 1;
  }
}
