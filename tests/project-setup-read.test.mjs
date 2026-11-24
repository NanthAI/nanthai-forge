// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The setup read behind Getting started and Landing and checks (convex/projectSetup.ts): facts from rows that already
// exist, with who and when, and nothing for a reader who cannot open the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const setup = await import(moduleUrl('../convex/projectSetup.ts'));

function project(s, extra = {}) {
  s.insert('forgeAccounts', { owner: 'owner', handle: 'ada' });
  return s.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'shop',
    currentBackup: null,
    revision: 0,
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
    ...extra,
  });
}

test('revoked CLI credentials cannot change personal setup preferences', async () => {
  const s = lanesFixture();
  const projectId = project(s);
  const credentialId = randomUUID();
  s.insert('cliCredentials', {
    credentialId,
    owner: 'owner',
    name: 'Synthetic device',
    tokenHash: 'synthetic-hash',
    issuedAt: 1_700_000_000_000,
    expiresAt: 4_102_444_800_000,
    scope: 'cli',
    revoked: true,
  });
  await assert.rejects(
    s.call(
      'setupPreferences',
      setup.setPreferences,
      {
        projectId,
        change: { visibility: 'hidden' },
        operationId: randomUUID(),
        expectedRevision: 0,
      },
      { subject: 'owner', forgeCredential: credentialId },
    ),
    error => error.data?.code === 'AUTH_REVOKED',
  );
  assert.equal(s.counts.at(-1).writes, 0);
});

test('a new project reads as imported by its owner, with every later step still open', async () => {
  const s = lanesFixture();
  const projectId = project(s);
  const view = await s.call('setupRead', setup.read, { projectId });
  assert.equal(view.owner, 'ada');
  assert.equal(view.viewerIsOwner, true);
  assert.equal(view.created.by, 'ada');
  assert.deepEqual(
    [view.repository, view.mirror, view.check, view.firstLanding, view.approvalsAnswered],
    [null, null, null, null, false],
  );
});

test('each step done records who did it and when; the first landing ends the setup', async () => {
  const s = lanesFixture();
  const projectId = project(s, { autonomyPolicy: undefined });
  s.insert('projectGithubBindings', {
    projectId,
    repoId: 7,
    fullName: 'someone/shop',
    installationId: 9,
    boundBy: 'owner',
    boundAt: 1234,
  });
  s.insert('projectGithubMirrors', { projectId, repository: 'someone/shop', activeId: null, mapping: null });
  s.insert('projectHostedCheckSettings', {
    projectId,
    kind: 'runner',
    key: 'runner',
    version: 1,
    digest: 'a'.repeat(64),
    value: JSON.stringify({
      provider: 'ci-status',
      ci: { adapter: 'github-actions', repository: 'someone/shop', workflow: '.github/workflows/ci.yml' },
      runtime: 'b'.repeat(64),
      environmentFingerprint: 'c'.repeat(64),
    }),
  });
  s.insert('projectHostedAcceptances', {
    projectId,
    receiptId: randomUUID(),
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence: 1,
    value: '{}',
  });
  const view = await s.call('setupRead', setup.read, { projectId });
  assert.deepEqual(view.repository, { fullName: 'someone/shop', at: 1234, by: 'ada' });
  assert.equal(view.mirror.repository, 'someone/shop');
  assert.equal(s.counts.at(-1).readRangesByTable.projectGithubMirrors, 1);
  const checklist = await s.call('setupRead', setup.read, { projectId, checklist: true });
  assert.deepEqual(checklist, { ...view, mirror: null });
  assert.equal(s.counts.at(-1).readRangesByTable.projectGithubMirrors ?? 0, 0);
  assert(s.counts.at(-1).documents <= 8);
  assert.deepEqual(
    [view.check.kind, view.check.repository, view.check.workflow],
    ['ci-file', 'someone/shop', '.github/workflows/ci.yml'],
  );
  assert.equal(typeof view.firstLanding.at, 'number');
  const other = await s.call('setupRead', setup.read, { projectId }, 'stranger').catch(error => error);
  assert.ok(other instanceof Error, 'a stranger reads nothing');
});
