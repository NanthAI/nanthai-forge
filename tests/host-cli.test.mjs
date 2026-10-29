// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConvexError, convexToJson, jsonToConvex } from 'convex/values';
import { validate } from 'convex-helpers/validators';
import { writeAuth } from '../dist/auth-store.js';
import { tmpdir } from 'node:os';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixture, modules, upload } from './project-exchange-fixture.mjs';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { workGit } from '../dist/work-git.js';
import { hostProject, hostCli } from '../dist/host-cli.js';
import { readHostState, updateHostState, requireHostedBinding } from '../dist/host-binding.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { pushAttemptId } from '../dist/bound-exchange.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
import { immutableDirectorySync } from './helpers/immutable-directory.mjs';
const { default: schema } = await import(moduleUrl('../convex/schema.ts'));
const hosting = await import(moduleUrl('../convex/projectHosting.ts'));
const devices = await import(moduleUrl('../convex/deviceStore.ts'));
const projectMain = await import(moduleUrl('../convex/projectMain.ts'));
const workIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
for (const name of [
  'projectHostedSeed',
  'projectHostedSeedActions',
  'projectHostedAgent',
  'projectHostedChannels',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const { activeProject } = await import(moduleUrl('../convex/projectAuthority.ts'));
const privateOwner = immutableDirectorySync('forge-host-', (directory, key) => {
  const { git, empty } = JSON.parse(key);
  const root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'hello.ts'), 'export const hello = 7;\n');
  if (git) {
    workGit(root, ['init', '--template=', '--initial-branch=main']);
    workGit(root, ['add', '.']);
    workGit(root, [
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Seed',
    ]);
  } else initNative(root);
  const store = new WorkStore(root),
    service = new WorkService(root);
  const intent = empty
    ? null
    : service.execute({ action: 'intent', outcome: 'Synthetic hosted task' }, store.revision()).result;
  return { intent };
});

function setup(t, git = false, empty = false) {
  const {
    root: directory,
    value: { intent },
  } = privateOwner(JSON.stringify({ git, empty }));
  const root = join(directory, 'owner');
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new WorkStore(root);
  const s = fixture();
  s.tables.hostedProjects.clear();
  for (const table of ['projectHostedSeeds', 'projectHostedSeedPages', 'projectHostedChannels'])
    s.tables[table] = new Map();
  // The in-memory harness must enforce the deployed document schema on creation.
  const insert = s.ctx.db.insert;
  s.ctx.db.insert = async (table, row) => {
    validate(schema.tables[table].validator, row, { throw: true });
    return insert(table, row);
  };
  const oldWeb = process.env.FORGE_WEB_URL;
  process.env.FORGE_WEB_URL = 'https://forge.example.invalid';
  t.after(() => {
    if (oldWeb === undefined) delete process.env.FORGE_WEB_URL;
    else process.env.FORGE_WEB_URL = oldWeb;
  });
  const credentialId = randomUUID();
  s.tables.cliCredentials.set('device', {
    owner: 'owner',
    credentialId,
    scope: 'cli',
    revoked: false,
    expiresAt: Date.now() + 3_600_000,
  });
  let identity = { subject: 'owner', forgeCredential: credentialId };
  s.ctx.auth.getUserIdentity = async () => identity;
  const original = s.ctx.runQuery;
  s.ctx.runQuery =
    s.ctx.runMutation =
    s.ctx.runAction =
      (ref, args) => {
        const [name, method] = getFunctionName(ref).split(':');
        if (name === 'projectMain') return projectMain[method]._handler(s.ctx, args);
        if (name === 'projectHosting') return hosting[method]._handler(s.ctx, args);
        if (name === 'deviceStore') return devices[method]._handler(s.ctx, args);
        return original(ref, args);
      };
  const client = {
    mutation: (ref, args) => s.ctx.runMutation(ref, args),
    action: (ref, args) => s.ctx.runAction(ref, args),
  };
  const uploaded = [],
    exchanges = [];
  const dependencies = {
    client,
    exchange: (projectId, operationId) => {
      exchanges.push({ projectId, operationId });
      const transport = new ConvexExchange(
        'https://fixture.convex.cloud',
        'fixture',
        projectId,
        operationId,
        null,
      );
      transport.client.query = (ref, args) => s.ctx.runQuery(ref, args);
      transport.client.action = (ref, args) => s.ctx.runAction(ref, args);
      transport.client.mutation = async () => []; // no R2 objects
      transport.uploadLazyBatch = async objects => {
        let bytes = 0;
        for (const object of objects) {
          const content = await object.read();
          await upload(s, content, projectId);
          uploaded.push(object.pin.sha256);
          bytes += content.length;
        }
        return { uploadedObjects: objects.length, uploadedBytes: bytes };
      };
      return transport;
    },
  };
  return {
    s,
    directory,
    root,
    store,
    intent,
    dependencies,
    uploaded,
    exchanges,
    identity: value => {
      identity = value;
    },
  };
}

