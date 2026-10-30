// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageDocuments, readPackageDocuments } from '../scripts/package-documents.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-document-manifests-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (name, manifest) => {
    const path = join(directory, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(manifest));
  };
  return { directory, put };
}

test('parallel documentation additions own separate manifests and preserve inventory order', t => {
  const { directory, put } = fixture(t);
  put('first.json', { path: 'docs/first.md', order: 0 });
  put('operations/b.json', { path: 'docs/operations/b.md', order: 1 });
  put('operations/a.json', { path: 'docs/operations/a.md', order: 1 });
  assert.deepEqual(readPackageDocuments(directory), [
    'docs/first.md',
    'docs/operations/a.md',
    'docs/operations/b.md',
  ]);
  assert.equal(packageDocuments.length, new Set(packageDocuments).size);
  assert.equal(packageDocuments[0], 'docs/README.md');
});

test('a document manifest cannot redirect its filename to private or different source', t => {
  const { directory, put } = fixture(t);
  for (const path of ['../private.md', 'docs/other.md', '/tmp/private.md']) {
    put('public.json', { path, order: 0 });
    assert.throws(() => readPackageDocuments(directory), /path must match/);
  }
  put('public.json', { path: 'docs/public.md', order: -1 });
  assert.throws(() => readPackageDocuments(directory), /Invalid document order/);
});
