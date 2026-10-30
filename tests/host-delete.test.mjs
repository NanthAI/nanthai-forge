// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import './check-runtime.mjs';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { readHostState, updateHostState, abandonPendingHost } from '../dist/host-binding.js';
import { writeAuth } from '../dist/auth-store.js';
import { coordinationClient } from '../dist/coordination-client.js';
import { deleteHostedProject, parseDeleteProjectOptions } from '../dist/host-delete.js';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const deployment = 'https://fixture.convex.cloud';
function setup(t, { bound = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-delete-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'hello.ts'), 'export const hello = 1;\n');
  initNative(root);
  const store = new WorkStore(root);
  if (bound)
    updateHostState(store, current => {
      current.binding = {
        projectId: 'project',
        deployment,
        projectUrl: 'https://forge.example/owner/synthetic',
        operationId: randomUUID(),
        name: 'Synthetic',
        visibility: 'private',
        backupId: 'backup',
      };
    });
  const calls = [];
  let project = { id: 'project', slug: 'synthetic', name: 'Synthetic', revision: 7, currentBackup: null };
  const client = {
    query: async (ref, args) => {
      calls.push({ name: getFunctionName(ref), args });
      return { page: [structuredClone(project)], isDone: true, continueCursor: '' };
    },
    mutation: async (ref, args) => {
      calls.push({ name: getFunctionName(ref), args });
      project = { ...project, name: '', removal: 'deleted', revision: project.revision + 1 };
      return null;
    },
  };
  return {
    root,
    store,
    calls,
    client,
    options: { projectId: 'project', confirm: 'synthetic', deployment },
    project: value => {
      project = value;
    },
  };
}
const code = expected => error => error.code === expected;
test('delete refuses missing or mismatched slug confirmation before mutation or journal creation', async t => {
  const f = setup(t);
  for (const confirm of ['', 'Synthetic', 'other'])
    await assert.rejects(
      deleteHostedProject(f.root, { ...f.options, confirm }, { client: f.client }),
      code('HOST_DELETE_CONFIRM_MISMATCH'),
    );
  assert.equal(
    f.calls.some(call => call.name.includes('permanentlyDelete')),
    false,
  );
  assert.equal(
    readdirSync(f.store.directory).some(name => name.startsWith('host-delete-')),
    false,
  );
  assert.throws(() => parseDeleteProjectOptions(['--delete-project', 'project']), code('BAD_ARGUMENT'));
});
test('bound project needs explicit override; another deployment is a different project', async t => {
  const f = setup(t, { bound: true });
  await assert.rejects(
    deleteHostedProject(f.root, f.options, { client: f.client }),
    code('HOST_DELETE_BOUND_PROJECT'),
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await deleteHostedProject(f.root, { ...f.options, allowBoundProject: true }, { client: f.client }))
      .purgeComplete,
    true,
  );
  assert.equal(readHostState(f.store).binding.projectId, 'project');
  const other = setup(t, { bound: true });
  assert.equal(
    (
      await deleteHostedProject(
        other.root,
        { ...other.options, deployment: 'https://other.convex.cloud' },
        { client: other.client },
      )
    ).purgeComplete,
    true,
  );
});
test('unbound owner sends the public mutation exact revision and saved operation and returns tombstone', async t => {
  const f = setup(t),
    progress = [];
  const result = await deleteHostedProject(
    f.root,
    { ...f.options, onProgress: line => progress.push(line) },
    { client: f.client },
  );
  assert.equal(result.project.removal, 'deleted');
  assert.equal(result.project.name, '');
  assert.equal(result.project.revision, 8);
  assert.equal(result.purgeComplete, true);
  assert.equal(progress.length, 2);
  assert.deepEqual(f.calls.find(call => call.name === 'projectLifecycle:permanentlyDelete').args, {
    projectId: 'project',
    operationId: result.operationId,
    expectedRevision: 7,
  });
  const journal = join(
    f.store.directory,
    readdirSync(f.store.directory).find(name => name.startsWith('host-delete-')),
  );
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).operationId, result.operationId);
  assert.equal(readHostState(f.store).binding, undefined);
  assert.equal(readFileSync(join(f.root, 'hello.ts'), 'utf8'), 'export const hello = 1;\n');
});
test('project lookup follows owner list pages and refuses unavailable or non-owner projects', async t => {
  const f = setup(t),
    query = f.client.query;
  f.client.query = (ref, args) =>
    args.paginationOpts.cursor === null
      ? Promise.resolve({ page: [{ id: 'other' }], isDone: false, continueCursor: 'next' })
      : query(ref, args);
  await deleteHostedProject(f.root, f.options, { client: f.client });
  assert.equal(f.calls[0].args.paginationOpts.cursor, 'next');
  f.client.query = async () => ({ page: [], isDone: true, continueCursor: '' });
  await assert.rejects(
    deleteHostedProject(f.root, f.options, { client: f.client }),
    code('PROJECT_UNAVAILABLE'),
  );
  f.client.query = async () => {
    throw new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'Owner access required.' });
  };
  await assert.rejects(
    deleteHostedProject(f.root, f.options, { client: f.client }),
    error => error.code === 'PROJECT_UNAVAILABLE' && error.message === 'Owner access required.',
  );
});
test('non-owner mutation errors are surfaced without claiming deletion', async t => {
  const f = setup(t),
    progress = [];
  f.client.mutation = async () => {
    throw new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'Current account is not the owner.' });
  };
  await assert.rejects(
    deleteHostedProject(
      f.root,
      { ...f.options, onProgress: line => progress.push(line) },
      { client: f.client },
    ),
    error => error.code === 'PROJECT_UNAVAILABLE' && error.message === 'Current account is not the owner.',
  );
  assert.equal(
    progress.some(line => line.includes('requested;')),
    false,
  );
});
test('bounded polling retains request on pending or unknown replies and retry reuses original pins', async t => {
  const f = setup(t),
    requests = [];
  f.client.mutation = async (_ref, args) => {
    requests.push(args);
    throw new Error('Synthetic lost reply');
  };
  await assert.rejects(
    deleteHostedProject(f.root, f.options, { client: f.client }),
    code('HOST_DELETE_INTERRUPTED'),
  );
  f.client.mutation = async (_ref, args) => {
    requests.push(args);
    return null;
  };
  f.project({
    id: 'project',
    slug: 'synthetic',
    name: 'Synthetic',
    revision: 8,
    currentBackup: null,
    removal: 'deleting',
  });
  await assert.rejects(
    deleteHostedProject(f.root, f.options, { client: f.client, pollAttempts: 2, pollIntervalMs: 0 }),
    code('HOST_DELETE_PENDING'),
  );
  assert.deepEqual(requests[1], requests[0]);
  f.project({
    id: 'project',
    slug: 'synthetic',
    name: '',
    revision: 8,
    currentBackup: null,
    removal: 'deleted',
  });
  const result = await deleteHostedProject(f.root, f.options, { client: f.client });
  assert.equal(result.operationId, requests[0].operationId);
  assert.equal(requests.length, 2);
});

