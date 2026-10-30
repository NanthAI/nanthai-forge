// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { moduleUrl } from './convex-module.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { digest } from '../dist/hash.js';
const { storeSourceBytes } = await import(moduleUrl('../convex/projectSourceBytes.ts'));
const { mirrorSource } = await import(moduleUrl('../convex/projectGithubMirror.ts'));

test('Convex byte stores stay behind explicit legacy-placement seams', () => {
  const allow = {
    'projectSourceBytes.ts': 'Only the R2-off branch; the R2 runtime test forbids storage.store.',
    'projectGithubImportUpload.ts':
      'Resume an original prepared Convex destination after an unknown upload outcome; new R2-mode reservations never select this branch.',
  };
  const found = new Set();
  for (const name of readdirSync(new URL('../convex', import.meta.url)).filter(x => x.endsWith('.ts'))) {
    const file = ts.createSourceFile(
      name,
      readFileSync(new URL(`../convex/${name}`, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
    );
    const visit = node => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'store'
      ) {
        const receiver = node.expression.expression;
        if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'storage') {
          assert(allow[name], `${name}: raw storage.store bypasses deployment placement`);
          found.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  assert.deepEqual([...found].sort(), Object.keys(allow).sort());
});

test('R2 check selections are reused by digest without another upload or Convex store', async t => {
  const r2 = fakeSourceR2(t),
    bytes = Buffer.from(JSON.stringify({ tests: ['test-a', 'test-b'] }));
  const pin = { sha256: digest(bytes), size: bytes.length },
    ctx = {
      storage: {
        store() {
          assert.fail('R2 check plan called storage.store');
        },
      },
    };
  const first = await storeSourceBytes(ctx, 'project', bytes, pin, true);
  assert.deepEqual(await storeSourceBytes(ctx, 'project', bytes, pin, true), first);
  assert.equal(r2.requests.filter(x => x === 'PUT').length, 1);
  assert.equal(r2.objects.size, 1);
});

test('a backfilled mirror object never reads the retained Convex copy', async t => {
  const r2 = fakeSourceR2(t),
    bytes = Buffer.from('mirror source'),
    sha256 = digest(bytes),
    key = `v1/p/project/o/${sha256}`;
  r2.objects.set(`/synthetic/${key}`, bytes);
  const ctx = {
    storage: {
      get() {
        assert.fail('R2 mirror read Convex bytes');
      },
    },
    async runQuery() {
      return JSON.stringify([
        {
          descriptor: { object: { sha256, size: bytes.length }, recipe: null },
          storageId: 'retained-legacy-copy',
          url: `https://synthetic.r2.cloudflarestorage.com/synthetic/${key}`,
        },
      ]);
    },
  };
  const [blob] = await mirrorSource(ctx, { jobId: 'job', step: 0 }).blobs([sha256]);
  assert.deepEqual(await blob.read(), bytes);
});
