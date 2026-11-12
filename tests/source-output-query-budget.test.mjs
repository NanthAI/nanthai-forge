// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
const { takeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutputPages.ts'));
const { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));

test('source output staging bounds nested recipe lookups after dense retirement without losing a State', async t => {
  const f = recordsFixture();
  const { projectId } = await f.setup();
  await f.ctx.db.insert('projectObjectReceipts', {
    projectId,
    key: `source-points:${projectId}`,
    value: '2',
  });
  const leaves = [];
  for (let index = 0; index < 100; index++) {
    const sha256 = digest(`leaf-${index}`);
    leaves.push({ sha256, size: 1 });
    await f.ctx.db.insert('projectObjectReceipts', {
      projectId,
      key: `source-point:${projectId}:${sha256}`,
      value: sha256,
      size: 1,
      sourceBinding: { r2Key: `v1/p/${projectId}/o/${sha256}` },
    });
  }
  const recipe = { sha256: digest('recipe'), size: 20 };
  await f.ctx.db.insert('projectObjects', {
    projectId,
    digest: recipe.sha256,
    size: recipe.size,
    nonce: 'synthetic',
    removed: false,
    sourceReferenced: true,
    location: 'r2',
    r2Committed: true,
    r2Key: `v1/p/${projectId}/o/${recipe.sha256}`,
  });
  const outputs = Array.from({ length: 100 }, (_, index) => ({
    sha256: digest(`output-${index}`),
    size: 100,
    recipe,
    recipeClosure: leaves,
  }));
  const selected = outputs.map(pin => pin.sha256);
  while (outputs.length) {
    const page = takeSourceOutputs(outputs);
    await f.run('store outputs', () => storeSourceOutputs(f.ctx, projectId, 'execution', page));
  }
  for (const id of selected) assert([...f.tables.projectObjects.values()].some(row => row.digest === id));
  assert(f.counts.every(row => row.ranges < 2048 && row.documents < 2048));
  assert.equal(f.tables.projectObjects.size, 101);
  t.diagnostic(
    JSON.stringify({
      pages: f.counts.length,
      maxQueries: Math.max(...f.counts.map(row => row.ranges)),
      maxDocuments: Math.max(...f.counts.map(row => row.documents)),
    }),
  );
});

test('oversized physical projections stage dependencies before their logical recipe and retain cleanup fences', async t => {
  const f = recordsFixture();
  const { projectId } = await f.setup();
  const physical = Array.from({ length: 200 }, (_, index) => {
    const sha256 = digest(`physical-${index}`);
    return { sha256, size: 1, r2Key: `v1/p/${projectId}/o/${sha256}` };
  });
  const recipe = { sha256: digest('projected-recipe'), size: 20 };
  const sha256 = digest('logical-parent');
  const outputs = [
    {
      sha256,
      size: 100,
      recipe,
      recipeClosure: physical.slice(0, 100).map(({ sha256, size }) => ({ sha256, size })),
      physical: [...physical, { ...recipe, r2Key: `v1/p/${projectId}/o/${recipe.sha256}` }],
    },
  ];
  const order = [];
  while (outputs.length) {
    const page = takeSourceOutputs(outputs);
    assert(page.length <= 100);
    order.push(...page.map(pin => pin.sha256));
    await f.run('stage projection', () => storeSourceOutputs(f.ctx, projectId, 'execution', page));
  }
  assert.equal(order.at(-1), sha256);
  assert.equal(new Set(order).size, 202);
  assert.equal(f.tables.projectObjects.size, 202);
  assert.equal(f.tables.projectCheckLogSourcePins.size, f.counts.length);
  assert(f.counts.every(row => row.ranges <= 2048));
  t.diagnostic(
    JSON.stringify({ pages: f.counts.length, maxQueries: Math.max(...f.counts.map(row => row.ranges)) }),
  );
});
