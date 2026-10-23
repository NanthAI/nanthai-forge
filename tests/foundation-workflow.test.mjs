// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/foundation.yml', 'utf8');
const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][\w-]*:\n/)[0];

test('verification matrix is independent of native selfhost and preserves every failure', () => {
  for (const name of ['verify', 'native-selfhost']) {
    const text = job(name);
    assert.match(text, /^    needs: scope$/m);
    assert.match(text, /!cancelled\(\).*needs.scope.outputs.scope != 'docs'/);
    assert.doesNotMatch(text, /continue-on-error/);
  }
  assert.match(job('verify'), /strategy:\n      fail-fast: false\n      matrix:/);
  assert.match(job('verify'), /node: \['22\.23\.4', '24\.22\.1'\]/);
  assert.match(job('verify'), /npm run verify/);
  assert.match(job('native-selfhost'), /node scripts\/selfhost-smoke\.mjs/);
});

test('fixed Node 24 recipes agree with the generated check workflow', () => {
  const versions = [...workflow.matchAll(/node-version: '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(versions, ['24.22.1', '24.22.1', '24.22.1']);
  assert.match(readFileSync('.github/workflows/forge-check.yml', 'utf8'), /node-version: '24\.22\.1'/);
});
