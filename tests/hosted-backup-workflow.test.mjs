// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parsers } from 'prettier/plugins/yaml.mjs';

// Use the existing pinned YAML parser, rather than regex alone or a new dependency.
function value(node) {
  if (node.type === 'mapping') return Object.fromEntries(node.children.map(item => item.children.map(value)));
  if (node.type === 'sequence') return node.children.map(value);
  if ('value' in node) return node.value;
  return node.children.length ? value(node.children[0]) : null;
}
const source = readFileSync('.github/workflows/hosted-backup.yml', 'utf8');
const ast = parsers.yaml.parse(source);
assert.equal(ast.children.length, 1);
const workflow = value(ast.children[0].children.find(node => node.type === 'documentBody'));
const job = workflow.jobs.backup;

test('weekly backup YAML has only Monday 03:00 UTC schedule and manual triggers', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.schedule, [{ cron: '0 3 * * 1' }]);
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['backup']);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(workflow.concurrency['cancel-in-progress'], 'false');
});

test('all actions are SHA pinned and credentials reach only the two backup commands', () => {
  const actions = job.steps.filter(step => step.uses);
  assert.equal(actions.length, 2);
  for (const step of actions) assert.match(step.uses, /^actions\/(checkout|setup-node)@[a-f0-9]{40}$/);
  assert.equal(actions[0].with['persist-credentials'], 'false');
  assert.equal(actions[1].with['node-version'], '24.22.1');
  assert.equal(job.env.HOSTED_DURABILITY_DATABASE_ONLY, '0');
  assert.equal(job.env.HOSTED_DURABILITY_DEPLOYMENT, 'benevolent-wildebeest-974');
  assert(!JSON.stringify(workflow.env ?? {}).includes('secrets.'));
  assert(!JSON.stringify(job.env).includes('secrets.'));
  for (const step of job.steps) {
    if (step.env) {
      assert.match(step.run, /scripts\/hosted-(?:backup-freshness|durability)\.mjs/);
      for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])
        assert.equal(step.env[key], `\u0024{{ secrets.${key} }}`);
    }
    // Only fixed node commands run with secrets; no shell expansion, echo, debug,
    // environment dump, secret interpolation or artifact/cache upload can expose them.
    if (step.env)
      assert.match(
        step.run,
        /^(node scripts\/[\w.-]+\.mjs(?: backup --deployment benevolent-wildebeest-974)?\n?)+$/,
      );
    assert(!step.run?.includes('secrets.'));
  }
  assert.equal(job.steps.at(-1).env.CONVEX_DEPLOY_KEY, '\u0024{{ secrets.CONVEX_DEPLOY_KEY }}');
  assert.doesNotMatch(source, /--prod|continue-on-error|pull_request|upload-artifact|set -x/);
});

test('freshness runs before backup; overdue recovery preserves the failed job', () => {
  const freshness = job.steps.findIndex(step => step.id === 'freshness');
  assert(freshness >= 0);
  assert.match(job.steps[freshness].run, /node scripts\/hosted-backup-freshness\.mjs/);
  assert.equal(job.steps[freshness]['continue-on-error'], undefined);
  assert.equal(job.steps[freshness].if, undefined);
  const backup = job.steps[freshness + 1];
  assert.match(
    backup.run,
    /node scripts\/hosted-durability\.mjs backup --deployment benevolent-wildebeest-974/,
  );
  assert.equal(
    backup.if,
    "\u0024{{ !cancelled() && (steps.freshness.outcome == 'success' || steps.freshness.outcome == 'failure') }}",
  );
  for (const step of [job.steps[freshness], backup])
    assert(step.run.indexOf('node scripts/hosted-backup-mask.mjs') < step.run.lastIndexOf('node scripts/'));
});

test('derived credential masks escape workflow commands and stay silent outside Actions', () => {
  const env = {
    PATH: process.env.PATH,
    CONVEX_DEPLOY_KEY: 'dev:synthetic|PRIVATE_KEY',
    R2_ACCOUNT_ID: 'synthetic%\n::error::account',
    R2_BUCKET: 'synthetic-bucket',
  };
  for (const actions of [false, true]) {
    const result = spawnSync(process.execPath, ['scripts/hosted-backup-mask.mjs'], {
      env: { ...env, GITHUB_ACTIONS: String(actions) },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert(!result.stdout.includes('PRIVATE_KEY'));
    if (!actions) assert.equal(result.stdout, '');
    else {
      const lines = result.stdout.trim().split('\n');
      assert.equal(lines.length, 3);
      assert(lines.every(line => line.startsWith('::add-mask::')));
      assert.match(lines[1], /%25%0A::error::account/);
    }
  }
});

test('launchd fallback parses and has no automatic schedule', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import plistlib; p=plistlib.load(open("scripts/launchd/com.nanthai.forge-hosted-backup.plist", "rb")); assert not any(k in p for k in ["StartCalendarInterval", "StartInterval", "RunAtLoad", "KeepAlive"])',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