test('an explicit retry refreshes stale pins only when newer active metadata proves deletion did not commit', async t => {
  const f = setup(t),
    requests = [],
    mutate = f.client.mutation;
  f.client.mutation = async (_ref, args) => {
    requests.push(args);
    throw new ConvexError({ code: 'WORK_STALE', message: 'Project changed.' });
  };
  await assert.rejects(deleteHostedProject(f.root, f.options, { client: f.client }), code('WORK_STALE'));
  f.project({ id: 'project', slug: 'renamed', name: 'Renamed', revision: 8, currentBackup: null });
  f.client.mutation = async (ref, args) => {
    requests.push(args);
    return mutate(ref, args);
  };
  await deleteHostedProject(f.root, { ...f.options, confirm: 'renamed' }, { client: f.client });
  assert.notEqual(requests[0].operationId, requests[1].operationId);
  assert.equal(requests[1].expectedRevision, 8);
});

test('real public handlers accept a CLI owner identity and scheduled purge reaches the tombstone', async t => {
  const f = setup(t),
    s = state([]),
    credentialId = randomUUID();
  s.tables.cliCredentials.set('device', {
    owner: 'owner',
    credentialId,
    scope: 'cli',
    revoked: false,
    expiresAt: Date.now() + 60_000,
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    key: randomUUID(),
    owner: 'owner',
    slug: 'synthetic',
    name: 'Synthetic',
    revision: 7,
    currentBackup: null,
  });
  let submitted = false,
    reads = 0,
    request;
  const client = {
    query: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectBackups:list');
      if (submitted && ++reads === 2) {
        for (let i = 0; s.tables.hostedProjects.get('project').removal === 'deleting'; i++) {
          assert.ok(i < 250);
          await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
        }
      }
      return backups.list._handler(s.ctx, args);
    },
    mutation: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectLifecycle:permanentlyDelete');
      request = args;
      submitted = true;
      return lifecycle.permanentlyDelete._handler(s.ctx, args);
    },
  };
  const result = await deleteHostedProject(f.root, f.options, { client, pollIntervalMs: 0 });
  assert.equal(reads, 2);
  assert.deepEqual(s.tables.hostedProjects.get('project').lifecycle, {
    operationId: request.operationId,
    expectedRevision: 7,
    action: 'delete',
  });
  assert.equal(result.project.removal, 'deleted');
  assert.equal(result.project.name, '');
  assert.equal(result.project.currentBackup, null);
  assert.ok(s.tables.hostedProjects.get('project').removedAt);
  // A valid device credential for another account cannot discover or delete it.
  s.tables.cliCredentials.get('device').owner = 'stranger';
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'stranger', forgeCredential: credentialId });
  await assert.rejects(deleteHostedProject(f.root, f.options, { client }), code('PROJECT_UNAVAILABLE'));
});
test('real CLI uses saved device authentication and emits progress plus the tombstone as JSON', async t => {
  const f = setup(t),
    routes = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(request.headers.authorization, 'Bearer synthetic-delete-device');
    routes.push({ path: body.path, args: body.args[0] });
    const deleted = routes.some(call => call.path === 'projectLifecycle:permanentlyDelete');
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        status: 'success',
        value:
          body.path === 'projectBackups:list'
            ? {
                page: [
                  {
                    id: 'project',
                    slug: 'synthetic',
                    name: deleted ? '' : 'Synthetic',
                    revision: deleted ? 8 : 7,
                    currentBackup: null,
                    ...(deleted ? { removal: 'deleted' } : {}),
                  },
                ],
                isDone: true,
                continueCursor: '',
              }
            : null,
      }),
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  writeAuth({
    defaultDeployment: url,
    deployments: {
      [url]: {
        token: 'synthetic-delete-device',
        credentialId: 'device',
        expiresAt: Date.now() + 60_000,
        name: 'Synthetic',
        scope: 'cli',
      },
    },
  });
  const env = { ...process.env };
  delete env.FORGE_AUTH_TOKEN;
  delete env.FORGE_DEPLOYMENT_URL;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      new URL('../dist/cli.js', import.meta.url).pathname,
      'host',
      f.root,
      '--delete-project',
      'project',
      '--confirm',
      'synthetic',
      '--json',
    ],
    { env },
  );
  const lines = stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.deepEqual(
    lines.map(line => line.type),
    ['host-delete-progress', 'host-delete-progress', 'host-delete-result'],
  );
  assert.equal(lines.at(-1).project.removal, 'deleted');
  assert.deepEqual(routes.find(call => call.path === 'projectLifecycle:permanentlyDelete').args, {
    projectId: 'project',
    operationId: lines.at(-1).operationId,
    expectedRevision: 7,
  });
  assert.equal((stdout + stderr).includes('synthetic-delete-device'), false);
});
test('delete parser accepts explicit bound override and rejects unrelated host actions', () => {
  assert.deepEqual(
    parseDeleteProjectOptions([
      '--delete-project',
      'project',
      '--confirm',
      'synthetic',
      '--allow-bound-project',
      '--deployment',
      deployment,
    ]),
    { projectId: 'project', confirm: 'synthetic', allowBoundProject: true, deployment },
  );
  for (const flags of [
    ['--delete-project', '--confirm', 'synthetic'],
    ['--delete-project', 'project', '--confirm', 'synthetic', '--new'],
  ])
    assert.throws(() => parseDeleteProjectOptions(flags), code('BAD_ARGUMENT'));
});

