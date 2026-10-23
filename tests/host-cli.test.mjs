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
const { default: schema } = await import(moduleUrl('../convex/schema.ts'));
const hosting = await import(moduleUrl('../convex/projectHosting.ts'));
const devices = await import(moduleUrl('../convex/deviceStore.ts'));
const projectMain = await import(moduleUrl('../convex/projectMain.ts'));
const workIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const { activeProject } = await import(moduleUrl('../convex/projectAuthority.ts'));
function setup(t, git = false, empty = false) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-host-')),
    root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'hello.ts'), 'export const hello = 7;\n');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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
  const s = fixture();
  s.tables.hostedProjects.clear();
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
  const exchange = f.dependencies.exchange;
  f.dependencies.exchange = (...args) => {
    const transport = exchange(...args),
      publish = transport.publish.bind(transport);
    transport.publish = async pin => {
      const result = await publish(pin);
      if (lostPublish) {
        lostPublish = false;
        throw new Error('lost publish reply');
      }
      return result;
    };
    return transport;
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

test('real CLI uses saved login deployment and bound push/pull/coordination without IDs or request files', async t => {
  let losePublishReply = false,
    loseReturnReply = false,
    delayJournal = false,
    rejectReturn = 0,
    rejectPublish = 0,
    writeDuring = null,
    staleAfterReturn = false,
    rejectIndex = false,
    blockedJournal = null,
    stopUncommittedReturn = false,
    loseSupersedeReply = false;
  const f = setup(t),
    routes = [],
    coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url === '/upload') {
        const storageId = await f.s.ctx.storage.store(
          new Blob(chunks, { type: request.headers['content-type'] }),
        );
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ storageId }));
        return;
      }
      assert.equal(request.headers.authorization, 'Bearer synthetic-device-token');
      const body = JSON.parse(Buffer.concat(chunks));
      routes.push(body.path);
      const [name, method] = body.path.split(':'),
        args = jsonToConvex(body.args[0]);
      if (body.path === 'projectWorkIndexActions:ensure' && rejectIndex) {
        rejectIndex = false;
        response.writeHead(560, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'error',
            errorMessage: 'Interrupted refresh',
            errorData: { code: 'AUTH_REQUIRED', message: 'Interrupted refresh' },
          }),
        );
        return;
      }
      if (body.path === 'projectWorkJournal:page' && blockedJournal) {
        const gate = blockedJournal;
        blockedJournal = null;
        gate.enter();
        await gate.wait;
      }
      if (body.path === 'projectWorkJournal:page' && delayJournal) {
        delayJournal = false;
        await new Promise(resolve => setTimeout(resolve, 10500));
      }
      // A concurrent local writer (e.g. a post-accept audit) while the push is on the network.
      if (writeDuring?.path === body.path) {
        writeDuring.write();
        writeDuring = null;
      }
      if (body.path === 'projectSourceReturn:returnSource' && stopUncommittedReturn && !args.statusOnly) {
        throw new ConvexError({ code: 'SYNTHETIC_STOP', message: 'Stop with an uncommitted return' });
      }
      if (body.path === 'projectSourceReturn:returnSource' && rejectReturn && !args.statusOnly) {
        rejectReturn--;
        response.writeHead(560, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'error',
            errorMessage: 'Concurrent hosted Work',
            errorData: { code: 'WORK_STALE', message: 'Concurrent hosted Work' },
          }),
        );
        return;
      }
      if (body.path === 'projectExchangeActions:publish' && rejectPublish) {
        rejectPublish--;
        response.writeHead(560, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'error',
            errorMessage: 'Concurrent push',
            errorData: { code: 'PROJECT_CHANGED', message: 'Concurrent push' },
          }),
        );
        return;
      }
      const ref = (await import('convex/server')).makeFunctionReference(body.path);
      const value =
        name === 'projectCoordination'
          ? await coordination[method]._handler(f.s.ctx, args)
          : await f.s.ctx.runQuery(ref, args);
      if (body.path === 'projectReturnSupersede:supersede' && loseSupersedeReply) {
        loseSupersedeReply = false;
        response.destroy();
        return;
      }
      if (body.path === 'projectSourceReturn:returnSource' && staleAfterReturn && !args.statusOnly) {
        staleAfterReturn = false;
        response.writeHead(560, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'error',
            errorMessage: 'Late duplicate',
            errorData: { code: 'WORK_STALE', message: 'Late duplicate' },
          }),
        );
        return;
      }
      if (body.path === 'projectSourceReturn:returnSource' && loseReturnReply) {
        loseReturnReply = false;
        response.destroy();
        return;
      }
      if (body.path === 'projectExchangeActions:publish' && losePublishReply) {
        losePublishReply = false;
        response.destroy();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'success', value: convexToJson(value) }));
    } catch (error) {
      response.writeHead(560, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'error',
          errorMessage: error.message,
          errorData: error.data ?? { code: 'FIXTURE', message: error.message },
        }),
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const deployment = `http://127.0.0.1:${server.address().port}`;
  f.s.ctx.storage.generateUploadUrl = async () => `${deployment}/upload`;
  const config = join(f.directory, 'config'),
    previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  });
  writeAuth({
    defaultDeployment: deployment,
    deployments: {
      [deployment]: {
        token: 'synthetic-device-token',
        credentialId: f.s.tables.cliCredentials.get('device').credentialId,
        scope: 'cli',
        expiresAt: Date.now() + 3_600_000,
        name: 'Synthetic CLI',
      },
    },
  });
  const env = { ...process.env, XDG_CONFIG_HOME: config };
  delete env.FORGE_AUTH_TOKEN;
  delete env.FORGE_DEPLOYMENT_URL;
  const cli = (...args) => {
    const callsite = new Error('CLI callsite');
    return promisify(execFile)(process.execPath, [resolve('dist/cli.js'), ...args], { env }).catch(error => {
      error.stack += '\n' + callsite.stack;
      throw error;
    });
  };
  const seedWork = new WorkService(f.root);
  const act = command => seedWork.dispatch(command, seedWork.status().revision);
  const seedLane = (await act({ action: 'lane', intentId: f.intent.id, name: 'Main seed' })).result;
  const seedView = (
    await act({
      action: 'compose',
      intentId: f.intent.id,
      inputs: [{ laneId: seedLane.id, head: seedLane.head }],
    })
  ).result;
  await act({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: seedView.id,
    expectedHead: seedView.head,
    expectedPrevious: null,
  });
  const hostedRun = await cli('host', f.root, '--wait', '--json');
  const outputEvents = hostedRun.stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert(outputEvents.some(event => event.type === 'host-progress' && event.phase === 'complete'));
  assert.equal(hostedRun.stderr, '');
  const hosted = outputEvents.at(-1);
  assert.equal(hosted.type, 'host-result');
  assert.equal(hosted.hosted, true);
  assert.equal(hosted.deployment, deployment);
  const service = new WorkService(f.root);
  const lane = service.execute(
    { action: 'lane', intentId: f.intent.id, name: 'Lifecycle' },
    f.store.revision(),
  ).result;
  const initialBackup = hosted.backupId;
  delayJournal = true;
  const firstPush = await cli('exchange', f.root, 'push'),
    first = JSON.parse(firstPush.stdout);
  assert.match(firstPush.stderr, /capturing local source and Work:/);
  assert.match(firstPush.stderr, /preparing and uploading checkpoint:/);
  assert.match(firstPush.stderr, /refreshing hosted Work index:/);
  const journalProgress = firstPush.stderr
    .split('\n')
    .filter(line => line.startsWith('receiving and reconciling hosted Work journal:'));
  assert(journalProgress.length >= 2, 'a slow journal read reports progress while awaiting its reply');
  assert.match(journalProgress.at(-1), /journal delta; waiting on projectWorkJournal:page/);
  // The heartbeat fires every 5 s; whole-second rounding can print 4 s on a busy runner.
  assert.match(journalProgress.at(-1), /elapsed=[1-9]\d*s/);
  assert.equal(first.revision, f.store.revision());
  await modules.projectWorkActions.command._handler(f.s.ctx, {
    projectId: hosted.projectId,
    operationId: randomUUID(),
    revision: f.s.tables.hostedProjects.get(hosted.projectId).work.revision,
    command: JSON.stringify({
      action: 'note',
      intentId: f.intent.id,
      kind: 'comment',
      text: 'Concurrent hosted note',
    }),
  });
  service.execute({ action: 'lane-status', laneId: lane.id, state: 'completed' }, f.store.revision());
  service.execute(
    { action: 'intent-status', intentId: f.intent.id, status: 'completed' },
    f.store.revision(),
  );
  assert.equal(f.s.tables.projectBackups.get(first.backupId).previous, initialBackup);

  assert(!readHostState(f.store).push);
  losePublishReply = true;
  const second = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(losePublishReply, false, 'lost publication reply was retried automatically');
  assert(!readHostState(f.store).push);
  assert.equal(f.s.tables.projectBackups.get(second.backupId).previous, first.backupId);
  assert.ok(second.sourceReturn);
  const indexed = async collection =>
    (
      await workIndex.records._handler(f.s.ctx, {
        projectId: hosted.projectId,
        collection,
        paginationOpts: { cursor: null, numItems: 100 },
      })
    ).page.map(row => JSON.parse(row.value));
  assert.equal((await indexed('intents'))[0].status, 'completed');
  assert.equal((await indexed('lanes')).find(item => item.id === lane.id).state, 'completed');
  assert.equal((await indexed('notes')).at(-1).text, 'Concurrent hosted note');
  assert.equal(
    f.s.tables.projectBackups.get(second.backupId).preview.head,
    f.s.tables.projectBackups.get(first.backupId).preview.head,
    'completion changed no source bytes',
  );
  assert.equal((await indexed('lifecycle')).at(-1).to, 'completed');
  assert.equal(f.s.tables.hostedProjects.get(hosted.projectId).work.backupId, second.backupId);
  // Reopening is also metadata-only, and a lost source-return reply retries its exact receipt.
  service.execute({ action: 'intent-status', intentId: f.intent.id, status: 'active' }, f.store.revision());
  loseReturnReply = true;
  const resumed = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(loseReturnReply, false, 'lost source-return reply was retried automatically');
  assert(!readHostState(f.store).push);
  assert.equal((await indexed('intents'))[0].status, 'active');
  assert.equal((await indexed('lanes')).find(item => item.id === lane.id).state, 'completed');
  // A changed native root head stays local while hosted metadata is reconciled.
  const { NativeSource } = await import('../dist/native-source.js');
  const native = new NativeSource(f.root),
    changed = f.store.load();
  changed.nativeHead = native.writeState(
    native.state(changed.nativeHead).files,
    [changed.nativeHead],
    'Root source checkpoint',
    new Date().toISOString(),
  );
  changed.revision++;
  f.store.locked(() => f.store.save(changed));
  // One known hosted CAS mismatch rebases onto fresh pins with a derived attempt identity.
  rejectReturn = 1;
  const rebased = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(rejectReturn, 0);
  assert.equal(rebased.rebases, 1);
  assert.equal(rebased.operationId, pushAttemptId(rebased.parentOperationId, 1, 'push'));
  const staleCandidate = f.s.tables.projectBackups.get(rebased.backupId).previous;
  assert.notEqual(staleCandidate, resumed.backupId, 'the stale attempt candidate remains available');
  assert.equal(f.s.tables.projectBackups.get(staleCandidate).operationId, rebased.parentOperationId);
  assert.equal(f.s.tables.projectBackups.get(staleCandidate).preview.head, changed.nativeHead);
  assert.equal(f.s.tables.hostedProjects.get(hosted.projectId).work.backupId, rebased.backupId);
  assert(!readHostState(f.store).push);
  // A persistent mismatch returns the existing stale outcome after three rebases.
  rejectReturn = 4;
  await assert.rejects(cli('exchange', f.root, 'push'), error => {
    const lines = error.stderr.trim().split('\n');
    return (
      JSON.parse(lines.at(-1)).error.code === 'WORK_STALE' &&
      lines.filter(line => line.startsWith('Hosted Work moved during push; rebasing')).length === 3
    );
  });
  assert.equal(rejectReturn, 0);
  const retainedBackup = f.s.tables.hostedProjects.get(hosted.projectId).currentBackup;
  assert.notEqual(retainedBackup, rebased.backupId, 'published candidate remains available');
  assert.equal(
    f.s.tables.hostedProjects.get(hosted.projectId).work.backupId,
    rebased.backupId,
    'stale return never changes hosted Work',
  );
  assert(!readHostState(f.store).push, 'known stale return can observe fresh pins on the next push');
  const returnedRecovery = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(f.s.tables.projectBackups.get(returnedRecovery.backupId).previous, retainedBackup);
  assert.equal(f.s.tables.projectBackups.get(returnedRecovery.backupId).preview.head, changed.nativeHead);
  rejectPublish = 1;
  const recovered = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(rejectPublish, 0);
  assert.equal(recovered.rebases, 1);
  assert(!readHostState(f.store).push);
  assert.equal(f.s.tables.projectBackups.get(recovered.backupId).previous, returnedRecovery.backupId);
  // Local Work written while a push is on the network belongs to the next push;
  // a lost reply retries the retained snapshot rather than recapturing it.
  const localWrite = path => {
    const id = randomUUID();
    writeDuring = {
      path,
      write: () =>
        f.store.locked(() => {
          const tx = f.store.records();
          tx.append('intents', {
            id,
            outcome: 'Concurrent local audit write',
            constraints: '',
            base: tx.data().nativeHead,
            status: 'active',
            createdAt: new Date().toISOString(),
            notes: [],
          });
          f.store.commitRecords(tx);
        }),
    };
    return id;
  };
  const duringPublish = localWrite('projectExchangeActions:publish');
  losePublishReply = true;
  const pinned = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(writeDuring, null);
  assert.equal(losePublishReply, false);
  assert(pinned.revision < f.store.revision(), 'the concurrent write is not part of this push');
  assert.equal(
    [...f.s.tables.projectBackups.values()].filter(row => row.operationId === pinned.operationId).length,
    1,
    'the retry reused its retained snapshot and receipt',
  );
  assert(!(await indexed('intents')).some(intent => intent.id === duringPublish));
  const duringJournal = localWrite('projectWorkJournal:page');
  const following = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(writeDuring, null);
  assert.equal(following.revision, f.store.revision());
  const hostedIntents = await indexed('intents');
  assert(
    hostedIntents.some(intent => intent.id === duringPublish),
    'earlier write lands next push',
  );
  assert(
    !hostedIntents.some(intent => intent.id === duringJournal),
    'journal-time writes wait for the next push',
  );
  const duringFirstRead = localWrite('projectWork:state');
  const afterJournal = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(writeDuring, null);
  const afterJournalIntents = await indexed('intents');
  assert(
    afterJournalIntents.some(intent => intent.id === duringJournal),
    'journal-time writes land next push',
  );
  assert(
    !afterJournalIntents.some(intent => intent.id === duringFirstRead),
    'the snapshot precedes the first hosted read',
  );
  const afterFirstRead = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert((await indexed('intents')).some(intent => intent.id === duringFirstRead));
  // A stale reply after a completed source return rebases using the previous
  // reconciled candidate, never the older original capture's hosted-event prefix.
  staleAfterReturn = true;
  const completedRebase = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(staleAfterReturn, false);
  assert.equal(completedRebase.rebases, 1);
  assert.equal(f.s.tables.hostedProjects.get(hosted.projectId).work.backupId, completedRebase.backupId);

  // A completed return whose index refresh failed retains the same pending
  // push. Its next invocation replays the return receipt and completes refresh.
  rejectIndex = true;
  await assert.rejects(
    cli('exchange', f.root, 'push'),
    error => JSON.parse(error.stderr.trim().split('\n').at(-1)).error.code === 'AUTH_REQUIRED',
  );
  const retainedAfterReturn = readHostState(f.store).push;
  assert(retainedAfterReturn);
  const publishedCount = f.s.tables.projectBackups.size;
  await assert.rejects(
    cli('exchange', f.root, 'push', '--supersede-retained'),
    error => JSON.parse(error.stderr.trim().split('\n').at(-1)).error.code === 'SOURCE_RETURN_COMMITTED',
  );
  assert.equal(readHostState(f.store).push.operationId, retainedAfterReturn.operationId);
  assert.equal(readHostState(f.store).supersede, undefined);
  const resumedRefresh = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(resumedRefresh.operationId, retainedAfterReturn.operationId);
  assert.equal(f.s.tables.projectBackups.size, publishedCount);
  assert.equal(readHostState(f.store).push, undefined);

  // A retained compatibility operation can be explicitly retired without
  // deleting its checkpoint. A lost tombstone reply reuses the same request.
  const selectedWork = f.s.tables.hostedProjects.get(hosted.projectId).work;
  const reconciledForSeed = await modules.projectWorkActions.load(f.s.ctx, hosted.projectId, 'owner');
  f.store.save(reconciledForSeed.data);
  const retainedSeedId = randomUUID();
  const { prepareNativeExchange: prepareRetainedSeed } = await import('../dist/native-exchange.js');
  await prepareRetainedSeed(f.store, f.store.revision(), retainedSeedId, true, undefined, undefined, {
    recordMetadata: true,
  });
  updateHostState(f.store, state => {
    state.push = {
      operationId: retainedSeedId,
      projectId: hosted.projectId,
      deployment,
      previous: f.s.tables.hostedProjects.get(hosted.projectId).currentBackup,
      revision: f.store.revision(),
      returnSource: {
        expectedBackupId: selectedWork.backupId,
        revision: selectedWork.revision,
        operationId: pushAttemptId(retainedSeedId, 0, 'return'),
      },
    };
  });
  stopUncommittedReturn = true;
  await assert.rejects(
    cli('exchange', f.root, 'push'),
    error => JSON.parse(error.stderr.trim().split('\n').at(-1)).error.code === 'SYNTHETIC_STOP',
  );
  const stuck = readHostState(f.store).push;
  const oldBackup = f.s.tables.hostedProjects.get(hosted.projectId).currentBackup;
  const retainedRoot = JSON.parse(
    readFileSync(join(f.store.directory, `exchange-${stuck.operationId}`, 'exchange.json')),
  );
  assert.equal(retainedRoot.delta, undefined, 'retained immutable root can only use compatibility fallback');
  const baseBackup = stuck.returnSource.expectedBackupId;
  stopUncommittedReturn = false;
  loseSupersedeReply = true;
  const publicationModes = [],
    deltaRevisions = [],
    originalLog = console.log;
  t.mock.method(console, 'log', (...args) => {
    if (args[0] === 'work-record exchange prepared') publicationModes.push(args[1].mode);
    if (args[0] === 'work-record return prepared') deltaRevisions.push(args[1].revision);
    originalLog(...args);
  });
  const supersededRecovery = JSON.parse(
    (await cli('exchange', f.root, 'push', '--supersede-retained')).stdout,
  );
  assert.notEqual(supersededRecovery.operationId, stuck.operationId);
  assert.deepEqual(publicationModes, ['delta'], 'replacement publishes a record delta against selected Work');
  assert(
    deltaRevisions.includes(stuck.returnSource.revision),
    'replacement return executed the server record-delta path',
  );
  assert.equal(readHostState(f.store).supersededPushes.at(-1).original.operationId, stuck.operationId);
  assert.equal(f.s.tables.projectReturnSupersessions.size, 1);
  assert(f.s.tables.projectBackups.has(oldBackup), 'uploaded checkpoint remains retained');
  assert.equal(f.s.tables.projectBackups.get(supersededRecovery.backupId).previous, oldBackup);
  const freshRoot = JSON.parse(
    readFileSync(join(f.store.directory, `exchange-${supersededRecovery.operationId}`, 'exchange.json')),
  );
  const baseRoot = JSON.parse(
    readFileSync(
      join(
        f.store.directory,
        `exchange-${f.s.tables.projectBackups.get(baseBackup).operationId}`,
        'exchange.json',
      ),
    ),
  );
  assert(freshRoot.delta, 'fresh push has a record delta');
  const { preparedMetadata } = await import('../dist/native-exchange-prepared.js');
  const directory = join(f.store.directory, `exchange-${supersededRecovery.operationId}`);
  const deltaBytes = preparedMetadata(directory, readFileSync(join(directory, 'manifest.json'))).read(
    freshRoot.delta.sha256,
  );
  assert.equal(
    JSON.parse(deltaBytes).base.root,
    baseRoot.records.sha256,
    'delta uses selected Work rather than orphan checkpoint',
  );
  await assert.rejects(
    f.s.ctx.runMutation(makeFunctionReference('projectReturnSupersede:supersede'), {
      projectId: hosted.projectId,
      operationId: readHostState(f.store).supersededPushes.at(-1).original.returnSource.operationId,
      pushOperationId: stuck.operationId,
      expectedBackupId: baseBackup,
      revision: stuck.returnSource.revision,
      replacementId: randomUUID(),
    }),
  );

  // Real independent CLI processes share transport admission; ordinary owner
  // metadata writes continue while the first process awaits its journal.
  let enter, release;
  const entered = new Promise(resolve => {
    enter = resolve;
  });
  blockedJournal = {
    enter,
    wait: new Promise(resolve => {
      release = resolve;
    }),
  };
  const pushing = cli('exchange', f.root, 'push');
  await entered;
  const pendingId = readHostState(f.store).push.operationId;
  const competing = cli('exchange', f.root, 'push');
  const routeCount = routes.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(routes.length, routeCount, 'second CLI waits before reading hosted state');
  updateHostState(f.store, state => {
    (state.acceptanceReceipts ??= {}).synthetic = 'receipt';
  });
  assert.equal(readHostState(f.store).push.operationId, pendingId);
  release();
  const [pushed, competed] = await Promise.all([pushing, competing]);
  const firstConcurrent = JSON.parse(pushed.stdout),
    secondConcurrent = JSON.parse(competed.stdout);
  assert.notEqual(firstConcurrent.operationId, secondConcurrent.operationId);
  assert.equal(f.s.tables.projectBackups.get(secondConcurrent.backupId).previous, firstConcurrent.backupId);
  assert.equal(readHostState(f.store).acceptanceReceipts.synthetic, 'receipt');
  assert.equal(readHostState(f.store).push, undefined);

  const sessions = JSON.parse((await cli('coordination', f.root, '{"action":"sessions"}')).stdout);
  assert.equal(sessions.page.length, 0);
  const retained = {
    operationId: randomUUID(),
    projectId: hosted.projectId,
    deployment,
    previous: secondConcurrent.backupId,
    revision: f.store.revision(),
  };
  updateHostState(f.store, state => {
    state.push = retained;
  });
  // A retry of an unknown push owns an immutable prepared candidate, even when later work changes.
  const { prepareNativeExchange } = await import('../dist/native-exchange.js');
  await prepareNativeExchange(f.store, retained.revision, retained.operationId, true);
  const replacement = JSON.parse((await cli('host', f.root, '--new')).stdout);
  assert.notEqual(replacement.projectId, hosted.projectId);
  assert.equal(replacement.historyBackfilling, true);
  const deadline = Date.now() + 30_000;
  while (readHostState(f.store).hosting && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(readHostState(f.store).hosting, undefined, 'detached backfill completed');
  const newPush = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(newPush.projectId, replacement.projectId);
  assert.deepEqual(readHostState(f.store).pendingPushes, [retained]);
  assert.equal(requireHostedBinding(f.store).projectId, replacement.projectId);
  // Return to the original binding to inspect its matching journal and prove its retry remains usable.
  updateHostState(f.store, state => {
    state.binding = {
      projectId: hosted.projectId,
      deployment,
      projectUrl: hosted.projectUrl,
      operationId: hosted.operationId,
      name: hosted.name,
      visibility: hosted.visibility,
      backupId: following.backupId,
    };
  });
  const originalRetry = JSON.parse((await cli('exchange', f.root, 'push')).stdout);
  assert.equal(originalRetry.operationId, retained.operationId);
  assert.deepEqual(readHostState(f.store).pendingPushes, []);
  const workspace = JSON.parse((await cli('hosted-work', f.root, '{"action":"workspace"}')).stdout);
  assert.equal(workspace.projectId, hosted.projectId);
  const target = join(f.directory, 'pulled');
  const pulled = JSON.parse((await cli('exchange', f.root, 'pull', '--target', target)).stdout);
  assert.equal(pulled.projectId, hosted.projectId);
  assert.equal(pulled.head, seedView.head);
  assert.equal(readFileSync(join(target, 'hello.ts'), 'utf8'), 'export const hello = 7;\n');
  const marker = JSON.parse(readFileSync(join(target, '.forge/hosted-main.json'), 'utf8'));
  assert.equal(marker.selection.receipt.kind, 'native');
  const requestFile = join(f.directory, 'client-request.json');
  const clientTarget = join(f.directory, 'ownerless-client');
  writeFileSync(
    requestFile,
    JSON.stringify({ url: deployment, projectId: hosted.projectId, operationId: randomUUID() }),
  );
  const opened = JSON.parse(
    (await cli('exchange', clientTarget, 'open', '--command-file', requestFile)).stdout,
  );
  assert.equal(opened.head, pulled.head);
  assert.equal(readFileSync(join(clientTarget, 'hello.ts'), 'utf8'), 'export const hello = 7;\n');
  writeFileSync(
    requestFile,
    JSON.stringify({ url: deployment, projectId: hosted.projectId, operationId: randomUUID() }),
  );
  const unchanged = JSON.parse(
    (await cli('exchange', clientTarget, 'pull', '--command-file', requestFile)).stdout,
  );
  assert.equal(unchanged.downloadedObjects, 0);
  assert.equal(unchanged.downloadedBytes, 0);
  const restoredTarget = join(f.directory, 'independent-owner');
  writeFileSync(
    requestFile,
    JSON.stringify({ url: deployment, projectId: hosted.projectId, backupId: originalRetry.backupId }),
  );
  await cli('exchange', restoredTarget, 'restore', '--command-file', requestFile);
  assert.equal(new WorkStore(restoredTarget).load().intents[0].id, f.intent.id);

  assert(routes.includes('projectHosting:create'));
  await assert.rejects(
    cli('host', f.root, '--wait'),
    error => JSON.parse(error.stderr).error.code === 'HOST_ALREADY_BOUND',
  );
  await modules.projectWorkActions.command._handler(f.s.ctx, {
    projectId: hosted.projectId,
    operationId: randomUUID(),
    revision: f.s.tables.hostedProjects.get(hosted.projectId).work.revision,
    command: JSON.stringify({ action: 'intent-status', intentId: f.intent.id, status: 'completed' }),
  });
  service.execute(
    { action: 'intent-status', intentId: f.intent.id, status: 'abandoned' },
    f.store.revision(),
  );
  await assert.rejects(cli('exchange', f.root, 'push'), error => {
    const problem = JSON.parse(error.stderr.trim().split('\n').at(-1)).error;
    assert.equal(problem.code, 'WORK_CONFLICT');
    assert.match(problem.message, /"collection":"intents"/);
    assert(problem.message.includes(f.intent.id));
    assert.match(problem.message, /"field":"status"/);
    assert.match(problem.message, /Reconcile operation: [a-f0-9-]+/);
    return true;
  });
  const missingEnv = { ...env, XDG_CONFIG_HOME: join(f.directory, 'empty-config') };
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [resolve('dist/cli.js'), 'host', f.root, '--deployment', deployment],
      { env: missingEnv },
    ),
    error => {
      const data = JSON.parse(error.stderr).error;
      return data.code === 'AUTH_REQUIRED' && data.message.includes('nforge login');
    },
  );
});

