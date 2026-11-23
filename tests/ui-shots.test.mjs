// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { options } from '../scripts/ui-shots/options.mjs';

test('screenshot CLI validates pages and dimensions before using credentials or network', () => {
  const args = ['--base', 'http://localhost:5179', '--out', '/tmp/ui'];
  const result = options([...args, '--pages', 'now,intents,lane:abc,initiative:def,settings,device']);
  assert.equal(options([...args, '--diff-file', 'src/large.ts']).diffFile, 'src/large.ts');
  assert.deepEqual(result.widths, [1500, 390]);
  assert.deepEqual(result.themes, ['dark', 'light']);
  for (const bad of [
    ['--widths', 'NaN'],
    ['--height', '0'],
    ['--themes', 'system'],
    ['--pages', 'fake'],
    ['--pages', 'bootstrap'],
    ['--pages', 'review:'],
    // Old screenshot-flow pages have no rebuilt screen.
    ['--pages', 'review:def'],
    ['--pages', 'intent:one'],
    ['--pages', 'view:two'],
    ['--pages', 'settings:autonomy'],
  ])
    assert.throws(() => options([...args, ...bad]));
  assert.throws(
    () => options(['--base', 'https://user:password@example.test', '--out', '/tmp/ui']),
    /without credentials/,
  );
  assert.throws(() => options(['--base', 'https://example.test']), /--out/);
  assert.equal(options(['--help']).help, true);
});

test('screenshot readiness waits for real query results and fails closed on query errors', async () => {
  const { EventEmitter } = await import('node:events');
  const { observeData } = await import('../scripts/ui-shots/data.mjs');
  const page = new EventEmitter(),
    socket = new EventEmitter();
  socket.url = () => 'wss://synthetic.convex.cloud/api/sync';
  const settled = observeData(page);
  page.emit('websocket', socket);
  const send = (event, message) => socket.emit(event, { payload: JSON.stringify(message) });
  send('framesent', { type: 'ModifyQuerySet', modifications: [{ type: 'Add', queryId: 1 }] });
  let completed = false;
  const wait = settled().then(() => {
    completed = true;
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(completed, false, 'a rendered heading cannot stand in for missing data');
  send('framereceived', { type: 'Transition', modifications: [{ type: 'QueryUpdated', queryId: 1 }] });
  await wait;
  send('framereceived', {
    type: 'Transition',
    modifications: [{ type: 'QueryFailed', queryId: 1, errorMessage: 'private server details' }],
  });
  await assert.rejects(
    settled(),
    error => /query failed/.test(error.message) && !error.message.includes('private server details'),
  );
});

test('CLI errors redact malformed credentials and argument values before opening a browser', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'forge-ui-shots-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = join(directory, 'credentials.json'),
    marker = 'NEVER_PRINT_THIS_PASSWORD';
  await writeFile(credentials, `{ ${marker}`, { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ui-shots.mjs',
      '--base',
      'http://localhost:1',
      '--out',
      directory,
      '--credentials',
      credentials,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credentials/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
  const invalid = spawnSync(process.execPath, ['scripts/ui-shots.mjs', `--invalid=${marker}`], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(marker));
});

test('signed-out landing captures are separate from credentialed project captures', () => {
  const args = ['--base', 'http://localhost:5295', '--out', '/tmp/ui', '--pages'];
  assert.deepEqual(options([...args, 'landing']).pages, ['landing']);
  assert.throws(() => options([...args, 'landing,now']), /separately/);
});

test('home and Settings sections have signed-in screenshot routes', () => {
  const args = [
    '--base',
    'http://localhost:5179',
    '--out',
    '/tmp/ui',
    '--pages',
    'home,settings:checks,settings:access',
  ];
  assert.deepEqual(options(args).pages, ['home', 'settings:checks', 'settings:access']);
});

test('missing reader discovery is an optional rollout; other query failures remain errors', async () => {
  const { EventEmitter } = await import('node:events');
  const { observeData } = await import('../scripts/ui-shots/data.mjs');
  const page = new EventEmitter(),
    socket = new EventEmitter();
  socket.url = () => 'wss://example.convex.cloud/api/sync';
  const settled = observeData(page);
  page.emit('websocket', socket);
  const send = (event, message) => socket.emit(event, { payload: JSON.stringify(message) });
  send('framesent', {
    type: 'ModifyQuerySet',
    modifications: [{ type: 'Add', queryId: 1, udfPath: 'projectReaders:shared' }],
  });
  send('framereceived', {
    type: 'Transition',
    modifications: [
      {
        type: 'QueryFailed',
        queryId: 1,
        errorMessage: "Could not find public function for 'projectReaders:shared'.",
      },
    ],
  });
  await settled();
  send('framereceived', {
    type: 'Transition',
    modifications: [{ type: 'QueryFailed', queryId: 1, errorMessage: 'PROJECT_UNAVAILABLE' }],
  });
  await assert.rejects(settled(), /query failed/);
});

test('Intents screenshot layout accepts only the real List and Board choices', () => {
  const base = ['--base', 'http://localhost:5173', '--out', '/tmp/forge-shots'];
  assert.equal(options([...base, '--intent-layout', 'board']).intentLayout, 'board');
  assert.throws(() => options([...base, '--intent-layout', 'timeline']), /must be list or board/);
});
