// SPDX-License-Identifier: Apache-2.0
// Explicit release preparation only (needs dist/: npm run build:core first). Ordinary checks never
// update the baseline. Refuses while a change would break released CLIs and is not declared.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { checkResponseCompatibility, responseSnapshot, responseSnapshotPath } from './response-compat.mjs';

export async function refreshResponseSnapshot(root) {
  const { undeclared } = await checkResponseCompatibility(root);
  if (undeclared.length)
    throw new Error(
      `Declare feature-gated changes before refresh: ${undeclared.map(issue => issue.path).join(', ')}`,
    );
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const snapshot = await responseSnapshot(root, version);
  const target = resolve(root, responseSnapshotPath),
    temporary = `${target}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(temporary, target);
  return snapshot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await refreshResponseSnapshot(process.cwd());
    console.log(`Refreshed ${responseSnapshotPath}; commit this release baseline with the source.`);
  } catch (error) {
    console.error(`RESPONSE_SNAPSHOT_INVALID: ${error.message}`);
    process.exitCode = 1;
  }
}
