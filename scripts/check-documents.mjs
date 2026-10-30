// SPDX-License-Identifier: Apache-2.0
// Validate packaged prose and original notice hashes without builds or CLI execution.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { packageDocuments } from './package-documents.mjs';
import { componentManifestSha256, backendLicenseSha256 } from './selfhost-notices.mjs';
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
for (const path of packageDocuments) {
  assert.ok(existsSync(path), `Missing packaged document: ${path}`);
  assert.ok(
    manifest.files.some(entry => path === entry || path.startsWith(`${entry}/`)),
    `Document omitted from package: ${path}`,
  );
}
const root = 'docs/vendor-notices/native-components';
const bytes = readFileSync(`${root}/manifest.json`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(bytes), componentManifestSha256, 'Original component notice manifest changed');
const components = JSON.parse(bytes);
assert.equal(hash(readFileSync('docs/vendor-notices/convex-backend-LICENSE.md')), backendLicenseSha256);
assert.equal(hash(readFileSync(`${root}/PARTIAL.md`)), components.disclosure.sha256);
const expected = new Set([
  ...packageDocuments,
  'docs/vendor-notices/convex-backend-LICENSE.md',
  `${root}/manifest.json`,
  `${root}/PARTIAL.md`,
  ...components.originals.map(item => `${root}/${item.path}`),
]);
function inventory(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) inventory(path);
    else
      assert.ok(
        expected.has(path),
        `Unlisted packaged document: ${path}. Add its manifest under scripts/package-documents/.`,
      );
  }
}
inventory('docs');
for (const item of components.originals)
  assert.equal(hash(readFileSync(`${root}/${item.path}`)), item.sha256, item.path);
console.log(
  `Packaged documentation inventory and ${components.originals.length} original notice hashes verified.`,
);