test('hosted client forwards the bounded observation abort signal to its HTTP transport', async () => {
  const client = coordinationClient('http://127.0.0.1:1', 'synthetic-device-token', {
    signal: AbortSignal.abort(),
  });
  await assert.rejects(
    client.query(makeFunctionReference('projectBackups:list'), {
      paginationOpts: { cursor: null, numItems: 100 },
    }),
    error => error.name === 'AbortError',
  );
});

test('a known stale rejection can retry and resume a different removal already underway', async t => {
  const f = setup(t),
    requests = [],
    mutate = f.client.mutation;
  f.client.mutation = async (_ref, args) => {
    requests.push(args);
    throw new ConvexError({ code: 'WORK_STALE', message: 'Another removal won.' });
  };
  await assert.rejects(deleteHostedProject(f.root, f.options, { client: f.client }), code('WORK_STALE'));
  f.project({
    id: 'project',
    slug: 'synthetic',
    name: 'Synthetic',
    revision: 8,
    currentBackup: null,
    removal: 'deleting',
  });
  f.client.mutation = async (ref, args) => {
    requests.push(args);
    return mutate(ref, args);
  };
  const result = await deleteHostedProject(f.root, f.options, { client: f.client });
  assert.equal(result.purgeComplete, true);
  assert.notEqual(requests[1].operationId, requests[0].operationId);
  assert.equal(requests[1].expectedRevision, 8);
});

