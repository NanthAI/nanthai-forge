// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { validate } from 'convex-helpers/validators';
import { moduleUrl } from './convex-module.mjs';
import { fixture, modules, upload } from './project-exchange-fixture.mjs';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { workGit } from '../dist/work-git.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { immutableDirectorySync } from './helpers/immutable-directory.mjs';
const { default: schema } = await import(moduleUrl('../convex/schema.ts'));
const hosting = await import(moduleUrl('../convex/projectHosting.ts'));
const devices = await import(moduleUrl('../convex/deviceStore.ts'));
const projectMain = await import(moduleUrl('../convex/projectMain.ts'));
for (const name of [
  'projectHostedSeed',
  'projectHostedSeedActions',
  'projectHostedAgent',
  'projectHostedChannels',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
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

export function setup(t, git = false, empty = false) {
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
      transport.client.mutation = (ref, args) => s.ctx.runMutation(ref, args);
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