test('host creates a brand-new empty native owner through schema-validated Convex functions', async t => {
  const f = setup(t, false, true);
  assert.equal(f.store.revision(), 0);
  const result = await hostProject(
    f.root,
    { deployment: 'https://fixture.convex.cloud', name: 'S1 live synthetic' },
    f.dependencies,
  );
  assert.equal(result.hosted, true);
  const project = f.s.tables.hostedProjects.get(result.projectId);
  const operationId = result.operationId;
  assert.equal(project.key, operationId);
  assert.equal(project.autonomyPolicy.acceptance.disjointFastPath, false);
  assert.equal((await hostCli([f.root, '--status'])).binding.acceptanceOwner, true);
  const replay = await hosting.create._handler(f.s.ctx, {
    operationId,
    name: 'S1 live synthetic',
    visibility: 'private',
  });
  assert.equal(replay.projectId, result.projectId);
  assert.equal(f.s.tables.hostedProjects.size, 1);
});

test('host seeds native source/Work via missing objects, initializes current index, saves owner binding and prevents duplicates', async t => {
  const f = setup(t);
  const result = await hostProject(
    f.root,
    { deployment: 'https://fixture.convex.cloud', name: 'Hosted synthetic' },
    f.dependencies,
  );
  assert.equal(result.hosted, true);
  assert(result.uploadedObjects > 0);
  assert.equal(f.s.tables.hostedProjects.size, 1);
  const project = f.s.tables.hostedProjects.get(result.projectId);
  assert.equal(project.visibility, 'private');
  assert.equal(project.autonomyPolicy.preset, 'supervised');
  assert.equal(project.work.backupId, result.backupId);
  const generation = f.s.tables.projectWorkGenerations.get(project.work.generationId);
  assert.equal(generation.format, HOSTED_WORK_INDEX_FORMAT);
  assert.equal(
    JSON.parse(await workIndex.workspace._handler(f.s.ctx, { projectId: result.projectId })).counts.intents,
    1,
  );
  const status = await hostCli([f.root, '--status']);
  assert.equal(status.binding.projectId, result.projectId);
  assert.equal(status.binding.acceptanceOwner, true);
  assert.equal(status.pending, null);
  assert(!readdirSync(f.store.directory).some(path => path.endsWith('.tar.gz')));
  await assert.rejects(hostProject(f.root, {}, f.dependencies), { code: 'HOST_ALREADY_BOUND' });
  assert.equal(f.s.tables.hostedProjects.size, 1);
  const previousPush = {
    operationId: randomUUID(),
    projectId: result.projectId,
    deployment: result.deployment,
    previous: result.backupId,
    revision: f.store.revision(),
  };
  updateHostState(f.store, state => {
    state.push = previousPush;
  });
  const other = await hostProject(f.root, { new: true }, f.dependencies);
  assert.deepEqual(readHostState(f.store).push, previousPush);
  assert.notEqual(other.projectId, result.projectId);
  assert.equal(f.s.tables.hostedProjects.size, 2);
});

