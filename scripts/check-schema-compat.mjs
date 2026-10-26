// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSnapshot } from './schema-snapshot.mjs';
import { compareSnapshots, undeclaredChanges } from './schema-compat.mjs';

export const snapshotPath = 'scripts/schema-compat/released.json';
export const migrationsPath = 'scripts/schema-compat/declared-migrations.json';
export function checkSchemaCompatibility(root) {
  const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const released = read(snapshotPath),
    current = generateSnapshot(root);
  const issues = compareSnapshots(released, current);
  return {
    issues,
    undeclared: undeclaredChanges(issues, read(migrationsPath)),
    schemas: Object.keys(current.schemas).length,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = performance.now();
  try {
    const result = checkSchemaCompatibility(process.cwd());
    for (const issue of result.undeclared)
      console.error(
        `SCHEMA_INCOMPATIBLE ${issue.path}: ${issue.detail}\n  migration: ${JSON.stringify({ path: issue.path, change: issue.change, reason: 'Describe the migration' })}`,
      );
    if (result.undeclared.length) process.exitCode = 1;
    else
      console.log(
        `Schema compatibility passed: ${result.schemas} schemas; ${result.issues.length} declared changes (${((performance.now() - started) / 1000).toFixed(2)}s).`,
      );
  } catch (error) {
    console.error(`SCHEMA_COMPAT_INVALID: ${error.message}`);
    process.exitCode = 1;
  }
}
