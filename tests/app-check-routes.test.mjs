// SPDX-License-Identifier: Apache-2.0
// Connect CI from the CI a project has (Item 0c9207b8): the workflows on main are read for what they run on, a file
// that can never check a landing is not offered, the one trigger line is shown as the exact change to that file, and
// a file Forge cannot read plainly is never called passing or failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const wf = await import(moduleUrl('../web/src/app/checks/workflows.ts'));
const { CANDIDATE_BRANCH_PREFIX } = await import(moduleUrl('../src/ci-status.ts'));

test('a push trigger with an inline branch list gets the one-line change that adds Forge’s branches', () => {
  const text = 'name: CI\non:\n  push:\n    branches: [main] # all\n  pull_request:\njobs: {}\n';
  const trigger = wf.workflowTrigger(text);
  assert.equal(trigger.kind, 'push');
  assert.equal(trigger.covers, false);
  assert.deepEqual(trigger.change, {
    line: 4,
    before: '    branches: [main] # all',
    after: `    branches: [main, '${CANDIDATE_BRANCH_PREFIX}**'] # all`,
  });
  assert.equal(wf.cannotDecide(trigger), null);
});

test('a branch list written as items gets one added item, at the items’ indent', () => {
  const text = 'on:\n  push:\n    branches:\n      - main\n      - release\n    paths:\n      - src/**\n';
  const trigger = wf.workflowTrigger(text);
  assert.deepEqual(trigger.change, {
    line: 5,
    before: null,
    after: `      - '${CANDIDATE_BRANCH_PREFIX}**'`,
  });
  assert.equal(trigger.paths, true, 'a paths filter can leave a landing unchecked, so it is flagged');
});

test('a trigger that already runs on every branch, or on Forge’s, needs no change', () => {
  for (const text of [
    'on: [push, pull_request]\n',
    "'on':\n  push:\n    branches: [main, 'forge/candidates/**']\n",
  ]) {
    const trigger = wf.workflowTrigger(text);
    assert.deepEqual([trigger.kind, trigger.covers, trigger.change], ['push', true, null]);
  }
});

test('tags-only, schedule-only, pull-request-only and by-hand workflows are not offered to decide a landing', () => {
  const cases = {
    "on:\n  push:\n    tags: ['v*']\n": 'tags',
    "on:\n  schedule:\n    - cron: '0 3 * * *'\n": 'schedule',
    'on: pull_request\n': 'pull_request',
    'on: workflow_dispatch\n': 'manual',
  };
  for (const [text, kind] of Object.entries(cases)) {
    const trigger = wf.workflowTrigger(text);
    assert.equal(trigger.kind, kind);
    assert.match(wf.cannotDecide(trigger), /check a landing/);
  }
});

test('a file Forge cannot read plainly stays a choice, never marked as unable', () => {
  const trigger = wf.workflowTrigger('jobs:\n  build: {}\n');
  assert.equal(trigger.kind, 'unknown');
  assert.equal(wf.cannotDecide(trigger), null);
});

test('only top-level workflow files are listed, and the preselected one can decide', () => {
  assert.deepEqual(
    wf.workflowPaths([
      '.github/workflows/release.yml',
      '.github/workflows/ci.yaml',
      '.github/workflows/nested/x.yml',
      '.github/workflows/README.md',
      'ci.yml',
    ]),
    ['.github/workflows/ci.yaml', '.github/workflows/release.yml'],
  );
  const push = { kind: 'push', covers: false, change: null, paths: false };
  assert.equal(
    wf.preferred([
      { path: '.github/workflows/a.yml', trigger: { kind: 'tags' } },
      { path: '.github/workflows/b.yml', trigger: push },
      { path: '.github/workflows/ci.yml', trigger: push },
    ]),
    '.github/workflows/ci.yml',
  );
  assert.equal(wf.preferred([{ path: '.github/workflows/a.yml', trigger: { kind: 'schedule' } }]), undefined);
});

const ci = await import(moduleUrl('../web/src/app/checks/ci.ts'));
const first = await import(moduleUrl('../web/src/app/checks/first-landing.ts'));
const dir = name => ({ name, kind: 'dir' });
const file = name => ({ name, kind: 'file' });

