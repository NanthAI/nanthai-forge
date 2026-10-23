// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync('.github/workflows/foundation.yml', 'utf8');
const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][\w-]*:\n/)[0];

test('verification matrix is independent of native selfhost and preserves every failure', () => {
  for (const name of ['verify-static', 'native-selfhost']) {
    const text = job(name);
    assert.match(text, /^    needs: scope$/m);
    assert.match(text, /!cancelled\(\).*needs.scope.outputs.scope != 'docs'/);
    assert.doesNotMatch(text, /continue-on-error/);
  }
  for (const name of ['verify-static', 'verify-tests']) {
    assert.match(job(name), /strategy:\n      fail-fast: false\n      matrix:/);
    assert.match(job(name), /node: \['22\.23\.4', '24\.22\.1'\]/);
    assert.match(job(name), /runs-on: ubuntu-latest/);
    assert.match(job(name), /timeout-minutes: 20/);
    assert.doesNotMatch(job(name), /continue-on-error/);
  }
  assert.match(job('verify-static'), /node scripts\/public-verify\.mjs static 24/);
  assert.match(job('native-selfhost'), /node scripts\/selfhost-smoke\.mjs/);
});

test('public shards share per-version builds and package smoke runs only in the static matrix', () => {
  const staticJob = job('verify-static'),
    tests = job('verify-tests');
  assert.match(tests, /needs: \[scope, verify-static\]/);
  assert.match(tests, /!cancelled\(\).*needs.scope.outputs.scope != 'docs'/);
  const shards = /shard: \[([^\]]+)\]/.exec(tests)[1].split(',').map(Number);
  assert.deepEqual(
    shards,
    Array.from({ length: 24 }, (_, index) => index),
  );
  assert.match(tests, /node scripts\/public-verify\.mjs \$\{\{ matrix.shard \}\} 24/);
  assert.match(staticJob, /node scripts\/check-documents\.mjs/);
  assert.equal((workflow.match(/npm run smoke:package/g) ?? []).length, 1);
  assert.match(staticJob, /npm run smoke:package/);
  assert.match(staticJob, /tar -czf .* dist hosted-web-dist/);
  assert.match(staticJob, /actions\/upload-artifact@v4/);
  assert.match(staticJob, /if-no-files-found: error/);
  assert.match(tests, /actions\/download-artifact@v4/);
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
