// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { testDeploymentOrigin } from './trusted-origin.mjs';
import { captureNativeArchive } from './native-archive-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { digest } from '../dist/hash.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';

import { WorkService } from '../dist/work.js';
import { pullNativeExchange } from '../dist/native-exchange.js';
import { metadataRequest, workBytes } from '../dist/work-metadata.js';
import { NativeSource } from '../dist/native-source.js';
import { readHosted } from './hosted-read.mjs';
const names = [
  'projectObjects',
  'projectExchange',
  'projectExchangeActions',
  'projectExchangeCache',
  'projectBackups',
  'projectWork',
  'projectWorkActions',
  'projectObjectCommit',
  'projectObjectDownloads',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
const objects = modules.projectObjects,
  actions = modules.projectExchangeActions;
function fixture() {
  const s = state([]),
    run = s.ctx.runQuery;
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic exchange',
    currentBackup: null,
    revision: 0,
  });
  s.ctx.storage.generateUploadUrl = async () => 'https://fixture.invalid/upload';
  s.ctx.runAction =
    s.ctx.runQuery =
    s.ctx.runMutation =
      (ref, args) => {
        const [name, method] = getFunctionName(ref).split(':');
        return modules[name] ? modules[name][method]._handler(s.ctx, args) : run(ref, args);
      };
  return s;
}
async function putR2(s, row, bytes) {
  const response = await fetch(row.target.url, { method: 'PUT', headers: row.target.headers, body: bytes });
  assert(response.ok || response.status === 412);
  await modules.projectObjectCommit.commitBatch._handler(s.ctx, { objects: [{ id: row.id }] });
}
function transport(s, previous = null) {
  return {
    missing: pins =>
      objects.missing._handler(s.ctx, {
        projectId: 'project',
        objects: pins.map(p => ({ digest: p.sha256, size: p.size })),
      }),
    upload: async (p, bytes) => {
      const row = await objects.prepare._handler(s.ctx, {
        projectId: 'project',
        digest: p.sha256,
        size: p.size,
      });
      if (!row.stored) await putR2(s, row, bytes);
    },
    publish: (p, _metadataOnly, ownerDerived) =>
      actions.publish._handler(s.ctx, {
        projectId: 'project',
        operationId: randomUUID(),
        previous,
        digest: p.sha256,
        size: p.size,
        displayProtocol: 3,
        ownerDerived,
      }),
    manifest: backupId => actions.manifest._handler(s.ctx, { backupId }),
    download: async p => {
      const first = await actions.downloadPart._handler(s.ctx, {
        projectId: 'project',
        digest: p.sha256,
        offset: 0,
      });
      if (first.direct) {
        const [signed] = await modules.projectObjectDownloads.signDownloads._handler(s.ctx, {
          projectId: 'project',
          digests: [p.sha256],
        });
        return Buffer.from(await (await fetch(signed.url)).arrayBuffer());
      }
      const chunks = [];
      let offset = 0;
      do {
        const part = await actions.downloadPart._handler(s.ctx, {
          projectId: 'project',
          digest: p.sha256,
          offset,
        });
        chunks.push(Buffer.from(part.data));
        offset += part.data.byteLength;
      } while (offset < p.size);
      return Buffer.concat(chunks);
    },
  };
}
test('project object storage puts bytes in R2, deduplicates and preserves project isolation', async () => {
  const s = fixture(),
    bytes = Buffer.from('private source'),
    pin = { projectId: 'project', digest: digest(bytes), size: bytes.length };
  const row = await objects.prepare._handler(s.ctx, pin);
  assert.equal(row.created, true);
  assert.equal(row.target.kind, 'r2');
  await putR2(s, row, bytes);
  const retry = await objects.prepare._handler(s.ctx, pin);
  assert.equal(retry.id, row.id);
  assert.equal(retry.stored, true);
  assert.equal(retry.target, undefined);
  assert.equal(s.tables.projectObjects.get(row.id).location, 'r2');
  assert.equal(s.files.size, 0);
  for (const actor of [undefined, 'stranger']) {
    s.caller(actor);
    await assert.rejects(
      objects.missing._handler(s.ctx, {
        projectId: 'project',
        objects: [{ digest: pin.digest, size: pin.size }],
      }),
    );
    await assert.rejects(
      actions.downloadPart._handler(s.ctx, { projectId: 'project', digest: pin.digest, offset: 0 }),
    );
  }
  s.caller('owner');
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  const other = await objects.prepare._handler(s.ctx, { ...pin, projectId: 'other' });
  assert.notEqual(other.id, row.id);
  assert.notEqual(other.target.url, row.target.url);
  assert.deepEqual(
    await objects.missing._handler(s.ctx, {
      projectId: 'other',
      objects: [{ digest: pin.digest, size: pin.size }],
    }),
    [pin.digest],
  );
});

