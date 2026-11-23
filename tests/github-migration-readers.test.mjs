// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGithubImport } from '../dist/github-import-cli.js';

const journal = {
  deployment: 'https://example.invalid',
  url: 'example/repo',
  ref: 'topic',
  name: null,
  operationId: '00000000-0000-4000-8000-000000000001',
  jobId: 'job',
  startedAt: '2026-01-01T00:00:00Z',
};
const status = {
  projectId: 'project',
  commit: 'a'.repeat(40),
  phase: 'error',
  completed: 5,
  total: 10,
  totalKnown: true,
  bytes: 50,
  totalBytes: 100,
  submodules: 0,
  report: '',
  error: { code: 'NETWORK', message: 'Retry the same import.' },
};
test('CLI retains available migration counts, unknown counts and original operation/ref/commit on partial imports', async () => {
  const migration = { issues: 1000, pullRequests: 0, branches: 3, collaborators: null };
  const client = { action: async name => (name.endsWith(':start') ? 'job' : { ...status, migration }) };
  const report = await runGithubImport(client, '.', journal, { wait: false });
  assert.deepEqual(report.migration, migration);
  assert.equal(report.operationId, journal.operationId);
  assert.equal(report.ref, journal.ref);
  assert.equal(report.commit, status.commit);
  assert.equal(report.ready, false);
});
test('old imports retain their earlier reply without inventing zero migration counts', async () => {
  const client = { action: async name => (name.endsWith(':start') ? 'job' : status) };
  const report = await runGithubImport(client, '.', journal, { wait: false });
  assert.equal(Object.hasOwn(report, 'migration'), false);
});