test('blocked R2 maintenance is actionable immediately and retry retains the original delete operation', async t => {
  const f = setup(t),
    requests = [];
  f.client.mutation = async (_ref, args) => {
    requests.push(args);
    f.project({
      id: 'project',
      slug: 'synthetic',
      name: 'Synthetic',
      revision: 8,
      currentBackup: null,
      removal: 'deleting',
      purgeBlocked: 'R2_MAINTENANCE_DISABLED',
    });
  };
  await assert.rejects(
    deleteHostedProject(f.root, f.options, {
      client: f.client,
      wait: async () => assert.fail('blocked purge must not poll'),
    }),
    error =>
      error.code === 'R2_MAINTENANCE_DISABLED' &&
      error.message.includes('FORGE_R2_MAINTENANCE=1') &&
      error.message.includes('retry this command'),
  );
  const reads = f.calls.length;
  f.client.mutation = async (_ref, args) => {
    requests.push(args);
    f.project({
      id: 'project',
      slug: 'synthetic',
      name: '',
      revision: 8,
      currentBackup: null,
      removal: 'deleted',
    });
  };
  assert.equal((await deleteHostedProject(f.root, f.options, { client: f.client })).purgeComplete, true);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(reads, 2, 'one initial read and one blocked status read');
});

test('CLI names retry exhaustion without claiming completion', async t => {
  const f = setup(t);
  f.client.mutation = async () => {
    f.project({
      id: 'project',
      slug: 'synthetic',
      name: 'Synthetic',
      revision: 8,
      currentBackup: null,
      removal: 'deleting',
      purgeBlocked: 'R2_PURGE_RETRY_EXHAUSTED',
    });
  };
  await assert.rejects(
    deleteHostedProject(f.root, f.options, { client: f.client }),
    error => error.code === 'R2_PURGE_RETRY_EXHAUSTED' && error.message.includes('R2 storage failure'),
  );
});

