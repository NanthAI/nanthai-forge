// SPDX-License-Identifier: Apache-2.0
// The import page and the Mirror screen (Items a488af2a, 2abda01f, c63c2171): each recorded import progress reads as one
// stage, a rate limit offers resuming at the reset (or says Forge already will), the address forms the import accepts
// name one repository, every mirror state has its mark, and Getting started's import door opens the import page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

globalThis.location ??= { origin: 'https://forge.example' };
const model = await import(moduleUrl('../web/src/app/start/import-model.ts'));
const mirror = await import(moduleUrl('../web/src/app/mirror/mirror-model.ts'));
const { mirrorSummary } = await import(moduleUrl('../src/github-mirror-sentence.ts'));
const { hrefFor } = await import(moduleUrl('../web/src/app/paths.ts'));
const { default: Start } = await import(moduleUrl('../web/src/app/start/Start.tsx'));

const progress = (fields = {}) => ({
  projectId: 'p',
  phase: 'importing',
  completed: 10,
  total: 40,
  error: null,
  ...fields,
});
const NOW = 1_800_000_000_000;

test('each recorded import progress reads as one stage; a future GitHub reset is a pause, a past one a stop', () => {
  assert.deepEqual(model.importStage(progress(), NOW), { kind: 'importing', done: 10, total: 40 });
  assert.equal(model.importStage(progress({ phase: 'ready' }), NOW).kind, 'ready');
  const limited = { code: 'GITHUB_RATE_LIMIT', message: 'GitHub rate limit.', retryAt: NOW + 60_000 };
  assert.deepEqual(model.importStage(progress({ phase: 'error', error: limited }), NOW), {
    kind: 'paused',
    at: NOW + 60_000,
    scheduled: false,
    done: 10,
    total: 40,
  });
  const scheduled = model.importStage(
    progress({ phase: 'paused', error: { ...limited, resumeAt: NOW + 60_000 } }),
    NOW,
  );
  assert.deepEqual(
    [scheduled.kind, scheduled.scheduled],
    ['paused', true],
    'Forge resumes it; nothing to press',
  );
  assert.equal(
    model.importStage(progress({ phase: 'error', error: limited }), NOW + 120_000).kind,
    'stopped',
  );
  const refused = { code: 'GITHUB_SOURCE_UNSUPPORTED', message: '2 paths are not valid UTF-8.' };
  assert.deepEqual(model.importStage(progress({ phase: 'error', error: refused }), NOW).kind, 'stopped');
});

test('the address forms the import accepts name one repository; the CLI line matches the choices', () => {
  for (const url of [
    'https://github.com/example/repo',
    'https://github.com/example/repo.git',
    'https://github.com/example/repo/tree/main',
    'git@github.com:example/repo.git',
    'example/repo',
  ])
    assert.equal(model.repositoryOf(url), 'example/repo', url);
  assert.equal(
    model.importCommand('https://github.com/example/repo', 'v1', 'private'),
    'nforge import https://github.com/example/repo --ref v1 --private',
  );
  assert.equal(model.importCommand('', '', null), 'nforge import https://github.com/OWNER/REPO');
  assert.match(model.visibilityWords('private', ['private']), /^Private on GitHub, so private here\.$/);
  assert.match(model.visibilityWords('public', ['public', 'private']), /Private here/);
});

test('every mirror state the shared sentence can return has a mark and a distance between the two ends', () => {
  const repo = 'example/repo';
  const status = fields => ({
    repository: repo,
    status: 'synced',
    targetHead: 'a'.repeat(64),
    mirroredHead: 'a'.repeat(64),
    gitHead: 'b'.repeat(40),
    lagging: false,
    pendingSince: null,
    mirroredAt: 1,
    failures: 0,
    nextAttemptAt: null,
    error: null,
    detail: null,
    jobId: null,
    nextStep: null,
    ...fields,
  });
  const twoWay = { repo, autoPush: true, inbound: true };
  const states = new Set(
    [
      mirrorSummary(null, null),
      mirrorSummary(twoWay, status()),
      mirrorSummary(twoWay, status({ status: 'syncing', lagging: true })),
      mirrorSummary(twoWay, status({ status: 'retrying', lagging: true })),
      mirrorSummary(twoWay, status({ status: 'failed', error: 'GITHUB_SYNC_CHANGED' })),
      mirrorSummary(twoWay, status({ status: 'failed', error: 'GITHUB_SYNC_API' })),
      mirrorSummary(twoWay, status({ status: 'failed', error: 'GITHUB_INBOUND_FAILED' })),
      mirrorSummary(twoWay, status({ status: 'failed', error: 'OTHER' })),
      mirrorSummary(twoWay, status({ status: 'unknown', lagging: true, mirroredHead: null })),
      mirrorSummary(twoWay, null),
    ].map(summary => summary.state),
  );
  assert.equal(states.size, 10);
  for (const state of states) {
    const mark = mirror.mirrorStateMark(state);
    assert.ok(mark.gap && mark.word, state);
    if (state !== 'unknown')
      assert.notEqual(mark, mirror.mirrorStateMark('unknown'), `${state} has its own mark`);
  }
  assert.equal(mirror.mirrorStateMark('level').state, 'passed');
  assert.equal(
    mirror.endsWords({ ends: null, direction: 'off' }).github,
    null,
    'no head to show when Forge never pushed',
  );
});

test('Getting started opens the import page, and the old new-project form no longer imports itself', () => {
  const html = renderToStaticMarkup(h(Start));
  assert.ok(html.includes(`href="${hrefFor({ frame: 'bare', page: 'import' })}"`), 'the import door');
  assert.equal(hrefFor({ frame: 'bare', page: 'import' }), '/-/new/import');
  const old = readFileSync(new URL('../web/src/NewHostedProject.tsx', import.meta.url), 'utf8');
  assert.match(old, /href="\/-\/new\/import"/);
  assert.doesNotMatch(old, /ImportGithubProject/);
});
