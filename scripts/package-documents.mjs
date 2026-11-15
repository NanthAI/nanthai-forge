// SPDX-License-Identifier: Apache-2.0
// One explicit manifest per public document; private output is never globbed into a package.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readPackageDocuments(
  directory = fileURLToPath(new URL('./package-documents/', import.meta.url)),
  { data = false } = {},
) {
  const entries = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        assert.ok(entry.isFile() && entry.name.endsWith('.json'), `Invalid document manifest: ${file}`);
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        const expected = `docs/${relative(directory, file)
          .replaceAll('\\', '/')
          .replace(/\.json$/, '.md')}`;
        assert.equal(manifest.path, expected, `Document manifest path must match its filename: ${file}`);
        assert.ok(
          manifest.data === undefined || manifest.data === true,
          `Invalid companion data flag: ${file}`,
        );
        assert.ok(
          Number.isSafeInteger(manifest.order) && manifest.order >= 0,
          `Invalid document order: ${file}`,
        );
        entries.push(manifest);
      }
    }
  }
  walk(directory);
  return entries
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path, 'en'))
    .filter(entry => !data || entry.data)
    .map(entry => (data ? entry.path.replace(/\.md$/, '.json') : entry.path));
}

export const packageDocuments = readPackageDocuments();
// A data companion is opt-in and must share its public document's exact stem.
export const packageDocumentData = readPackageDocuments(undefined, { data: true });