test('current source is usable before history; interruption resumes the exact manifest without missing or duplicated objects', async t => {
  const f = setup(t);
  const { NativeSource } = await import('../dist/native-source.js');
  const { nativeReachable } = await import('../dist/native-reachable.js');
  const source = new NativeSource(f.root),
    data = f.store.load();
  const old = [source.put(Buffer.from('older first file')), source.put(Buffer.from('older second file'))];
  const past = source.writeState(
    old.map((blob, i) => ({ path: `past-${i}`, blob, mode: 'file' })),
    [data.nativeHead],
    'Past',
    new Date(0).toISOString(),
  );
  const current = source.writeState(
    source.state(data.nativeHead).files,
    [past],
    'Current',
    new Date(1).toISOString(),
  );
  data.nativeHead = current;
  f.store.locked(() => f.store.save(data));
  const retained = nativeReachable(f.store);
  const events = [],
    exchange = f.dependencies.exchange;
  let interrupted = true;
  f.dependencies.exchange = (...args) => {
    const transport = exchange(...args),
      batch = transport.uploadLazyBatch;
    transport.uploadLazyBatch = async objects => {
      if (interrupted && objects.some(object => old.includes(object.pin.sha256))) {
        interrupted = false;
        await batch(objects.slice(0, 1));
        throw Error('history interrupted');
      }
      return batch(objects);
    };
    return transport;
  };
  await assert.rejects(
    hostProject(
      f.root,
      { deployment: 'https://fixture.convex.cloud', onProgress: event => events.push(event) },
      f.dependencies,
    ),
    /history interrupted/,
  );
  const state = readHostState(f.store),
    backup = f.s.tables.projectBackups.get(state.binding.backupId);
  assert.equal(state.hosting.ready, true);
  assert.equal(backup.historyBackfilling, true);
  assert.equal(requireHostedBinding(f.store).projectId, state.binding.projectId);
  const status = await hostCli([f.root, '--status', '--json']);
  assert.equal(status.status, 'history backfilling');
  assert.equal(status.historyBackfilling, true);
  assert.equal(status.errorCode, 'HOST_INTERRUPTED');
  assert.equal(
    JSON.parse(await workIndex.workspace._handler(f.s.ctx, { projectId: state.binding.projectId })).counts
      .intents,
    1,
  );
  // A partial upload cannot claim complete retained history.
  await assert.rejects(
    modules.projectExchangeActions.completeHistory._handler(f.s.ctx, { backupId: backup._id }),
    error => error.data?.code === 'INVALID_WORK_BACKUP',
  );
  new WorkService(f.root).execute(
    { action: 'note', intentId: f.intent.id, kind: 'comment', text: 'Concurrent local Work' },
    f.store.revision(),
  );
  const result = await hostProject(f.root, { onProgress: event => events.push(event) }, f.dependencies);
  assert.equal(result.operationId, state.hosting.operationId);
  assert.equal(f.s.tables.projectBackups.size, 1);
  assert.equal(f.s.tables.projectBackups.get(result.backupId).historyBackfilling, false);
  assert.equal(new Set(f.uploaded).size, f.uploaded.length);
  for (const id of retained) assert(f.uploaded.includes(id), id);
  assert.equal((await hostCli([f.root, '--status'])).status, 'complete');
  f.identity({ subject: 'reader' });
  await assert.rejects(
    modules.projectExchangeActions.completeHistory._handler(f.s.ctx, { backupId: result.backupId }),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  f.identity({ subject: 'owner', forgeCredential: f.s.tables.cliCredentials.get('device').credentialId });
  for (const phase of [
    'preparing source and Work',
    'negotiating',
    'uploading current source',
    'building Work index',
    'ready; history backfilling',
    'history backfilling',
    'validating complete history',
    'complete',
  ])
    assert(
      events.some(event => event.phase === phase),
      phase,
    );
  for (const event of events) {
    assert(event.objectsDone <= event.objectsTotal);
    assert(event.bytesDone <= event.bytesTotal);
    assert(event.bytesPerSecond >= 0);
  }
  assert.doesNotMatch(JSON.stringify(events), /fixture|token|https?:|older first|Concurrent local/);
});
