// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { shellQuote } from '../dist/shell-quote.js';
import { nodeTestWithoutPaths } from '../dist/heavy-slots.js';
import { withSourceRecovery } from '../dist/hosted-agent-source-recovery.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('native heavy preserves whitespace, quotes and multiline arguments without shell splitting', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-argv-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const args = ['two words', "it's quoted", 'first\nsecond', '$(literal)', '*'];
  const result = spawnSync(
    process.execPath,
    [
      'dist/cli-entry.js',
      'heavy',
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, FORGE_HEAVY_DIR: directory } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('friction 7ea3a168: heavy treats a leading -- as the end of its own options', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-dashdash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const heavy = (...args) =>
    spawnSync(process.execPath, ['dist/cli-entry.js', 'heavy', ...args], {
      encoding: 'utf8',
      env: { ...process.env, FORGE_HEAVY_DIR: directory },
    });
  const echo = [
    process.execPath,
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    'plain',
    'two words',
  ];
  for (const prefix of [['--'], ['--no-build', '--']]) {
    const result = heavy(...prefix, ...echo);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['plain', 'two words']);
  }
  const bare = heavy('--');
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr + bare.stdout, /heavy -- needs a command/);
});

test('593fc2d7: heavy status and heavy help (bare words) answer at once and never queue a command', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-bare-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Before the fix the word was spawned as a command: it took a slot (after any queue) and failed ENOENT.
  const env = { ...process.env, FORGE_HEAVY_DIR: directory };
  const heavy = (...args) =>
    spawnSync(process.execPath, ['dist/cli-entry.js', 'heavy', ...args], {
      encoding: 'utf8',
      env,
      timeout: 20_000,
    });
  const status = heavy('status');
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(Object.keys(JSON.parse(status.stdout)), Object.keys(JSON.parse(heavy('--status').stdout)));
  const help = heavy('help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^nforge heavy \[--\] CMD/);
  // A real command of that name still runs after --.
  const named = heavy('--', process.execPath, '-e', 'process.stdout.write("ran")');
  assert.equal(named.stdout, 'ran');
});

test('native save distinguishes completed receipts from pending exact-operation replay without extra calls', async () => {
  const operationId = 'a8526d55-dada-4c33-a1a4-c00f9b25ef70';
  const command = {
    laneId: '84a29ed7-aead-4c58-96cd-3d58d807947b',
    message: "It's a saved\nmessage",
    operationId,
  };
  const session = {
    root: '/synthetic',
    address: { url: 'https://fixture.invalid', projectId: 'synthetic' },
    journal: { operationId, id: () => assert.fail('No new operation for pending or completed save') },
  };
  const completed = { outcome: { status: 'completed', result: { head: 'a'.repeat(64) } } };
  assert.equal(await withSourceRecovery(session, 'save', command, completed), completed);
  assert.equal(completed.status, undefined, 'completed save is never labelled submitted');
  const pending = { jobId: 'job', status: 'submitted' };
  const reply = await withSourceRecovery(session, 'save', command, pending);
  assert.equal(reply.replay.operationId, operationId);
  assert.equal(reply.next.operationId, operationId);
  assert.equal(reply.replay.message, command.message);
  assert.equal(reply.replay.command, reply.command);
  assert(reply.command.includes(operationId));
  const capture = `${shellQuote(process.execPath)} -e ${shellQuote('process.stdout.write(JSON.stringify(process.argv.slice(1)))')} -- `;
  const replay = spawnSync('/bin/sh', ['-c', reply.command.replace(/^nforge /, capture)], {
    encoding: 'utf8',
  });
  assert.equal(replay.status, 0, replay.stderr);
  const args = JSON.parse(replay.stdout);
  assert.deepEqual(args.slice(0, 3), ['agent', '/synthetic', 'save']);
  assert.deepEqual(JSON.parse(args[3]), { action: 'save', ...session.address, ...command });
  assert.deepEqual(await withSourceRecovery(session, 'save', command, pending), reply);
});

test('nodeTestWithoutPaths flags only node --test commands that name no test path', () => {
  const node = process.execPath;
  assert.equal(nodeTestWithoutPaths(['node', '--test']), true);
  assert.equal(nodeTestWithoutPaths([node, '--test', '--test-concurrency=1']), true);
  assert.equal(nodeTestWithoutPaths(['node', '--import', './tests/check-runtime.mjs', '--test']), true);
  assert.equal(nodeTestWithoutPaths(['node', '--test', '--test-reporter', 'dot']), true);
  assert.equal(nodeTestWithoutPaths(['node', '--test', '']), true, 'an empty quoted variable');
  assert.equal(nodeTestWithoutPaths(['node', '--test', '  ', '--']), true);
  assert.equal(nodeTestWithoutPaths(['node', '--test', 'tests/a.test.mjs']), false);
  assert.equal(
    nodeTestWithoutPaths(['node', '--import', 'x.mjs', '--test', '--', 'tests/a.test.mjs']),
    false,
  );
  assert.equal(nodeTestWithoutPaths(['node', 'script.mjs']), false, 'not a test run');
  assert.equal(nodeTestWithoutPaths(['npm', 'test']), false, 'the explicit full-suite script is allowed');
  assert.equal(nodeTestWithoutPaths(['tsc', '--test']), false);
});

