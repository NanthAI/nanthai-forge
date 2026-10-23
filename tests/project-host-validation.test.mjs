// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { fixture } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
const { validateHostedClosure } = await import(moduleUrl('../convex/projectExchangeValidation.ts'));
function owner() {
  const s = fixture(),
    pins = [];
  for (let i = 0; i < 275; i++) {
    const sha256 = digest(`synthetic retained ${i}`),
      size = i + 1;
    s.tables.projectObjects.set(`object-${i}`, {
      _id: `object-${i}`,
      _creationTime: i,
      projectId: 'project',
      digest: sha256,
      size,
      storageId: `stored-${i}`,
      nonce: `nonce-${i}`,
    });
    pins.push({ sha256, size });
  }
  return { s, pins };
}
test('history completion scans all pages and compares the exact deduplicated closure', async () => {
  const { s, pins } = owner(),
    run = s.ctx.runQuery;
  let pages = 0;
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjectValidation:page') pages++;
    return run(ref, args);
  };
  await validateHostedClosure(s.ctx, 'project', 'owner', [...pins, pins[5]]);
  assert.equal(pages, 3);
  s.tables.projectObjects.delete('object-125');
  await assert.rejects(
    validateHostedClosure(s.ctx, 'project', 'owner', pins),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
});
test('history completion rejects unavailable receipts and inconsistent sizes, including duplicate pins', async () => {
  const { s, pins } = owner();
  s.tables.projectObjects.get('object-124').removed = true;
  await assert.rejects(
    validateHostedClosure(s.ctx, 'project', 'owner', pins),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  delete s.tables.projectObjects.get('object-124').removed;
  s.tables.projectObjects.get('object-125').size++;
  await assert.rejects(
    validateHostedClosure(s.ctx, 'project', 'owner', pins),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  await assert.rejects(
    validateHostedClosure(s.ctx, 'project', 'owner', [...pins, { ...pins[5], size: 999 }]),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
});
test('history completion rechecks current ownership on every page', async () => {
  const { s, pins } = owner(),
    run = s.ctx.runQuery;
  let pages = 0;
  s.ctx.runQuery = async (ref, args) => {
    const result = await run(ref, args);
    if (getFunctionName(ref) === 'projectObjectValidation:page' && ++pages === 1)
      s.tables.hostedProjects.get('project').owner = 'other';
    return result;
  };
  await assert.rejects(
    validateHostedClosure(s.ctx, 'project', 'owner', pins),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(pages, 1);
});
