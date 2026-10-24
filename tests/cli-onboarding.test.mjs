// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
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
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-onboarding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('packaged docs work outside a project, with discoverable help and safe names', () => {
  assert.match(cli(['--help']).stdout, /^Forge is a source host/);
  assert.match(cli(['--help']).stdout, /nforge docs quickstart/);
  assert.match(cli(['docs']).stdout, /docs\/quickstart.md/);
  assert.match(cli(['docs', '--help']).stdout, /nforge docs \[name\]/);
  assert.match(cli(['docs', 'quickstart']).stdout, /git -C "\$GIT_ROOT" rev-parse HEAD/);
  assert.match(cli(['docs', 'agent']).stdout, /Forge/);
  assert.match(cli(['agent', '--help']).stdout, /nforge docs agent/);
  const denied = spawnSync(process.execPath, [cliPath, 'docs', '../package.json'], { encoding: 'utf8' });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /Unknown packaged document/);
});
test('HEAD rejection explains exact commit selection; import prints the main bootstrap next step', t => {
  const dir = fixture(t),
    root = join(dir, 'git'),
    target = join(dir, 'native');
  mkdirSync(root);
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  writeFileSync(join(root, 'file.txt'), 'base\n');
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const rejected = spawnSync(process.execPath, [cliPath, 'import-native-git', root, 'HEAD', target], {
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /git rev-parse HEAD/);
  const imported = JSON.parse(cli(['import-native-git', root, git(['rev-parse', 'HEAD']), target]).stdout);
  assert.match(imported.main, /accepts the checked Candidate to establish main/);
  assert.match(imported.nextCommand, /nforge agent .* start/);
  assert.equal(new WorkStore(target).load().channelMoves.length, 0);
});
test('start records explicit and environment actor names; supervised finish ends with review command', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'check.mjs'), 'process.exit(0);\n');
  initNative(root);
  const start = actor =>
    JSON.parse(
      cli(
        ['agent', root, 'start', JSON.stringify({ outcome: 'Test onboarding', ...(actor ? { actor } : {}) })],
        { FORGE_AGENT_NAME: 'shell-agent' },
      ).stdout,
    ).result;
  assert.equal(start('explicit-agent').startedBy.name, 'explicit-agent');
  const lane = start();
  assert.equal(lane.startedBy.name, 'shell-agent');
  assert.equal(new WorkStore(root).select('lanes', lane.laneId).startedBy.name, 'shell-agent');
  cli([
    'agent',
    root,
    'define-check',
    JSON.stringify({
      name: 'verify',
      executable: process.execPath,
      args: ['check.mjs'],
      environmentLabel: 'Test Node',
    }),
  ]);
  writeFileSync(join(lane.path, 'file.txt'), 'change\n');
  const finished = cli([
    'agent',
    root,
    'finish',
    JSON.stringify({ laneId: lane.laneId, message: 'Change', accept: true }),
  ]);
  assert.equal(JSON.parse(finished.stdout).result.status, 'awaiting-review');
  assert.equal(
    finished.stderr.trim().split('\n').at(-1),
    `Next: nforge serve '${root}' — open Review and accept the checked Candidate as a person.`,
  );
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
