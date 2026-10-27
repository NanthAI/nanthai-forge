import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixture, git, write } from './helpers.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000 });

test('built CLI indexes a real worktree, queries, detects edits and re-indexes', t => {
  const root = fixture(t, { 'a.ts': 'export function greet() { return "hello"; }' });
  const indexed = run('index', root);
  assert.equal(indexed.status, 0, indexed.stderr);
  assert.equal(JSON.parse(indexed.stdout).files, 1);
  const inspected = run('inspect', root, 'greet');
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).results[0].name, 'greet');
  write(root, 'a.ts', 'export function goodbye() { return "bye"; }');
  const stale = run('inspect', root, 'greet');
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stderr).error.code, 'SOURCE_STALE');
  assert.equal(run('index', root).status, 0);
  assert.equal(JSON.parse(run('inspect', root, 'goodbye').stdout).total, 1);
});

test('CLI has useful help and structured argument errors', () => {
  assert.equal(run('--help').status, 0);
  for (const args of [
    ['index'],
    ['unknown', '.'],
    ['index', '.', '--limit', '2'],
    ['inspect', '.', 'x', '--limit', 'NaN'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'BAD_ARGUMENT');
  }
});

test('Work command files preserve literal input and existing revision checks', t => {
  const root = fixture(t, { 'a.ts': 'export const ready = true;' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Initial source']);
  const command = {
    action: 'intent',
    outcome: 'A "quoted" outcome',
    constraints: 'First line\nLiteral $(not-a-command) and `backticks`',
  };
  write(root, 'work-command.json', JSON.stringify(command));
  const file = join(root, 'work-command.json');
  const created = run('work', root, '--command-file', file, '0');
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).result.constraints, command.constraints);
  const stale = run('work', root, '--command-file', file, '0');
  assert.equal(JSON.parse(stale.stderr).error.code, 'WORK_STALE');
  const inline = run(
    'work',
    root,
    JSON.stringify({
      action: 'note',
      intentId: JSON.parse(created.stdout).result.id,
      kind: 'decision',
      text: 'Inline still works',
    }),
    '1',
  );
  assert.equal(inline.status, 0, inline.stderr);
  write(root, 'invalid.json', 'not JSON');
  for (const args of [
    ['--command-file', join(root, 'missing.json'), '2'],
    ['--command-file', join(root, 'invalid.json'), '2'],
    ['--unknown', file, '2'],
  ]) {
    const failed = run('work', root, ...args);
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stderr).error.code, 'BAD_ARGUMENT');
  }
  const status = JSON.parse(run('work', root).stdout);
  assert.equal(status.counts.intents, 1);
  const detail = JSON.parse(run('work', root, '--compact').stdout);
  assert.equal(detail.intents[0].outcome, command.outcome);
  assert.equal(detail.intents[0].notes[0].text, 'Inline still works');
  assert.equal(status.revision, 2);
});
