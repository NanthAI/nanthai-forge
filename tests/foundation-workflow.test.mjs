// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync('.github/workflows/foundation.yml', 'utf8');
const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][\w-]*:\n/)[0];

test('verification matrix is independent of native selfhost and preserves every failure', () => {
  assert.doesNotMatch(workflow, /22\.23\.4/);
  for (const name of ['verify-static', 'native-selfhost']) {
    const text = job(name);
    assert.match(text, /^    needs: scope$/m);
    assert.match(text, /!cancelled\(\).*needs.scope.outputs.scope != 'docs'/);
    assert.doesNotMatch(text, /continue-on-error/);
  }
  for (const name of ['verify-static', 'verify-tests']) {
    assert.match(job(name), /strategy:\n      fail-fast: false\n      matrix:/);
    assert.match(job(name), /node: \['24\.22\.1'\]/);
    assert.match(job(name), /runs-on: ubuntu-latest/);
    assert.match(job(name), /timeout-minutes: 20/);
    assert.doesNotMatch(job(name), /continue-on-error/);
  }
  assert.match(job('verify-static'), /node scripts\/public-verify\.mjs static 8/);
  assert.match(job('native-selfhost'), /node scripts\/selfhost-smoke\.mjs/);
});

test('public shards share the Node 24 build and package smoke runs only in the static matrix', () => {
  const staticJob = job('verify-static'),
    tests = job('verify-tests');
  assert.match(tests, /needs: \[scope, verify-static\]/);
  assert.match(tests, /!cancelled\(\).*needs.scope.outputs.scope != 'docs'/);
  const shards = /shard: \[([^\]]+)\]/.exec(tests)[1].split(',').map(Number);
  assert.deepEqual(
    shards,
    Array.from({ length: 8 }, (_, index) => index),
  );
  assert.match(tests, /node scripts\/public-verify\.mjs \$\{\{ matrix.shard \}\} 8/);
  // The public and landing static jobs share verify, including documents and
  // package smoke. Keep those contracts out of mirror-only workflow steps.
  assert.match(staticJob, /node scripts\/public-verify\.mjs static 8/);
  assert.doesNotMatch(staticJob, /node scripts\/check-documents\.mjs|npm run smoke:package/);
  const verify = readFileSync('scripts/verify.mjs', 'utf8');
  assert.match(verify, /run\('documents', process.execPath, \['scripts\/check-documents\.mjs'\]\)/);
  assert.match(verify, /results\.push\(await npm\('smoke:package', 'smoke:package'\)\)/);
  assert.match(staticJob, /tar -czf .* dist hosted-web-dist/);
  assert.match(staticJob, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(staticJob, /if-no-files-found: error/);
  assert.match(tests, /actions\/download-artifact@[a-f0-9]{40}/);
  for (const text of [staticJob, tests]) assert.match(text, /name: verify-build-\$\{\{ matrix.node \}\}/);
  assert.match(tests, /tar -xzf/);
  assert.doesNotMatch(tests, /npm run (?:verify|build|typecheck|lint|smoke:package)/);
});

test('the always-running aggregate fails closed for failed, cancelled or unexpectedly skipped jobs', () => {
  const aggregate = job('verify');
  const names = ['scope', 'foundation', 'verify-static', 'verify-tests', 'native-selfhost'];
  assert.match(aggregate, /needs: \[scope, foundation, verify-static, verify-tests, native-selfhost\]/);
  assert.match(aggregate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(aggregate, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  const script = aggregate.split("<<'JS'\n")[1].split('\n          JS')[0];
  const result = needs => {
    const reply = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) },
      encoding: 'utf8',
    });
    assert.equal(reply.error, undefined);
    assert.equal(reply.stderr, '');
    return reply.status;
  };
  for (const scope of ['full', 'docs']) {
    const required = scope === 'docs' ? ['scope', 'foundation'] : names.filter(n => n !== 'foundation');
    const needs = Object.fromEntries(
      names.map(name => [name, { result: required.includes(name) ? 'success' : 'skipped' }]),
    );
    needs.scope.outputs = { scope };
    assert.equal(result(needs), 0);
    for (const name of names) {
      const previous = needs[name].result;
      for (const status of ['failure', 'cancelled', 'timed_out']) {
        needs[name].result = status;
        assert.equal(result(needs), 1, `${scope}: ${name} ${status}`);
      }
      needs[name].result = 'skipped';
      assert.equal(result(needs), required.includes(name) ? 1 : 0, `${scope}: ${name} skipped`);
      needs[name].result = previous;
    }
  }
});

test('fixed Node 24 recipes agree with the generated check workflow', () => {
  const versions = [...workflow.matchAll(/node-version: '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(versions, ['24.22.1', '24.22.1', '24.22.1']);
  assert.match(readFileSync('.github/workflows/forge-check.yml', 'utf8'), /node-version: '24\.22\.1'/);
});

test('only newer main pushes cancel older public verifies; PR and manual runs remain independent', () => {
  const section = workflow.split('\nconcurrency:\n')[1].split('\njobs:\n')[0];
  const group = section.match(/  group: (.+)/)[1];
  const cancel = section.match(/  cancel-in-progress: \$\{\{ (.+) \}\}/)[1];
  const evaluate = (expression, github) => Function('github', `return (${expression});`)(github);
  const context = (event_name, ref, run_id) => ({ workflow: 'Verify Forge', event_name, ref, run_id });
  const expand = github =>
    group.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => evaluate(expression, github));
  const main1 = context('push', 'refs/heads/main', 1),
    main2 = context('push', 'refs/heads/main', 2);
  assert.equal(expand(main1), expand(main2));
  assert.equal(evaluate(cancel, main1), true);
  for (const event of ['pull_request', 'workflow_dispatch', 'push']) {
    const a = context(event, event === 'push' ? 'refs/heads/topic' : 'refs/heads/main', 3);
    const b = { ...a, run_id: 4 };
    assert.notEqual(expand(a), expand(b));
    assert.notEqual(expand(a), expand(main1));
    assert.equal(evaluate(cancel, a), false);
  }
  assert.match(workflow, /push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:/);
});

test('public verify actions use immutable SHAs and checkout never persists credentials', () => {
  const steps = workflow.split(/\n      - uses: /).slice(1);
  for (const step of steps) {
    assert.match(step.split('\n')[0], /^actions\/[\w-]+@[a-f0-9]{40}(?: # v4)?$/);
    if (step.startsWith('actions/checkout@')) assert.match(step, /persist-credentials: false/);
  }
  assert.equal(steps.filter(step => step.startsWith('actions/checkout@')).length, 5);
});

test('a newer docs-only main push still runs the full audit it may have superseded', () => {
  const expression = job('scope').match(/scope: \$\{\{ (.+) \}\}/)[1];
  const output = (event_name, ref, scope) =>
    Function(
      'github',
      'steps',
      `return (${expression});`,
    )({ event_name, ref }, { classify: { outputs: { scope } } });
  for (const scope of ['docs', 'full']) assert.equal(output('push', 'refs/heads/main', scope), 'full');
  assert.equal(output('pull_request', 'refs/pull/1/merge', 'docs'), 'docs');
  assert.equal(output('pull_request', 'refs/pull/1/merge', 'full'), 'full');
  assert.equal(output('workflow_dispatch', 'refs/heads/main', 'full'), 'full');
});