test('lost create and publish replies reconcile original IDs without a second project or upload', async t => {
  const f = setup(t),
    mutation = f.dependencies.client.mutation;
  let lostCreate = true,
    lostPublish = true;
  f.dependencies.client.mutation = async (...args) => {
    const result = await mutation(...args);
    if (lostCreate) {
      lostCreate = false;
      throw new Error('lost create reply');
    }
    return result;
  };
  await assert.rejects(
    hostProject(f.root, { deployment: 'https://fixture.convex.cloud' }, f.dependencies),
    /lost create/,
  );
  const pending = readHostState(f.store).hosting;
  assert.equal(f.s.tables.hostedProjects.size, 1);
  new WorkService(f.root).execute(
    {
      action: 'note',
      intentId: f.intent.id,
      kind: 'comment',
      text: 'Concurrent local update after lost creation reply',
    },
    f.store.revision(),
  );
  const action = f.dependencies.client.action;
  f.dependencies.client.action = async (ref, args) => {
    const result = await action(ref, args);
    if (getFunctionName(ref) === 'projectHostedSeedActions:finish' && lostPublish) {
      lostPublish = false;
      throw new Error('lost publish reply');
    }
    return result;
  };
  await assert.rejects(hostProject(f.root, {}, f.dependencies), /lost publish/);
  const count = f.uploaded.length;
  const result = await hostProject(f.root, {}, f.dependencies);
  assert.equal(result.operationId, pending.operationId);
  assert.equal(f.s.tables.hostedProjects.size, 1);
  assert.equal(f.s.tables.projectBackups.size, 1);
  assert.equal(f.uploaded.length, count);
  assert(f.exchanges.every(item => item.operationId === pending.pushId));
});

test('interrupted upload resumes missing objects against original snapshot even after local Work changes', async t => {
  const f = setup(t),
    exchange = f.dependencies.exchange;
  let interrupted = true;
  f.dependencies.exchange = (...args) => {
    const transport = exchange(...args),
      batch = transport.uploadLazyBatch;
    transport.uploadLazyBatch = async objects => {
      if (interrupted) {
        interrupted = false;
        await batch(objects.slice(0, 1));
        throw new Error('upload interrupted');
      }
      return batch(objects);
    };
    return transport;
  };
  await assert.rejects(
    hostProject(f.root, { deployment: 'https://fixture.convex.cloud' }, f.dependencies),
    /interrupted/,
  );
  const pending = readHostState(f.store).hosting;
  new WorkService(f.root).execute(
    { action: 'note', intentId: f.intent.id, kind: 'comment', text: 'After interruption' },
    f.store.revision(),
  );
  const result = await hostProject(f.root, {}, f.dependencies);
  assert.equal(result.operationId, pending.operationId);
  assert.equal(new Set(f.uploaded).size, f.uploaded.length);
  assert.equal(f.s.tables.projectBackups.get(result.backupId).preview.revision, pending.revision);
});