test('CLI observation backs off modestly and stops at ten observations', async t => {
  const f = setup(t),
    delays = [];
  f.client.mutation = async () => null;
  await assert.rejects(
    deleteHostedProject(f.root, f.options, {
      client: f.client,
      wait: async (delay, signal) => {
        assert.equal(signal.aborted, false);
        delays.push(delay);
      },
    }),
    code('HOST_DELETE_PENDING'),
  );
  assert.deepEqual(delays, [2000, 4000, 8000, 10000, 10000, 10000, 10000, 10000, 10000]);
  assert.equal(f.calls.length, 11, 'one lookup plus ten finite status reads');
});

function pendingHost(projectId = 'project', selectedDeployment = deployment) {
  return {
    operationId: randomUUID(),
    deployment: selectedDeployment,
    name: 'Synthetic',
    visibility: 'private',
    revision: 1,
    pushId: randomUUID(),
    initializeId: randomUUID(),
    projectId,
    projectUrl: 'https://forge.example/owner/synthetic',
  };
}
test('deleting the pending host project clears only matching deployment/project under the binding lock and keeps a receipt', async t => {
  for (const match of [true, false, 'other-deployment']) {
    const f = setup(t),
      pending = pendingHost(
        match === false ? 'other-project' : 'project',
        match === 'other-deployment' ? 'https://other.convex.cloud' : deployment,
      );
    updateHostState(f.store, state => {
      state.hosting = pending;
    });
    const result = await deleteHostedProject(f.root, f.options, { client: f.client });
    const state = readHostState(f.store);
    assert.equal(result.pendingHostCleared, match === true);
    if (match === true) {
      assert.equal(state.hosting, undefined);
      assert.deepEqual(state.hostingReceipts[0].pending, pending);
      assert.equal(state.hostingReceipts[0].deletionOperationId, result.operationId);
      assert.equal(state.hostingReceipts[0].reason, 'project-deleted');
    } else assert.deepEqual(state.hosting, pending);
  }
});
test('confirmed abandon is local, replayable and cannot clear a replacement operation', async t => {
  const f = setup(t, { bound: true }),
    pending = pendingHost('half-seeded');
  updateHostState(f.store, state => {
    state.hosting = pending;
  });
  const binding = readHostState(f.store).binding;
  assert.throws(
    () => abandonPendingHost(f.store, pending.operationId, 'wrong'),
    code('HOST_ABANDON_CONFIRM_MISMATCH'),
  );
  assert.deepEqual(readHostState(f.store).hosting, pending);
  const result = abandonPendingHost(f.store, pending.operationId, pending.operationId);
  assert.equal(result.abandoned, true);
  assert.deepEqual(readHostState(f.store).binding, binding);
  assert.equal(readHostState(f.store).hosting, undefined);
  assert.deepEqual(abandonPendingHost(f.store, pending.operationId, pending.operationId), result);
  const replacement = pendingHost('new-project');
  updateHostState(f.store, state => {
    state.hosting = replacement;
  });
  assert.throws(
    () => abandonPendingHost(f.store, pending.operationId, pending.operationId),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.deepEqual(readHostState(f.store).hosting, replacement);
  assert.equal(f.calls.length, 0);
});
test('confirmation mismatch says where the slug is without leaking another project', async t => {
  const f = setup(t);
  await assert.rejects(
    deleteHostedProject(f.root, { ...f.options, confirm: 'wrong' }, { client: f.client }),
    error =>
      error.code === 'HOST_DELETE_CONFIRM_MISMATCH' &&
      /last segment of the project URL/.test(error.message) &&
      !error.message.includes('Synthetic'),
  );
});
