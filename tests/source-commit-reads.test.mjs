// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { digest } from '../dist/hash.js';
const { sourceCommitReads } = await import(moduleUrl('../convex/projectSourceCommitReads.ts'));
const { hostedRecordBody, hostedWriteProject } = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const { activeProject } = await import(moduleUrl('../convex/projectAuthority.ts'));

function fixture() {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'public',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  return { ...f, projectId };
}
const transaction = (f, run) => f.call('sourceCommitReadGuard', { _handler: run }, {});

test('source commit reuses one project version while every actor and epoch check still runs', async () => {
  const f = fixture();
  await transaction(f, async original => {
    const ctx = sourceCommitReads(original, f.projectId);
    for (let i = 0; i < 10; i++) await hostedWriteProject(ctx, f.projectId, 'owner', 1);
    await assert.rejects(hostedWriteProject(ctx, f.projectId, 'owner', 2), /authority changed/i);
    await assert.rejects(activeProject(ctx, f.projectId, 'stranger'), /Contributor access/);
  });
  assert.equal(f.counts.at(-1).readDocumentsByTable.hostedProjects, 1);
  await transaction(f, ctx =>
    hostedWriteProject(sourceCommitReads(ctx, f.projectId), f.projectId, 'owner', 1),
  );
  assert.equal(f.counts.at(-1).readDocumentsByTable.hostedProjects, 1, 'a new transaction rechecks storage');
});

test('source commit project patches and replacements invalidate authority and capability snapshots', async () => {
  for (const method of ['patch', 'replace']) {
    const f = fixture();
    await transaction(f, async original => {
      const ctx = sourceCommitReads(original, f.projectId);
      const project = await hostedWriteProject(ctx, f.projectId, 'owner', 1);
      if (method === 'patch')
        await ctx.db.patch(f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
      else {
        const { _id, _creationTime, ...value } = project;
        await ctx.db.replace(f.projectId, { ...value, sourceAuthority: { mode: 'server', epoch: 2 } });
      }
      await assert.rejects(hostedWriteProject(ctx, f.projectId, 'owner', 1), /authority changed/i);
      assert.equal((await hostedWriteProject(ctx, f.projectId, 'owner', 2)).sourceAuthority.epoch, 2);
    });
  }
});

test('source commit project deletion and contributor revocation remain visible in the transaction', async () => {
  const f = fixture();
  const member = f.insert('projectContributors', { projectId: f.projectId, contributor: 'member' });
  await transaction(f, async original => {
    const ctx = sourceCommitReads(original, f.projectId);
    await activeProject(ctx, f.projectId, 'member');
    await ctx.db.delete(member);
    await assert.rejects(activeProject(ctx, f.projectId, 'member'), /Contributor access/);
    await ctx.db.delete(f.projectId);
    await assert.rejects(activeProject(ctx, f.projectId, 'owner'), /unavailable/);
  });
});

test('source commit preserves late journal hydration when exact old record bodies are loaded', async () => {
  const f = fixture();
  await transaction(f, async original => {
    let loaded = [];
    Object.defineProperty(original, 'journalLoaded', {
      configurable: true,
      enumerable: true,
      get: () => loaded,
    });
    const ctx = sourceCommitReads(original, f.projectId);
    const value = JSON.stringify({ kind: 'job', id: 'archived-job', version: 0 });
    const bodyId = 'projectHostedRecordBodies-late';
    loaded = [
      {
        tables: {
          projectHostedRecordBodies: [JSON.stringify({ _id: bodyId, projectId: f.projectId, value })],
        },
      },
    ];
    assert.equal(
      await hostedRecordBody(ctx, {
        projectId: f.projectId,
        bodyId,
        digest: digest(value),
        bytes: Buffer.byteLength(value),
      }),
      value,
    );
  });
});