test('explicit project deletion removes every object row, including unresolved uploads, and preserves foreign files', async () => {
  const s = fixture(),
    lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts')),
    { purgeSettleMs } = await import(moduleUrl('../convex/projectRetention.ts')),
    t = transport(s);
  const pin = { sha256: digest('retained'), size: 8 };
  await t.upload(pin, Buffer.from('retained'));
  await objects.prepare._handler(s.ctx, { projectId: 'project', digest: digest('unknown'), size: 7 });
  const foreignId = await s.ctx.storage.store(new Blob(['keep'], { type: 'application/x-foreign' }));
  await lifecycle.permanentlyDelete._handler(s.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    expectedRevision: 0,
    confirm: 'Synthetic exchange',
  });
  // Skip the settle wait for signed uploads issued before deletion.
  s.tables.hostedProjects.get('project').removedAt -= purgeSettleMs;
  for (let n = 0; n < 20 && s.tables.hostedProjects.get('project').removal !== 'deleted'; n++) {
    await lifecycle.purge._handler(s.ctx, { projectId: 'project' });
    // The scheduled R2 prefix purge (tests/r2-maintenance.test.mjs) finishes before the tombstone.
    const project = s.tables.hostedProjects.get('project');
    if (project.r2Purge) project.r2PrefixPurged = true;
  }
  assert.equal(s.tables.hostedProjects.get('project').removal, 'deleted');
  assert.ok(s.tables.hostedProjects.get('project').r2Purge, 'every deletion purges its R2 prefix');
  assert.ok(s.files.has(foreignId));
  assert.equal(
    [...s.tables.projectObjects.values()].filter(row => row.projectId === 'project').length,
    0,
    'the purge removes every object row of the project',
  );
  await assert.rejects(
    objects.prepare._handler(s.ctx, { projectId: 'project', digest: pin.sha256, size: pin.size }),
  );
});

test('small batches verify all bytes while larger content retains ranged downloads', async () => {
  const contents = [Buffer.from('one'), Buffer.from('two')],
    pins = contents.map(bytes => ({ sha256: digest(bytes), size: bytes.length }));
  const { ConvexExchange } = await import('../dist/exchange-client.js'),
    client = new ConvexExchange(
      testDeploymentOrigin('https://fixture.convex.cloud'),
      'fixture',
      'project',
      'op',
      null,
    ),
    large = Buffer.alloc(2 * 1024 * 1024 + 1, 42),
    largePin = { sha256: digest(large), size: large.length };
  let batches = 0,
    ranged = 0;
  client.client.mutation = async () => []; // no R2 objects
  client.client.action = async (_ref, args) => {
    batches++;
    return args.digests.map(id => {
      const index = pins.findIndex(pin => pin.sha256 === id);
      return { data: contents[index], digest: id, size: contents[index].length };
    });
  };
  client.download = async pin => {
    ranged++;
    assert.equal(pin.sha256, largePin.sha256);
    return large;
  };
  assert.deepEqual(await client.downloadBatch([...pins, largePin]), [...contents, large]);
  assert.equal(batches, 1);
  assert.equal(ranged, 1);
  client.client.action = async () => [
    { data: Buffer.from('bad'), digest: pins[0].sha256, size: pins[0].size },
  ];
  const cold = new ConvexExchange(
    testDeploymentOrigin('https://fixture.convex.cloud'),
    'fixture',
    'project',
    'other',
    null,
  );
  cold.client.mutation = async () => []; // no R2 objects
  cold.client.action = client.client.action;
  await assert.rejects(cold.downloadBatch([pins[0]]));
});

test('retiring a migrated archive keeps an R2 container that another backup still names (review of Item c0af6cfa)', async () => {
  const { backupRow } = await import('./hosted-fixture.mjs');
  const s = fixture(),
    key = `v1/p/project/o/${'a'.repeat(64)}`;
  const receipt = { digest: 'a'.repeat(64), size: 10, location: 'r2', r2Committed: true, r2Key: key };
  for (const id of ['first', 'second'])
    s.tables.projectBackups.set(
      id,
      backupRow({
        _id: id,
        projectId: 'project',
        transport: 'objects',
        objectManifest: { digest: 'b'.repeat(64), size: 5 },
        archiveReceipt: { ...receipt, operationId: 'op', at: 0 },
      }),
    );
  const retire = id =>
    modules.projectExchange.retireArchive._handler(s.ctx, {
      backupId: id,
      owner: 'owner',
      operationId: 'op',
    });
  assert.equal((await retire('first')).retired, false, 'the second backup still names the same container');
  s.tables.projectBackups.delete('second');
  assert.equal((await retire('first')).retired, true);
});
