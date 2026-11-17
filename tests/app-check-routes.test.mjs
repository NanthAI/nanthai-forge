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
