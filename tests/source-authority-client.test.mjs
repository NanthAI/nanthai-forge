// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { hostedWorkCli } from '../dist/hosted-work-cli.js';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { initNative, nativeExecute } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
import {
  transitionBoundSourceAuthority,
  rememberSourceAuthorityError,
} from '../dist/source-authority-client.js';
import { consumeOwnerRequests } from '../dist/owner-acceptance-consumer.js';
import { hostedActionError } from '../dist/hosted-action-error.js';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const backend = await import(moduleUrl('../convex/projectSourceAuthority.ts'));
const native = { mode: 'native-owner', epoch: 0 };
const server = { mode: 'server', epoch: 1 };
const stale = authority =>
  new ConvexError({ code: 'SOURCE_AUTHORITY_STALE', message: 'Source authority changed.', authority });
const isStale = error => (error.data?.code ?? error.code) === 'SOURCE_AUTHORITY_STALE';
// Once hosted holds authority, local acceptance names the hosted writer instead of a stale pin.
const isHosted = error => error.code === 'HOSTED_AUTHORITY';
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-source-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'synthetic source\n');
  const head = initNative(root).head,
    store = new WorkStore(root),
    s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    name: 'Synthetic authority',
    key: randomUUID(),
    currentBackup: null,
    revision: 0,
  });
  updateHostState(store, state => {
    state.binding = {
      projectId,
      operationId: randomUUID(),
      deployment: 'http://127.0.0.1:1',
      projectUrl: 'https://example.invalid/project',
      name: 'Synthetic',
      visibility: 'private',
      backupId: 'backup',
      acceptanceOwner: true,
      autoSync: false,
    };
  });
  const command = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: randomUUID(),
    expectedHead: head,
    expectedPrevious: null,
  };
  // A retained clean Candidate allows real local acceptance before the switch.
  store.locked(() => {
    const data = store.load();
    const intentId = randomUUID(),
      at = '2026-01-01T00:00:00.000Z';
    data.intents.push({
      id: intentId,
      outcome: 'Synthetic',
      constraints: '',
      base: head,
      status: 'active',
      notes: [],
      createdAt: at,
    });
    data.views.push({
      id: command.viewId,
      intentId,
      head,
      base: head,
      inputs: [],
      dependencies: [],
      status: 'clean',
      details: '',
      at,
    });
    data.revision++;
    store.save(data);
  });
  const client = {
    mutation: (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectSourceAuthority:transition');
      return s.call('transition', backend.transition, args);
    },
  };
  return { root, store, s, projectId, command, client };
}

test('owner transition journals before IO and resumes a hosted success whose reply was lost', async t => {
  const f = setup(t),
    input = { operationId: randomUUID(), expected: native, mode: 'server' };
  const client = {
    mutation: async (ref, args) => {
      assert.equal(readHostState(f.store).authorityTransition.operationId, input.operationId);
      assert.equal(readHostState(f.store).binding.sourceAuthority, undefined, 'no local switch before CAS');
      await f.client.mutation(ref, args);
      throw Error('synthetic death after hosted CAS before local pin');
    },
  };
  await assert.rejects(
    transitionBoundSourceAuthority(f.store, input, client),
    /Hosted source authority transition failed/,
  );
  assert.deepEqual(f.s.tables.hostedProjects.get(f.projectId).sourceAuthority, server);
  assert.equal(readHostState(f.store).binding.sourceAuthority, undefined);
  assert.equal(readHostState(f.store).authorityTransition.operationId, input.operationId);
  const reopened = new WorkStore(f.root);
  assert.deepEqual(await transitionBoundSourceAuthority(reopened, input, f.client), server);
  assert.deepEqual(readHostState(reopened).binding.sourceAuthority, server);
  assert.equal(readHostState(reopened).authorityTransition, undefined);
  assert.equal(f.s.tables.projectSourceAuthorityTransitions.size, 1);
  assert.throws(() => nativeExecute(reopened, f.command, reopened.revision()), isHosted);
  const rollback = { operationId: randomUUID(), expected: server, mode: 'native-owner' };
  assert.deepEqual(await transitionBoundSourceAuthority(reopened, rollback, f.client), {
    mode: 'native-owner',
    epoch: 2,
  });
  assert.throws(
    () => nativeExecute(reopened, { ...f.command, authorityEpoch: 0 }, reopened.revision()),
    isStale,
  );
  assert.equal(nativeExecute(reopened, f.command, reopened.revision()).result.status, 'accepted');
});

