// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The existing Actions executor prepares every Candidate with npm ci. These
 * dependency-free manifests let the tiny source check use that unmodified path. */
export function prepareActionsDrillFiles(root) {
  const identity = { name: 'forge-q4-synthetic-check', version: '1.0.0' };
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...identity, private: true }) + '\n');
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      ...identity,
      lockfileVersion: 3,
      requires: true,
      packages: { '': identity },
    }) + '\n',
  );
}
