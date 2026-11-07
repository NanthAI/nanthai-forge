// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { actionPinFindings, isWorkflowPath } from '../scripts/check-action-pins.mjs';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';
import { githubWorkflow } from '../scripts/bench-landing-workflow.mjs';

const sha = 'a'.repeat(40);
const step = uses => `jobs:\n  a:\n    steps:\n      - uses: ${uses}\n        with:\n          x: 1\n`;

test('action pin check refuses tags, branches and short SHAs and names the line', () => {
  for (const uses of [
    'actions/checkout@v4',
    'actions/checkout@main',
    'actions/checkout@11bd719',
    'actions/checkout',
    "'actions/setup-node@v4' # v4",
    'actions/cache/restore@v4',
    'docker://alpine:3',
  ])
    assert.deepEqual(
      actionPinFindings('.github/workflows/x.yml', step(uses)),
      ['.github/workflows/x.yml:4: pin the action to a full commit SHA (uses: owner/repo@SHA # vN)'],
      uses,
    );
  // A step-level `uses:` (no list dash) is checked too.
  assert.equal(
    actionPinFindings('w.yml', `      - name: up\n        uses: actions/upload-artifact@v4\n`).length,
    1,
  );
});

test('action pin check needs the pinned tag in a comment', () => {
  assert.deepEqual(actionPinFindings('w.yml', step(`actions/checkout@${sha}`)), [
    'w.yml:4: name the pinned tag in a comment (# vN)',
  ]);
  assert.equal(actionPinFindings('w.yml', step(`actions/checkout@${sha} # pinned`)).length, 1);
});

test('action pin check accepts SHA pins with a tag comment, local actions and image digests', () => {
  for (const uses of [
    `actions/checkout@${sha} # v4`,
    `actions/cache/restore@${sha} # v4.2.3`,
    `"actions/setup-node@${sha}" # 4.1.0`,
    './.github/actions/local',
    `docker://alpine@sha256:${'b'.repeat(64)}`,
  ])
    assert.deepEqual(actionPinFindings('w.yml', step(uses)), [], uses);
  assert.deepEqual(actionPinFindings('w.yml', 'run: echo uses: nothing\n'), []);
  assert.equal(isWorkflowPath('.github/workflows/ci.yml'), true);
  assert.equal(isWorkflowPath('.github/workflows/nested/ci.yaml'), false);
  assert.equal(isWorkflowPath('docs/ci.yml'), false);
});

test('committed, generated and benchmark workflows pin every action', () => {
  const workflows = readdirSync('.github/workflows')
    .filter(name => /\.ya?ml$/.test(name))
    .map(name => [`.github/workflows/${name}`, readFileSync(`.github/workflows/${name}`, 'utf8')]);
  assert(workflows.length >= 5);
  for (const runsOn of ['ubuntu-latest', ['self-hosted', 'linux']])
    workflows.push([`generated ${runsOn}`, githubActionsWorkflow(runsOn)]);
  workflows.push(['benchmark', githubWorkflow({ ghShards: 2 })]);
  for (const [path, text] of workflows) {
    assert.match(text, /uses: /, path);
    assert.deepEqual(actionPinFindings(path, text), [], path);
  }
});
