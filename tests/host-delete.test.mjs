// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
import { hostedAgentDirectory } from '../dist/hosted-agent-journal.js';
import { moduleUrl } from './convex-module.mjs';
import { state, projectRow } from './hosted-fixture.mjs';
import { settleR2Purge } from './default-r2.mjs';
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const { purgeSettleMs } = await import(moduleUrl('../convex/projectRetention.ts'));
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
      return structuredClone(project);
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
function cancelledWait(client) {
  const controller = new AbortController();
  return {
    client,
    signal: controller.signal,
    subscribe: () => ({
      onUpdate: () => {
        queueMicrotask(() => controller.abort());
        return () => {};
      },
      close: async () => {},
    }),
  };
}
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
    confirm: 'synthetic',
  });
  const journal = join(
    f.store.directory,
    readdirSync(f.store.directory).find(name => name.startsWith('host-delete-')),
  );
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).operationId, result.operationId);
  assert.equal(readHostState(f.store).binding, undefined);
  assert.equal(readFileSync(join(f.root, 'hello.ts'), 'utf8'), 'export const hello = 1;\n');
});
test('project lookup refuses unavailable or non-owner projects before saving a deletion', async t => {
  const f = setup(t);
  f.client.query = async () => null;
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
  assert.equal(f.calls.length, 0);
  assert.equal(
    readdirSync(f.store.directory).some(name => name.startsWith('host-delete-')),
    false,
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
test('subscription deadline retains request on pending or unknown replies and retry reuses original pins', async t => {
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
    deleteHostedProject(f.root, f.options, cancelledWait(f.client)),
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
      assert.equal(getFunctionName(ref), 'projectBackups:deletionStatus');
      if (submitted) reads++;
      return backups.deletionStatus._handler(s.ctx, args);
    },
    mutation: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectLifecycle:permanentlyDelete');
      request = args;
      submitted = true;
      return lifecycle.permanentlyDelete._handler(s.ctx, args);
    },
  };
  let closed = false;
  const subscribe = () => ({
    onUpdate: (_ref, args, update, error) => {
      void (async () => {
        update(await backups.deletionStatus._handler(s.ctx, args));
        for (let i = 0; s.tables.hostedProjects.get('project').removal === 'deleting'; i++) {
          assert.ok(i < 250);
          s.tables.hostedProjects.get('project').removedAt -= purgeSettleMs;
          settleR2Purge(s.tables.hostedProjects.get('project'));
          await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
        }
        update(await backups.deletionStatus._handler(s.ctx, args));
      })().catch(error);
      return () => {};
    },
    close: async () => {
      closed = true;
    },
  });
  const result = await deleteHostedProject(f.root, f.options, { client, subscribe });
  assert.equal(reads, 1);
  assert.equal(closed, true);
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
          body.path === 'projectBackups:deletionStatus'
            ? {
                id: 'project',
                slug: 'synthetic',
                name: deleted ? '' : 'Synthetic',
                revision: deleted ? 8 : 7,
                currentBackup: null,
                ...(deleted ? { removal: 'deleted' } : {}),
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
    confirm: 'synthetic',
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
    client.query(makeFunctionReference('projectBackups:deletionStatus'), { projectId: 'project' }),
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

test('blocked R2 purge grant is actionable immediately and retry retains the original delete operation', async t => {
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
      purgeBlocked: 'R2_PURGE_UNAUTHORIZED',
    });
  };
  await assert.rejects(
    deleteHostedProject(f.root, f.options, {
      client: f.client,
      subscribe: () => assert.fail('blocked purge needs no live wait'),
    }),
    error =>
      error.code === 'R2_PURGE_UNAUTHORIZED' &&
      !error.message.includes('FORGE_R2_MAINTENANCE') &&
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

test('pending deletion makes zero idle calls and subscription closes on the exact project tombstone', async t => {
  const f = setup(t);
  f.client.mutation = async () => null;
  const ready = Promise.withResolvers();
  let update,
    unsubscribe = 0,
    closed = 0,
    subscriptions = 0;
  const waiting = deleteHostedProject(f.root, f.options, {
    client: f.client,
    subscribe: () => ({
      onUpdate: (ref, args, next) => {
        subscriptions++;
        assert.equal(getFunctionName(ref), 'projectBackups:deletionStatus');
        assert.deepEqual(args, { projectId: 'project' });
        update = next;
        ready.resolve();
        return () => {
          unsubscribe++;
        };
      },
      close: async () => {
        closed++;
      },
    }),
  });
  await ready.promise;
  assert.equal(f.calls.length, 2, 'two finite status reads, no catalog or idle reads');
  assert.equal(subscriptions, 1);
  update({ id: 'project', name: 'Synthetic', revision: 8, currentBackup: null, removal: 'deleting' });
  await Promise.resolve();
  assert.equal(f.calls.length, 2, 'a pending notification never starts another query');
  update({ id: 'project', name: '', revision: 8, currentBackup: null, removal: 'deleted' });
  assert.equal((await waiting).purgeComplete, true);
  assert.equal(unsubscribe, 1);
  assert.equal(closed, 1);
});

test('deletion subscription releases its connection on timeout, revoked access, missing project and transport errors', async t => {
  for (const outcome of ['deadline', 'AUTH_REVOKED', 'missing', 'transport']) {
    const f = setup(t);
    f.client.mutation = async () => null;
    const controller = new AbortController();
    let unsubscribed = 0,
      closed = 0;
    await assert.rejects(
      deleteHostedProject(f.root, f.options, {
        client: f.client,
        signal: controller.signal,
        subscribe: () => ({
          onUpdate: (_ref, _args, update, error) => {
            if (outcome === 'deadline') controller.abort();
            else if (outcome === 'missing') update(null);
            else
              error(
                outcome === 'AUTH_REVOKED'
                  ? new ConvexError({ code: 'AUTH_REVOKED', message: 'Revoked.' })
                  : new Error('Synthetic connection error'),
              );
            return () => {
              unsubscribed++;
            };
          },
          close: async () => {
            closed++;
          },
        }),
      }),
      code(
        {
          deadline: 'HOST_DELETE_PENDING',
          missing: 'PROJECT_UNAVAILABLE',
          transport: 'HOST_DELETE_INTERRUPTED',
          AUTH_REVOKED: 'AUTH_REVOKED',
        }[outcome],
      ),
    );
    assert.equal(unsubscribed, 1);
    assert.equal(closed, 1);
  }
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

/** An `nforge clone` of a project: marker plus private address, no Git, no native owner, no Work store. */
function cloneRoot(t, projectId = 'project') {
  const root = mkdtempSync(join(tmpdir(), 'forge-delete-clone-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(`${root}.forge-client`, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  mkdirSync(join(root, '.forge'));
  writeFileSync(join(root, '.forge', 'hosted-main.json'), JSON.stringify({ selection: { projectId } }));
  writeFileSync(
    join(hostedAgentDirectory(root), 'address.json'),
    JSON.stringify({ url: deployment, projectId }),
  );
  return root;
}
async function withoutGit(run) {
  const path = process.env.PATH;
  process.env.PATH = '';
  try {
    return await run();
  } finally {
    process.env.PATH = path;
  }
}
test('a project is deleted from its own nforge clone with no Git, using the clone address and the printed slug', async t => {
  const f = setup(t),
    root = cloneRoot(t);
  f.project({
    id: 'project',
    slug: 'bench-zoo-mixed-2',
    name: 'Bench zoo',
    revision: 3,
    currentBackup: null,
  });
  const options = { projectId: 'project', confirm: 'bench-zoo-mixed-2' };
  const result = await withoutGit(() => deleteHostedProject(root, options, { client: f.client }));
  assert.equal(result.purgeComplete, true);
  assert.equal(result.deployment, deployment, 'deployment comes from the clone address');
  assert.equal(result.pendingHostCleared, false);
  assert.equal(f.calls.filter(call => call.name.includes('permanentlyDelete')).length, 1);
  assert.equal(
    readdirSync(hostedAgentDirectory(root)).some(name => name.startsWith('host-delete-')),
    true,
  );
  assert.equal(readdirSync(root).includes('.git'), false);
  // The same command reconciles the saved operation instead of repeating the deletion.
  const again = await withoutGit(() => deleteHostedProject(root, options, { client: f.client }));
  assert.equal(again.operationId, result.operationId);
  assert.equal(f.calls.filter(call => call.name.includes('permanentlyDelete')).length, 1);
});
test('a duplicate-name import has a suffixed slug: the plain name is refused and the refusal names the slug', async t => {
  const f = setup(t),
    root = cloneRoot(t);
  f.project({
    id: 'project',
    slug: 'bench-zoo-mixed-2',
    name: 'Bench zoo',
    revision: 3,
    currentBackup: null,
  });
  await assert.rejects(
    withoutGit(() =>
      deleteHostedProject(root, { projectId: 'project', confirm: 'bench-zoo-mixed' }, { client: f.client }),
    ),
    error => error.code === 'HOST_DELETE_CONFIRM_MISMATCH' && error.message.includes('bench-zoo-mixed-2'),
  );
  assert.equal(
    f.calls.some(call => call.name.includes('permanentlyDelete')),
    false,
  );
  assert.equal(
    (
      await withoutGit(() =>
        deleteHostedProject(
          root,
          { projectId: 'project', confirm: 'bench-zoo-mixed-2' },
          { client: f.client },
        ),
      )
    ).purgeComplete,
    true,
  );
});
test('any plain directory addresses a project with --deployment; without it the refusal says so', async t => {
  const f = setup(t),
    plain = mkdtempSync(join(tmpdir(), 'forge-delete-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { deployment: _omitted, ...bare } = f.options;
  await assert.rejects(
    withoutGit(() => deleteHostedProject(plain, bare, { client: f.client })),
    code('BAD_ARGUMENT'),
  );
  assert.equal(f.calls.length, 0);
  const result = await withoutGit(() => deleteHostedProject(plain, f.options, { client: f.client }));
  assert.equal(result.purgeComplete, true);
  assert.equal(result.deployment, deployment);
});

test('a retry after the server cleared the slug reconciles the saved delete; a different slug is still refused', async t => {
  const f = setup(t);
  f.client.mutation = async () => {
    throw new Error('Synthetic lost reply');
  };
  await assert.rejects(
    deleteHostedProject(f.root, f.options, { client: f.client }),
    code('HOST_DELETE_INTERRUPTED'),
  );
  f.project({ id: 'project', name: '', revision: 8, currentBackup: null, removal: 'deleted' });
  await assert.rejects(
    deleteHostedProject(f.root, { ...f.options, confirm: 'other' }, { client: f.client }),
    code('HOST_DELETE_CONFIRM_MISMATCH'),
  );
  const result = await deleteHostedProject(f.root, f.options, { client: f.client });
  assert.equal(result.purgeComplete, true);
  assert.equal(result.project.removal, 'deleted');
  // Without a saved request a slugless project is still refused.
  const g = setup(t);
  g.project({ id: 'project', name: '', revision: 8, currentBackup: null, removal: 'deleted' });
  await assert.rejects(
    deleteHostedProject(g.root, g.options, { client: g.client }),
    code('HOST_DELETE_CONFIRM_MISMATCH'),
  );
});

// Count returned DB documents and their logical JSON bytes, including the CLI
// credential and account joins. No hostedProjects query is allowed at any scale.
function statusReadBudget(s) {
  const budget = { documents: 0, bytes: 0, projectGets: 0 };
  const record = value => {
    for (const row of Array.isArray(value) ? value : (value?.page ?? [value])) {
      if (!row) continue;
      budget.documents++;
      budget.bytes += Buffer.byteLength(JSON.stringify(row));
    }
    return value;
  };
  const db = s.ctx.db;
  const wrapQuery = query =>
    new Proxy(query, {
      get(target, key) {
        const method = target[key];
        if (typeof method !== 'function') return method;
        return (...args) => {
          const value = method.apply(target, args);
          return ['unique', 'first', 'take', 'collect', 'paginate'].includes(key)
            ? Promise.resolve(value).then(record)
            : wrapQuery(value);
        };
      },
    });
  s.ctx.db = new Proxy(db, {
    get(target, key) {
      if (key === 'get')
        return async id => {
          if (s.tables.hostedProjects.has(id)) budget.projectGets++;
          return record(await target.get(id));
        };
      if (key === 'query')
        return table => {
          assert.notEqual(table, 'hostedProjects', 'single-project deletion never scans an owner catalog');
          return wrapQuery(target.query(table));
        };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return budget;
}
function statusOwner(s) {
  const credentialId = randomUUID();
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    _creationTime: 1,
    owner: 'owner',
    credentialId,
    scope: 'cli',
    revoked: false,
    expiresAt: 8_000_000_000_000,
  });
  s.tables.forgeAccounts.set('account', {
    _id: 'account',
    _creationTime: 1,
    owner: 'owner',
    handle: 'synthetic-owner',
  });
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
}
test('c088b39e deletion and status call/document/byte budgets stay constant with 1 or 500 unrelated owner projects', async t => {
  const measured = [];
  for (const count of [1, 500]) {
    const f = setup(t),
      s = state([]);
    statusOwner(s);
    s.tables.hostedProjects.set(
      'project',
      projectRow({
        _id: 'project',
        slug: 'synthetic',
        revision: 7,
        retention: {
          purgeAt: 8_000_000_000_000,
          revoking: true,
          retainedBytes: 4096,
          retainedObjects: 1,
          measured: true,
        },
      }),
    );
    for (let i = 0; i < count; i++)
      s.tables.hostedProjects.set(
        `other-${i}`,
        projectRow({
          _id: `other-${i}`,
          key: `other-key-${i}`,
          name: `Other ${i}`,
          agentGuidance: 'x'.repeat(4000),
        }),
      );
    const budget = statusReadBudget(s);
    let queries = 0,
      mutations = 0,
      subscriptions = 0,
      closed = 0;
    const status = () => backups.deletionStatus._handler(s.ctx, { projectId: 'project' });
    const client = {
      query: (ref, args) => {
        queries++;
        assert.equal(getFunctionName(ref), 'projectBackups:deletionStatus');
        assert.deepEqual(args, { projectId: 'project' });
        return status();
      },
      mutation: async (_ref, args) => {
        mutations++;
        assert.equal(args.projectId, 'project');
        Object.assign(s.tables.hostedProjects.get('project'), { revision: 8, removal: 'deleting' });
      },
    };
    const result = await deleteHostedProject(f.root, f.options, {
      client,
      subscribe: () => ({
        onUpdate: (_ref, _args, update, error) => {
          subscriptions++;
          void (async () => {
            update(await status());
            const row = s.tables.hostedProjects.get('project');
            Object.assign(row, { name: '', removal: 'deleted' });
            delete row.slug;
            delete row.retention;
            update(await status());
          })().catch(error);
          return () => {};
        },
        close: async () => {
          closed++;
        },
      }),
    });
    assert.equal(result.purgeComplete, true);
    const deletion = { ...budget, queries, mutations, subscriptions };
    assert.equal(closed, 1);
    const beforeReplay = { ...budget };
    assert.equal((await deleteHostedProject(f.root, f.options, { client })).operationId, result.operationId);
    const replay = Object.fromEntries(Object.keys(budget).map(key => [key, budget[key] - beforeReplay[key]]));
    assert.equal(mutations, 1, 'tombstone replay never resubmits deletion');
    assert.equal(subscriptions, 1, 'tombstone replay opens no subscription');
    assert.equal(deletion.documents, 12, 'four deliveries each read project, credential and account only');
    assert.equal(deletion.projectGets, 4);
    assert.ok(deletion.bytes < 4000, 'one command reads a few KB, independent of unrelated data');
    assert.equal(replay.documents, 3);
    measured.push({ deletion, replay });
  }
  assert.deepEqual(measured[1], measured[0]);
  t.diagnostic(JSON.stringify(measured[0]));
});

test('narrow deletion status retains tombstones and checks the current owner and live device credential on every delivery', async () => {
  const s = state([]);
  statusOwner(s);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project', name: '', removal: 'deleted' }));
  const read = projectId => backups.deletionStatus._handler(s.ctx, { projectId });
  assert.equal((await read('project')).removal, 'deleted');
  assert.equal(await read('missing'), null);
  // Public visibility and an ordinary contributor grant never grant owner deletion status.
  Object.assign(s.tables.hostedProjects.get('project'), { owner: 'other', visibility: 'public' });
  s.tables.projectContributors.set('grant', { projectId: 'project', contributor: 'owner' });
  assert.equal(await read('project'), null);
  s.tables.hostedProjects.get('project').owner = 'owner';
  assert.equal((await read('project')).removal, 'deleted');
  s.tables.cliCredentials.get('device').revoked = true;
  await assert.rejects(read('project'), error => error.data?.code === 'AUTH_REVOKED');
  s.ctx.auth.getUserIdentity = async () => null;
  assert.equal(await read('project'), null);
});

test('legacy maintenance-blocked purge remains explicit without any wait or new confirmation', async t => {
  const f = setup(t);
  f.client.mutation = async () =>
    f.project({
      id: 'project',
      slug: 'synthetic',
      name: 'Synthetic',
      revision: 8,
      currentBackup: null,
      removal: 'deleting',
      purgeBlocked: 'R2_MAINTENANCE_DISABLED',
    });
  await assert.rejects(
    deleteHostedProject(f.root, f.options, {
      client: f.client,
      subscribe: () => assert.fail('blocked status opens no subscription'),
    }),
    code('R2_MAINTENANCE_DISABLED'),
  );
});
