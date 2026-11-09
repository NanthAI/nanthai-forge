// SPDX-License-Identifier: Apache-2.0
// Needs dist/ (npm run build:core first). Ordinary checks never update a baseline.
// `npm run response:snapshot`: release preparation; refuses while a change would break released CLIs
// and is not declared. `npm run response:main`: after any reply-contract change, brings
// scripts/response-compat/main.json to the Candidate's contract; refuses while the change would
// break CLIs built from the previous main and is not declared (the landing check enforces both).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  checkResponseCompatibility,
  mainBaseline,
  replyBreakMessage,
  responseMainPath,
  responseSnapshot,
  responseSnapshotPath,
} from './response-compat.mjs';

export async function refreshResponseSnapshot(root, { main = false } = {}) {
  const checked = await checkResponseCompatibility(root);
  const undeclared = main ? checked.main.undeclared : checked.undeclared;
  if (undeclared.length)
    throw new Error(replyBreakMessage(undeclared, main ? mainBaseline : 'Released CLIs'));
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const snapshot = await responseSnapshot(root, main ? undefined : version);
  const target = resolve(root, main ? responseMainPath : responseSnapshotPath),
    temporary = `${target}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(temporary, target);
  return snapshot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const main = process.argv.includes('--main');
    await refreshResponseSnapshot(process.cwd(), { main });
    console.log(
      main
        ? `Refreshed ${responseMainPath}; it is saved with the source.`
        : `Refreshed ${responseSnapshotPath}; commit this release baseline with the source.`,
    );
  } catch (error) {
    console.error(`RESPONSE_SNAPSHOT_INVALID: ${error.message}`);
    process.exitCode = 1;
  }
}