test('heavy refuses node --test with an empty file list and still runs a named file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-empty-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A directory with a failing test: if the guard fell through, Node would discover and run it.
  writeFileSync(
    join(directory, 'trap.test.mjs'),
    "import test from 'node:test'; test('trap', () => { throw new Error('ran'); });",
  );
  // A surrounding test runner's protocol variable would swallow the child's report.
  const env = { ...process.env, FORGE_HEAVY_DIR: join(directory, 'slots') };
  delete env.NODE_TEST_CONTEXT;
  const run = args =>
    spawnSync(process.execPath, [resolve('dist/cli-entry.js'), 'heavy', process.execPath, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env,
    });
  for (const args of [['--test'], ['--test', ''], ['--test', '--test-concurrency=1']]) {
    const result = run(args);
    assert.notEqual(result.status, 0, 'empty list must fail');
    assert.match(result.stderr, /no test file paths/);
    assert.doesNotMatch(result.stdout + result.stderr, /trap|# tests/);
  }
  writeFileSync(join(directory, 'ok.test.mjs'), "import test from 'node:test'; test('ok', () => {});");
  const named = run(['--test', 'ok.test.mjs']);
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /pass 1/);
});

test('scripts/test-files.mjs with no files runs nothing and never discovers a default suite', () => {
  const result = spawnSync(process.execPath, ['scripts/test-files.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'the static shard calls it with an empty list');
  assert.match(result.stdout, /# tests 0/);
});

test('CLI and MCP source recovery keeps a memory-envelope refusal terminal without advertising retry', async () => {
  const error = {
    code: 'SOURCE_STATE_TOO_LARGE',
    message:
      'sync: fileCount 56801 exceeds 56800. Split the repository. docs/operations/source-exchange.md#supported-repository-envelope',
  };
  const session = {
    journal: { id: () => assert.fail('terminal size refusal must not allocate another operation') },
  };
  for (const value of [
    { status: 'failed', jobId: 'retained', error },
    { outcome: { status: 'failed', error } },
  ])
    assert.equal(await withSourceRecovery(session, 'save', {}, value), value);
});

test('terminal source-size failures never gain a finish retry command after observation', async () => {
  const { normalizeHostedFinishResult } = await import('../dist/hosted-agent-finish-result.js');
  const error = { code: 'SOURCE_STATE_TOO_LARGE', message: 'Split the repository.' };
  const selection = { laneId: 'retained', operationId: 'original' };
  for (const result of [
    { submission: { phase: 'terminal-failed', error } },
    { phase: 'compose', progress: { status: 'failed', error } },
    { phase: 'save', progress: { outcome: { status: 'failed', error } } },
  ]) {
    const reply = normalizeHostedFinishResult('/synthetic', selection, result);
    assert.equal(reply.terminal, true);
    assert.equal(reply.retryCommand, undefined);
    assert.equal(reply.command, undefined);
    if (reply.landingState) assert.match(reply.landingState.nextStep, /Split the repository\./);
  }
});

test('dceb1bef: heavy gives its command one module cache, removes it after, and keeps an inherited one', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-modules-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The command fills the cache as a test run would and reports where it was.
  const fill = `const { mkdirSync, writeFileSync } = require('node:fs');
    const dir = process.env.FORGE_TEST_MODULE_DIRECTORY;
    mkdirSync(dir, { recursive: true }); writeFileSync(dir + '/compiled.mjs', '');
    process.stdout.write(dir);`;
  const heavy = inherited =>
    spawnSync(process.execPath, ['dist/cli-entry.js', 'heavy', '--no-build', process.execPath, '-e', fill], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGE_HEAVY_DIR: join(directory, 'slots'),
        FORGE_HEAVY_PARENT: '',
        FORGE_TEST_MODULE_DIRECTORY: inherited,
      },
    });
  const own = heavy('');
  assert.equal(own.status, 0, own.stderr);
  assert.ok(own.stdout, 'the command received a cache directory');
  assert.equal(existsSync(own.stdout), false, 'heavy removes the cache it created');
  const shared = join(directory, 'shared');
  const nested = heavy(shared);
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.stdout, shared);
  assert.ok(existsSync(join(shared, 'compiled.mjs')), 'an inherited cache belongs to whoever set it');
});
