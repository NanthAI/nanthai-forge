// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { supportedNode } from '../scripts/node-runtime.mjs';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { checkPin } from '../dist/hosted-check.js';
import { modalRuntime } from '../dist/modal-plan.js';
import { githubWorkflow } from '../scripts/bench-landing-workflow.mjs';

test('Node release floors reject vulnerable and unsupported lines and accept patched stable releases', () => {
  for (const version of [
    'v20.99.0',
    '22.12.0',
    '22.23.3',
    'v23.99.0',
    '24.19.0',
    'v24.22.0',
    '25.0.0',
    '26.12.1',
    '24.22.1-rc.1',
    '24',
    'invalid',
  ])
    assert.equal(supportedNode(version), false, version);
  for (const version of ['v22.23.4', '22.23.5', '22.24.0', 'v24.22.1', '24.22.2', '24.23.0'])
    assert.equal(supportedNode(version), true, version);
  assert.equal(supportedNode(), true);
});

test('CLI and standard check reject vulnerable runtime identities before command or npm execution', () => {
  for (const path of ['dist/cli.js', 'scripts/forge-check.mjs']) {
    for (const version of ['v22.23.3', 'v24.22.0']) {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `Object.defineProperty(process, 'version', { value: ${JSON.stringify(version)} });
         process.argv = [process.execPath, ${JSON.stringify(path)}, '--version'];
         await import(${JSON.stringify(new URL(`../${path}`, import.meta.url).href)});`,
        ],
        { encoding: 'utf8', timeout: 20_000 },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /UNSUPPORTED_NODE/);
      assert.match(result.stderr, /22\.23\.4.*24\.22\.1/);
      assert.equal(result.stdout, '');
      if (path === 'dist/cli.js') assert.equal(JSON.parse(result.stderr).error.code, 'UNSUPPORTED_NODE');
    }
  }
});

test('package and active remote check recipes agree on the fixed Node release', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  assert.equal(manifest.engines.node, '^22.23.4 || >=24.22.1 <25');
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
  // Actions exports replace the committed workflow with the policy's runner label.
  // Compare runtime pins rather than unrelated, environment-specific workflow bytes.
  const workflows = [['committed/exported', readFileSync('.github/workflows/forge-check.yml', 'utf8')]];
  for (const runsOn of ['ubuntu-latest', 'blacksmith-4vcpu-ubuntu-2404']) {
    workflows.push([`generated ${runsOn}`, githubActionsWorkflow(runsOn)]);
    workflows.push([`benchmark ${runsOn}`, githubWorkflow({ ghRunsOn: runsOn })]);
  }
  for (const [recipe, workflow] of workflows) {
    const versions = [...workflow.matchAll(/^\s*node-version:\s*(.+)$/gm)].map(([, value]) =>
      value.trim().replace(/^(['"])(.*)\1$/, '$2'),
    );
    assert.deepEqual(versions, ['24.22.1', '24.22.1'], recipe);
    assert.doesNotMatch(workflow, /24\.19\.0/);
  }
  assert.equal(
    hostedActionsRuntime,
    checkPin('github-actions;node:24.22.1;checkout:v4;setup-node:v4;forge-check:v1'),
  );
  assert.match(modalRuntime, /node:24\.22\.1-trixie-slim;/);
  for (const path of ['scripts/modal-check/runner.py', 'scripts/modal-spike/runner.py'])
    assert.match(readFileSync(path, 'utf8'), /node:24\.22\.1-trixie-slim/);
});