test('failed hosted CAS never installs its proposed local authority; stale feedback persists the actual newer pin', async t => {
  const f = setup(t);
  await f.s.call('other-transition', backend.transition, {
    projectId: f.projectId,
    operationId: randomUUID(),
    expected: native,
    mode: 'server-shadow',
  });
  const input = { operationId: randomUUID(), expected: native, mode: 'server' };
  await assert.rejects(transitionBoundSourceAuthority(f.store, input, f.client), isStale);
  assert.deepEqual(readHostState(f.store).binding.sourceAuthority, { mode: 'server-shadow', epoch: 1 });
  assert.equal(
    readHostState(f.store).authorityTransition,
    undefined,
    'known CAS rejection does not strand the owner command',
  );
  assert.throws(() => nativeExecute(f.store, f.command, f.store.revision()), isStale);
});

test('completed transition replays its immutable drain proof after local work and rollback have advanced', async t => {
  const f = setup(t),
    input = { operationId: randomUUID(), expected: native, mode: 'server' };
  assert.deepEqual(await transitionBoundSourceAuthority(f.store, input, f.client), server);
  const rolledBack = { mode: 'native-owner', epoch: 2 };
  assert.deepEqual(
    await transitionBoundSourceAuthority(
      f.store,
      { operationId: randomUUID(), expected: server, mode: 'native-owner' },
      f.client,
    ),
    rolledBack,
  );
  mkdirSync(join(f.store.directory, 'native-submissions'));
  writeFileSync(
    join(f.store.directory, 'native-submissions', `${randomUUID()}.json`),
    JSON.stringify({ command: { action: 'land' } }),
  );
  assert.deepEqual(await transitionBoundSourceAuthority(f.store, input, f.client), server);
  assert.deepEqual(
    readHostState(f.store).binding.sourceAuthority,
    rolledBack,
    'old replay never rewinds the binding',
  );
  assert.equal(f.s.tables.projectSourceAuthorityTransitions.size, 2);
});

test('normal offline accepts work at epoch zero; owner writer stale feedback blocks subsequent local accepts', async t => {
  const f = setup(t);
  assert.equal(nativeExecute(f.store, f.command, f.store.revision()).result.status, 'accepted');
  const revision = f.store.revision();
  let calls = 0;
  await assert.rejects(
    consumeOwnerRequests(f.store, {
      mutation: async () => {
        calls++;
        throw stale(server);
      },
    }),
    isStale,
  );
  assert.equal(calls, 1);
  assert.deepEqual(readHostState(f.store).binding.sourceAuthority, server);
  assert.throws(
    () => nativeExecute(f.store, f.command, f.store.revision()),
    error => {
      assert.equal(error.code, 'HOSTED_AUTHORITY');
      return true;
    },
  );
  assert.equal(f.store.revision(), revision);
  // Delayed errors from older calls and other projects cannot rewind or poison this binding.
  rememberSourceAuthorityError(f.store, stale({ mode: 'native-owner', epoch: 0 }), f.projectId);
  rememberSourceAuthorityError(f.store, stale({ mode: 'server', epoch: 9 }), 'foreign-project');
  assert.deepEqual(readHostState(f.store).binding.sourceAuthority, server);
  assert.deepEqual(
    hostedActionError(stale(server), 'test').authority,
    server,
    'error normalization preserves feedback',
  );
});

test('native acceptance checks the authority again under the owner lock', t => {
  const f = setup(t);
  const locked = f.store.locked.bind(f.store);
  f.store.locked = fn => {
    f.store.locked = locked;
    updateHostState(f.store, state => {
      state.binding.sourceAuthority = server;
    });
    return locked(fn);
  };
  assert.throws(() => nativeExecute(f.store, f.command, f.store.revision()), isHosted);
  assert.equal(f.store.load().channelMoves.length, 0);
});

test('bound hosted-work accept retains structured stale feedback and updates the owner pin', async t => {
  const f = setup(t);
  let calls = 0;
  const http = createServer((request, response) => {
    calls++;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: 'error',
        errorMessage: 'Source authority changed.',
        errorData: {
          code: 'SOURCE_AUTHORITY_STALE',
          message: 'Source authority changed.',
          authority: server,
        },
      }),
    );
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => http.close());
  const previousToken = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-owner-credential';
  t.after(() => {
    if (previousToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previousToken;
  });
  updateHostState(f.store, state => {
    state.binding.deployment = `http://127.0.0.1:${http.address().port}`;
  });
  await assert.rejects(
    hostedWorkCli([
      f.root,
      JSON.stringify({
        action: 'accept',
        operationId: randomUUID(),
        revision: 0,
        viewId: randomUUID(),
        head: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        previousId: null,
      }),
    ]),
    isStale,
  );
  assert.equal(calls, 1);
  assert.deepEqual(readHostState(f.store).binding.sourceAuthority, server);
  assert.throws(() => nativeExecute(f.store, f.command, f.store.revision()), isHosted);
});
