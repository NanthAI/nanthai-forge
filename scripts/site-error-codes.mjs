// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Digest of the public error codes in src/, convex/ and site/ (the error reference lists them),
// kept in its own helper so pure site-deploy-plan/forge-deploy-ci tests never statically import
// check-growth.mjs or walk convex/.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { errorCodes } from './check-growth.mjs';

export function errorCodeDigest(root) {
  const codes = new Set();
  const scan = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name === '_generated' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.(?:ts|mts)$/.test(entry.name))
        for (const code of errorCodes(readFileSync(join(root, path), 'utf8'))) codes.add(code);
    }
  };
  for (const directory of ['src', 'convex', 'site']) scan(directory);
  return createHash('sha256')
    .update([...codes].sort().join('\n'))
    .digest('hex');
}