test('initialization/index interruption resumes, public reads do not grant writes, and changed requests fail', async t => {
  const f = setup(t),
    action = f.dependencies.client.action;
  let interrupted = true;
  f.dependencies.client.action = async (ref, args) => {
    const result = await action(ref, args);
    if (getFunctionName(ref) === 'projectWorkIndexActions:ensure' && interrupted) {
      interrupted = false;
      throw new Error('lost index reply');
    }
    return result;
  };
  await assert.rejects(
    hostProject(f.root, { deployment: 'https://fixture.convex.cloud', visibility: 'public' }, f.dependencies),
    /lost index/,
  );
  await assert.rejects(hostProject(f.root, { visibility: 'private' }, f.dependencies), {
    code: 'WORK_OPERATION_CHANGED',
  });
  const result = await hostProject(f.root, {}, f.dependencies);
  f.identity({ subject: 'reader' });
  const workspace = JSON.parse(await workIndex.workspace._handler(f.s.ctx, { projectId: result.projectId }));
  assert.equal(workspace.capabilities.intent, false);
  await assert.rejects(
    activeProject(f.s.ctx, result.projectId, 'reader'),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
  f.s.tables.hostedProjects.get(result.projectId).removal = 'trash';
  await assert.rejects(
    workIndex.workspace._handler(f.s.ctx, { projectId: result.projectId }),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  f.identity({ subject: 'owner' });
  assert(
    JSON.parse(await workIndex.workspace._handler(f.s.ctx, { projectId: result.projectId })).capabilities
      .owner,
  );
  f.identity({ subject: 'reader' });
  delete f.s.tables.hostedProjects.get(result.projectId).removal;
  f.s.tables.hostedProjects.get(result.projectId).visibility = 'private';
  await assert.rejects(workIndex.workspace._handler(f.s.ctx, { projectId: result.projectId }));
});

test('server creation requires device login/cli scope and preserves original operation request', async t => {
  const f = setup(t),
    input = { operationId: randomUUID(), name: 'Synthetic', visibility: 'private' };
  f.identity(null);
  await assert.rejects(
    hosting.create._handler(f.s.ctx, input),
    error => error.data?.code === 'AUTH_REQUIRED',
  );
  f.identity({ subject: 'owner' });
  await assert.rejects(
    hosting.create._handler(f.s.ctx, input),
    error => error.data?.code === 'AUTH_REQUIRED',
  );
  const device = f.s.tables.cliCredentials.get('device');
  f.identity({ subject: 'owner', forgeCredential: device.credentialId });
  device.scope = 'coordination';
  await assert.rejects(
    hosting.create._handler(f.s.ctx, input),
    error => error.data?.code === 'AUTH_SCOPE_DENIED',
  );
  assert.equal(f.s.tables.hostedProjects.size, 0);
  device.scope = 'cli';
  const first = await hosting.create._handler(f.s.ctx, input);
  assert.equal((await hosting.create._handler(f.s.ctx, input)).projectId, first.projectId);
  await assert.rejects(
    hosting.create._handler(f.s.ctx, { ...input, name: 'Changed' }),
    error => error.data?.code === 'WORK_OPERATION_CHANGED',
  );
  device.revoked = true;
  await assert.rejects(hosting.create._handler(f.s.ctx, input), error => error.data?.code === 'AUTH_REVOKED');
});

test('Git-backed hosting preserves Git source/history and complete Work without an archive upload', async t => {
  const f = setup(t, true);
  const result = await hostProject(f.root, { deployment: 'https://fixture.convex.cloud' }, f.dependencies);
  const backup = f.s.tables.projectBackups.get(result.backupId);
  assert.equal(backup.preview.format, 'sha1');
  assert.equal(backup.preview.intents, 1);
  assert.equal(backup.preview.head, workGit(f.root, ['rev-parse', 'HEAD']).trim());
  const transport = f.dependencies.exchange(result.projectId, randomUUID());
  const { pullNativeExchange } = await import('../dist/native-exchange.js');
  const target = join(f.directory, 'restored');
  await pullNativeExchange(result.backupId, target, transport);
  assert.equal(readFileSync(join(target, 'hello.ts'), 'utf8'), 'export const hello = 7;\n');
  assert.equal(new WorkStore(target).load().intents[0].id, f.intent.id);
});

test('interrupted history stays unselected until the complete seed validates', async t => {
  const f = setup(t);
  const { NativeSource } = await import('../dist/native-source.js');
  const source = new NativeSource(f.root),
    data = f.store.load();
  const old = source.put(Buffer.from('retained historic bytes'));
  const past = source.writeState(
    [{ path: 'past', blob: old, mode: 'file' }],
    [data.nativeHead],
    'Past',
    new Date(0).toISOString(),
  );
  data.nativeHead = source.writeState(
    source.state(data.nativeHead).files,
    [past],
    'Current',
    new Date(1).toISOString(),
  );
  f.store.locked(() => f.store.save(data));
  const exchange = f.dependencies.exchange;
  let interrupted = true;
  f.dependencies.exchange = (...args) => {
    const transport = exchange(...args),
      batch = transport.uploadLazyBatch;
    transport.publish = () => {
      throw new Error('host must not push');
    };
    transport.uploadLazyBatch = async objects => {
      if (interrupted && objects.some(object => object.pin.sha256 === old)) {
        interrupted = false;
        await batch(objects.slice(0, 1));
        throw Error('history interrupted');
      }
      return batch(objects);
    };
    return transport;
  };
  const events = [];
  await assert.rejects(
    hostProject(f.root, { deployment: 'https://fixture.convex.cloud' }, f.dependencies),
    /history interrupted/,
  );
  const pending = readHostState(f.store).hosting;
  assert.equal(readHostState(f.store).binding, undefined);
  assert.equal(f.s.tables.projectBackups.size, 0);
  assert.equal(f.s.tables.projectHostedChannels.size, 0);
  const result = await hostProject(f.root, { onProgress: event => events.push(event) }, f.dependencies);
  const selected = JSON.parse([...f.s.tables.projectHostedChannels.values()][0].selection);
  assert.equal(selected.head, data.nativeHead);
  assert.equal(f.s.tables.projectBackups.size, 1);
  assert.equal(readHostState(f.store).hosting, undefined);
  assert.equal(result.operationId, pending.operationId);
  assert.equal(new Set(f.uploaded).size, f.uploaded.length);
  for (const phase of [
    'seeding source and records',
    'validating seeded main',
    'building Work index',
    'complete',
  ])
    assert(
      events.some(event => event.phase === phase),
      phase,
    );
});

test('host follows durable index continuations before binding and preserves server error diagnostics', async t => {
  const f = setup(t),
    action = f.dependencies.client.action;
  let calls = 0,
    fail = true;
  f.dependencies.client.action = async (ref, args) => {
    if (getFunctionName(ref) === 'projectWorkIndexActions:ensure') {
      assert.equal(readHostState(f.store).binding, undefined);
      calls++;
      if (calls <= 2)
        return {
          pending: true,
          progress: JSON.stringify({
            phase: 'index',
            buildPhase: 'summaries',
            field: 'views',
            done: calls * 10,
            total: 2167,
            step: calls,
          }),
        };
      if (fail) {
        fail = false;
        throw new ConvexError({
          code: 'SYNTHETIC_INDEX_FAILURE',
          message: 'The retained index page could not be read.',
        });
      }
    }
    return action(ref, args);
  };
  const events = [];
  await assert.rejects(
    hostProject(
      f.root,
      { deployment: 'https://fixture.convex.cloud', onProgress: event => events.push(event) },
      f.dependencies,
    ),
    {
      code: 'SYNTHETIC_INDEX_FAILURE',
      message: 'The retained index page could not be read.',
    },
  );
  const pending = readHostState(f.store).hosting;
  assert.equal(pending.errorCode, 'SYNTHETIC_INDEX_FAILURE');
  assert.equal(pending.progress.indexBuild.done, 20);
  assert.equal(pending.progress.indexBuild.total, 2167);
  assert(events.some(e => e.indexBuild?.field === 'views' && e.objectsDone === 20));
  assert.equal(readHostState(f.store).binding, undefined);
  const result = await hostProject(f.root, {}, f.dependencies);
  assert.equal(result.operationId, pending.operationId);
  assert.equal(calls, 4);
  assert.equal(readHostState(f.store).binding.projectId, result.projectId);
});

test('host --json and --status read pending hosting without writes or resuming; --resume is explicit', async t => {
  const f = setup(t);
  updateHostState(f.store, state => {
    state.hosting = {
      operationId: randomUUID(),
      pushId: randomUUID(),
      initializeId: randomUUID(),
      deployment: 'https://fixture.convex.cloud',
      name: 'Pending',
      visibility: 'private',
      revision: f.store.revision(),
    };
  });
  const snapshot = root => {
    const result = [];
    const walk = path => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const absolute = join(path, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else result.push([absolute, readFileSync(absolute).toString('base64')]);
      }
    };
    walk(root);
    return result;
  };
  const before = snapshot(f.root);
  let calls = 0;
  const host = async () => {
    calls++;
    return { resumed: true };
  };
  assert.equal((await hostCli([f.root, '--json'], host)).pending.name, 'Pending');
  assert.equal((await hostCli([f.root, '--status', '--json'], host)).status, 'hosting');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  await assert.rejects(hostCli([f.root], host), { code: 'HOST_RESUME_REQUIRED' });
  assert.deepEqual(snapshot(f.root), before);
  assert.equal((await hostCli([f.root, '--resume', '--json'], host)).resumed, true);
  assert.equal(calls, 1);
});
