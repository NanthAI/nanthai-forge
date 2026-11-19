// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Journey walkthroughs (docs/ux/journeys) quote the UI as it was observed and are not scanned.
 * Naming decision (Issue a4c5394c, PRODUCT.md): Approve names a person's yes on something held; grant
 * and accept are retired as names for that yes (wire values such as status "granted" stay). */
const retired = [
  /\bgrants? or declines?\b/i,
  /\bgranted (Lane|the)\b/,
  /\buntil (they|you) grant\b/i,
  /'Grant this Lane\?'|accept: 'Grant'/,
  /Accept into main/,
  /Accept this landing/,
  /\bperson accepts it\b/i,
  /\bowner accepts (submission|it\b|on the review|\.|or declines)/i,
  /\bthe owner accepts\.(?!\w)/,
];
const roots = ['src', 'convex', 'web/src', 'skills', 'docs/agents', 'docs/operations', 'docs/security.d'];
const files = [];
const walk = path => {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (name === '_generated' || name === 'node_modules') continue;
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx|md|mjs)$/.test(name)) files.push(full);
  }
};
for (const root of roots) walk(root);
files.push('docs/access.md', 'PRODUCT.md', 'README.md');

test('CLI help, server replies, web and docs name the owner yes Approve, never grant or accept (Issue a4c5394c)', () => {
  const hits = files.flatMap(file =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        retired.some(pattern => pattern.test(line)) ? [`${file}:${index + 1}`] : [],
      ),
  );
  assert.deepEqual(hits, [], 'say "approve" for a person\'s decision on something held');
});
