// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pagedFixture } from './github-import-pages-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { current } = await import(moduleUrl('../convex/projectGithubImportProgress.ts'));

test('source-import progress belongs to the owner and stops exposing a removed project', async () => {
  const s = pagedFixture();
  const projectId = await s.ctx.db.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    currentBackup: null,
    name: 'fixture',
    revision: 0,
    visibility: 'public',
  });
  const id = await s.ctx.db.insert('projectGithubImports', {
    owner: 'owner',
    projectId,
    visibility: 'public',
    operationId: randomUUID(),
    request: '',
    repository: 'fixture/repo',
    commit: 'a'.repeat(40),
    at: new Date().toISOString(),
    step: 0,
    cursor: '',
    phase: 'importing',
    totalKnown: true,
    completed: 0,
    total: 10,
    bytes: 0,
    totalBytes: 100,
  });
  const job = s.tables.projectGithubImports.get(id);
  const first = await current._handler(s.ctx, { id });
  assert.equal(first.projectId, job.projectId);
  assert.equal(first.phase, job.phase);
  s.caller('intruder');
  await assert.rejects(current._handler(s.ctx, { id }), /unavailable/);
  s.caller('owner');
  await s.ctx.db.patch(job.projectId, { removal: 'deleting' });
  await assert.rejects(current._handler(s.ctx, { id }));
});
