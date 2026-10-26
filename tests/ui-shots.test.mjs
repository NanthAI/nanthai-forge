// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { options, destination, selectedReviewRoute } from '../scripts/ui-shots/options.mjs';

test('screenshot routes preserve the hosted project and resolve review parent Intent', () => {
  const base = 'https://preview.example.test/';
  const expected = {
    now: 'overview',
    intents: 'intent',
    lanes: 'lanes',
    planning: 'planning',
    activity: 'coordination',
    code: 'delivery',
    'code-graph': 'delivery',
    settings: 'sharing',
    'lane:lane-id': 'lanes',
    'review:view-id': 'intent',
  };
  for (const [page, section] of Object.entries(expected)) {
    const url = new URL(destination(base, 'private-project', page, 'parent-intent'));
    assert.equal(url.origin, new URL(base).origin);
    assert.equal(url.searchParams.get('project'), 'private-project');
    assert.equal(url.searchParams.get('surface'), 'projects');
    assert.equal(url.searchParams.get('projectTab'), section);
    if (page.startsWith('review:')) {
      assert.equal(url.searchParams.get('reviewView'), 'view-id');
      assert.equal(url.searchParams.get('intent'), 'parent-intent');
      assert.equal(url.searchParams.get('intentTab'), 'delivery');
      assert.equal(url.searchParams.get('classic'), '1');
    }
  }
  assert.equal(destination(base, 'project', 'device'), `${base}device`);
  assert.throws(() => destination(base, 'project', 'review:id'), /parent Intent/);
});

test('screenshot CLI validates pages and dimensions before using credentials or network', () => {
  const args = ['--base', 'http://localhost:5179', '--out', '/tmp/ui'];
  const result = options([...args, '--pages', 'now,intents,lane:abc,review:def,settings,device']);
  assert.equal(options([...args, '--diff-file', 'src/large.ts']).diffFile, 'src/large.ts');
  assert.deepEqual(result.widths, [1500, 390]);
  assert.deepEqual(result.themes, ['dark', 'light']);
  for (const bad of [
    ['--widths', 'NaN'],
    ['--height', '0'],
    ['--themes', 'system'],
    ['--pages', 'fake'],
    ['--pages', 'review:'],
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

test('Convex token selection supports both the current Clerk integration and legacy templates', async t => {
  const { convexToken } = await import('../scripts/ui-shots/browser.mjs');
  const previous = globalThis.window;
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  const sessionToken = audience =>
    `header.${Buffer.from(JSON.stringify({ aud: audience })).toString('base64url')}.signature`;
  const page = { evaluate: callback => callback() },
    calls = [];
  const native = sessionToken('convex');
  globalThis.window = {
    Clerk: {
      session: {
        getToken: async options => {
          calls.push(options);
          assert.equal(options, undefined, 'native integration must never request a missing legacy template');
          return native;
        },
      },
    },
  };
  assert.equal(await convexToken(page), native);
  assert.equal(calls.length, 1);
  calls.length = 0;
  globalThis.window.Clerk.session.getToken = async options => {
    calls.push(options);
    return options?.template === 'convex' ? 'legacy-convex-token' : sessionToken(undefined);
  };
  assert.equal(await convexToken(page), 'legacy-convex-token');
  assert.deepEqual(calls, [undefined, { template: 'convex' }]);
  globalThis.window.Clerk.session = null;
  assert.equal(await convexToken(page), null);
});

test('signed-out landing captures are separate from credentialed project captures', () => {
  const args = ['--base', 'http://localhost:5295', '--out', '/tmp/ui', '--pages'];
  assert.deepEqual(options([...args, 'landing']).pages, ['landing']);
  assert.equal(destination('http://localhost:5295/', undefined, 'landing'), 'http://localhost:5295/');
  assert.throws(() => options([...args, 'landing,now']), /separately/);
});

test('Lane screenshot variants validate before sign-in and keep default captures unified', () => {
  const args = ['--base', 'http://localhost:5294', '--out', '/tmp/ui'];
  assert.deepEqual(options(args).variants, ['unified']);
  assert.deepEqual(options([...args, '--variants', 'split,inline,side-closed,files-closed']).variants, [
    'split',
    'inline',
    'side-closed',
    'files-closed',
  ]);
  assert.throws(() => options([...args, '--variants', 'unknown']), /Unknown Lane variant/);
});

test('review capture follows only the same project and exact lossless View route', () => {
  const id = '0199e87f-78a6-4388-bfa4-d8f8f6ba279b';
  const selected = `https://preview.test/dino/forge~project/review/v-${Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url')}`;
  assert.equal(selectedReviewRoute(selected, 'https://preview.test/?project=project', 'project', id), true);
  assert.equal(
    selectedReviewRoute(selected.replace('~project', '~other'), 'https://preview.test/', 'project', id),
    false,
  );
  assert.equal(
    selectedReviewRoute(
      selected.replace('preview.test', 'other.test'),
      'https://preview.test/',
      'project',
      id,
    ),
    false,
  );
  assert.equal(selectedReviewRoute(selected, 'https://preview.test/', 'project', 'another-view'), false);
});

test('Intent and View screenshot destinations preserve their selected record', () => {
  const base = 'http://localhost:5393';
  const intent = new URL(destination(base, 'project', 'intent:intent-id'));
  assert.equal(intent.searchParams.get('intent'), 'intent-id');
  const view = new URL(destination(base, 'project', 'view:view-id'));
  assert.equal(view.searchParams.get('projectTab'), 'views');
  assert.equal(view.searchParams.get('viewId'), 'view-id');
  assert.deepEqual(options(['--base', base, '--out', '/tmp/ui', '--pages', 'intent:one,view:two']).pages, [
    'intent:one',
    'view:two',
  ]);
});

test('home and Settings sections have signed-in screenshot routes', () => {
  const args = [
    '--base',
    'http://localhost:5179',
    '--out',
    '/tmp/ui',
    '--pages',
    'home,settings:autonomy,settings:checks,settings:access',
  ];
  assert.deepEqual(options(args).pages, ['home', 'settings:autonomy', 'settings:checks', 'settings:access']);
  const home = new URL(destination('http://localhost:5179', 'p', 'home'));
  assert.equal(home.searchParams.get('project'), null);
  assert.equal(home.searchParams.get('surface'), 'projects');
  const settings = new URL(destination('http://localhost:5179', 'p', 'settings:autonomy'));
  assert.equal(settings.searchParams.get('settingsSection'), 'autonomy');
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

test('synthetic bootstrap captures are isolated from signed-in routes', () => {
  const args = ['--base', 'http://localhost:5179', '--out', '/tmp/ui'];
  assert.deepEqual(options([...args, '--pages', 'bootstrap']).pages, ['bootstrap']);
  assert.throws(() => options([...args, '--pages', 'bootstrap,home']), /separately/);
});
