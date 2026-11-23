// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { githubMigrationCounts } from '../dist/github-migration-ledger.js';
import { migrationSummary } from '../dist/migration-ledger.js';
import { importReport } from '../dist/github-import-cli.js';
import { importAgentGuide, importStaysLine } from '../dist/migration-ledger.js';
import { importPreviewLine } from '../dist/github-import-report.js';
import { readFileSync } from 'node:fs';

test('one aggregate metadata request reports original totals at current and doubled scale, without identities', async t => {
  for (const size of [1000, 2000]) {
    let calls = 0,
      requestBytes = 0,
      responseBytes = 0;
    const at = performance.now();
    const counts = await githubMigrationCounts('example/project', 'synthetic', async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.github.com/graphql');
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      requestBytes = Buffer.byteLength(init.body);
      assert.deepEqual(body.variables, { owner: 'example', name: 'project' });
      assert.doesNotMatch(body.query, /\b(?:nodes|edges|email|login|nameWithOwner)\b/);
      const response = JSON.stringify({
        data: {
          issues: { issues: { totalCount: size } },
          pullRequests: { pullRequests: { totalCount: 0 } },
          branches: { refs: { totalCount: 3 } },
          collaborators: { collaborators: { totalCount: 4 } },
        },
      });
      responseBytes = Buffer.byteLength(response);
      return new Response(response);
    });
    assert.equal(calls, 1);
    assert.deepEqual(counts, { issues: size, pullRequests: 0, branches: 3, collaborators: 4 });
    assert.match(migrationSummary(counts), new RegExp(`Issues ${size}`));
    assert.match(migrationSummary(counts), /pull requests 0/);
    assert.doesNotMatch(JSON.stringify(counts), /synthetic/);
    t.diagnostic(
      JSON.stringify({
        size,
        calls,
        requestBytes,
        responseBytes,
        retainedBytes: Buffer.byteLength(JSON.stringify(counts)),
        wallMs: performance.now() - at,
        processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  }
});
test('partial permissions keep independent totals and unknown counts never become zero', async () => {
  const counts = await githubMigrationCounts(
    'example/project',
    'synthetic',
    async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: { issues: { totalCount: 7 } },
            pullRequests: null,
            branches: { refs: { totalCount: 0 } },
            collaborators: null,
          },
          errors: [{ message: 'private provider details' }],
        }),
      ),
  );
  assert.deepEqual(counts, {
    issues: 7,
    pullRequests: null,
    branches: 0,
    collaborators: null,
    notReportedReason: 'partial-metadata',
  });
  assert.match(migrationSummary(counts), /pull requests not reported/);
  assert.doesNotMatch(JSON.stringify(counts), /private provider/);
});
test('missing credentials make no request and provider failures return unknown counts without throwing', async () => {
  let calls = 0;
  const counts = await githubMigrationCounts('example/project', undefined, async () => {
    calls++;
    throw new Error('unexpected');
  });
  assert.equal(calls, 0);
  assert.equal(counts.notReportedReason, 'credential-unavailable');
  for (const reply of [
    async () => {
      throw new Error('private details');
    },
    async () => new Response('{}', { status: 403 }),
    async () => new Response('invalid JSON'),
  ]) {
    const failed = await githubMigrationCounts('example/project', 'synthetic', reply);
    assert.deepEqual(failed, {
      issues: null,
      pullRequests: null,
      branches: null,
      collaborators: null,
      notReportedReason: 'metadata-unavailable',
    });
  }
  assert.match(migrationSummary(), /Issues not reported/);
});

test('CLI migration language names omissions without inventing counts or changing the source identity', () => {
  const journal = {
    operationId: 'operation',
    jobId: 'job',
    deployment: 'https://fixture.invalid',
    url: 'example/project',
    ref: 'topic',
  };
  const status = {
    projectId: 'project',
    commit: 'a'.repeat(40),
    phase: 'error',
    total: 1000,
    completed: 300,
    totalBytes: 5000,
    submodules: 0,
    githubRequests: null,
    error: { code: 'NETWORK', message: 'Retry' },
    migration: { issues: 1000, pullRequests: null, branches: 3, collaborators: null },
  };
  const report = importReport(journal, status);
  assert.deepEqual(report.migration, status.migration);
  assert.equal(report.migrationSummary, migrationSummary(status.migration));
  assert.match(report.migrationSummary, /pull requests not reported/);
  assert.equal(report.operationId, journal.operationId);
  assert.equal(report.ref, journal.ref);
  assert.equal(report.commit, status.commit);
  assert.match(report.next, /--resume operation/);
});

test('Item bd24f0a6: the preview and the import reply both say what stays on GitHub, and the agent guide they link exists', () => {
  const preview = {
    repository: 'example/project',
    origin: 'public',
    choices: ['public', 'private'],
    ref: 'main',
    commit: 'c'.repeat(40),
    files: 12,
    bytes: 1000,
    submodules: 0,
    attributes: 0,
    lfs: 'No .gitattributes, so no Git LFS files.',
    warnings: [],
  };
  for (const line of [importPreviewLine(preview), migrationSummary()]) {
    assert.ok(line.includes(importStaysLine), 'issues, pull requests, people, tags and CI config are named');
  }
  assert.doesNotMatch(importStaysLine, /import(ed)? (your )?issues/i, 'no GitHub issue import is promised');
  const heading = importAgentGuide.split('#')[1];
  // test-signal: allow a link the web and CLI ship must reach a real heading, not a dead anchor
  const docs = readFileSync(new URL('../docs/planning.md', import.meta.url), 'utf8');
  const slugs = [...docs.matchAll(/^#{1,6} (.+)$/gm)].map(match =>
    match[1]
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/ /g, '-'),
  );
  assert.ok(slugs.includes(heading), `docs/planning.md has the heading behind ${importAgentGuide}`);
});
