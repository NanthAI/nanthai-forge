// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { withWorkProgress, workProgress } from '../dist/work-progress.js';
const cliPath = resolve('dist/cli.js');
function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
test('packaged docs work outside a project, with discoverable help and safe names', () => {
  assert.match(cli(['--help']).stdout, /^Forge is a source host/);
  assert.match(cli(['--help']).stdout, /nforge docs quickstart/);
  assert.match(cli(['docs']).stdout, /docs\/quickstart.md/);
  assert.match(cli(['docs', '--help']).stdout, /nforge docs \[name\]/);
  assert.match(cli(['docs', 'quickstart']).stdout, /Import GitHub source into a hosted project/);
  assert.match(cli(['docs', 'agent']).stdout, /Forge/);
  assert.match(cli(['agent', '--help']).stdout, /nforge docs agent/);
  const denied = spawnSync(process.execPath, [cliPath, 'docs', '../package.json'], { encoding: 'utf8' });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Unknown packaged document/);
});
test('lock diagnostics appear once, followed by throttled progress', () => {
  const originalWrite = process.stderr.write,
    originalNow = Date.now;
  let output = '',
    now = 10000;
  process.stderr.write = chunk => {
    output += chunk;
    return true;
  };
  Date.now = () => now;
  try {
    withWorkProgress({}, () => {
      workProgress('waiting for lock', 'waiting for holder; queue position=2', '/lock');
      now += 100;
      workProgress('waiting for lock', 'waiting for holder (started 1s ago); queue position=1', '/lock');
      now += 5000;
      workProgress('waiting for lock', 'waiting for holder (started 6s ago); queue position=1', '/lock');
    });
  } finally {
    process.stderr.write = originalWrite;
    Date.now = originalNow;
  }
  assert.equal(output.match(/waiting for holder/g).length, 1);
  assert.match(output, /progress queue position=1/);
  assert.equal(output.trim().split('\n').length, 2);
});