test('the CI question starts from the CI files on main, whichever provider they belong to', () => {
  const github = ci.ciFiles([dir('.github'), dir('src'), file('README.md')]);
  assert.equal(ci.ciPreferred(github, 2, true), 'github');
  assert.equal(ci.ciFact('github', github, 2), '2 workflow files on main.');
  assert.equal(ci.ciFact('github', github, 1), '1 workflow file on main.');

  const gitlab = ci.ciFiles([dir('src'), file('.gitlab-ci.yml')]);
  assert.equal(ci.ciPreferred(gitlab, 0, true), 'gitlab');
  assert.equal(ci.ciFact('gitlab', gitlab, 0), '.gitlab-ci.yml on main.');

  const other = ci.ciFiles([dir('.buildkite'), file('Jenkinsfile')]);
  assert.equal(ci.ciPreferred(other, 0, true), 'other');
  assert.equal(ci.ciFact('other', other, 0), '.buildkite on main.');
});

test('a .github folder with no workflow is not a CI, and nothing is preselected from a partial listing', () => {
  const bare = ci.ciFiles([dir('.github'), file('LICENSE')]);
  assert.equal(ci.ciPreferred(bare, 0, true), 'none', 'the whole root was read and holds no CI file');
  assert.equal(ci.ciPreferred(bare, 0, false), undefined, 'more root entries than one page: not guessed');
  assert.equal(ci.ciFact('github', bare, 0), '');
  assert.equal(ci.ciFact('none', bare, 0), '');
});

test('every CI is a choice of the same shape, and each has a route that works today', () => {
  assert.deepEqual(ci.CI_ORDER, ['github', 'gitlab', 'other', 'none']);
  for (const id of ci.CI_ORDER) assert.ok(ci.ciTitles[id]);
});

test('setup is done only when a landing since the choice carries a check run', () => {
  const landings = [
    { title: 'Docs', committedAt: '2026-01-02T10:00:00.000Z', checkRunIds: [] },
    { title: 'Add the trigger line', committedAt: '2026-01-02T11:00:00.000Z', checkRunIds: ['run-1'] },
  ];
  assert.deepEqual(first.firstChecked(landings), {
    at: '2026-01-02T11:00:00.000Z',
    title: 'Add the trigger line',
  });
  assert.equal(first.firstChecked([landings[0]]), null, 'a landing with no check run proves nothing');
  assert.equal(first.firstChecked([]), null);
});

test('until a landing is checked, the page says what stands between the CI file and its first run', () => {
  const check = { kind: 'ci-file', repository: 'example/parser', workflow: '.github/workflows/ci.yml' };
  const change = {
    line: 4,
    before: '    branches: [main]',
    after: "    branches: [main, 'forge/candidates/**']",
  };
  const needs = { kind: 'push', covers: false, change, paths: false };
  assert.deepEqual(first.awaiting({ check, checking: 0, trigger: needs }), {
    meta: 'ci.yml on main does not run on Forge’s branches yet.',
    needsLine: true,
  });
  assert.equal(first.awaiting({ check, checking: 1, trigger: needs }).meta, '1 Lane is being checked now.');
  assert.deepEqual(
    first.awaiting({
      check,
      checking: 0,
      trigger: { kind: 'push', covers: true, change: null, paths: false },
    }),
    { meta: 'Its first run is the next landing.', needsLine: false },
  );
  assert.equal(
    first.awaiting({ check, checking: 0, trigger: null }).meta,
    '.github/workflows/ci.yml is not on main, so no run can start.',
  );
  assert.match(
    first.awaiting({ check, checking: 0, trigger: { kind: 'tags' } }).meta,
    /cannot check a landing/,
  );
  assert.equal(
    first.awaiting({ check: { kind: 'machine' }, checking: 0, trigger: undefined }).meta,
    'Its first run is the next landing.',
  );
});

test('the prompt for an agent names the file, the exact line and that the owner approves it', () => {
  const prompt = first.firstRunPrompt('parser', '.github/workflows/ci.yml', {
    line: 4,
    before: '    branches: [main]',
    after: "    branches: [main, 'forge/candidates/**']",
  });
  assert.match(prompt, /parser/);
  assert.match(prompt, /\.github\/workflows\/ci\.yml/);
  assert.match(prompt, /line 4/);
  assert.match(prompt, /forge\/candidates\/\*\*/);
  assert.match(prompt, /approv/);
  const added = first.firstRunPrompt('parser', '.github/workflows/ci.yml', {
    line: 5,
    before: null,
    after: "      - 'forge/candidates/**'",
  });
  assert.match(added, /below line 5/);
});
