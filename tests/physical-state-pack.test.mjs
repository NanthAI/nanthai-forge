// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { expandSourceGrants } from '../dist/source-grant-wire.js';
import { digest } from '../dist/hash.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { moduleUrl } from './convex-module.mjs';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';
import {
  hostedActionsCapabilities,
  actionsSourceStateCapability,
} from '../dist/hosted-actions-capabilities.js';
import { materializeActionsSource } from '../dist/hosted-actions-job-source.js';
import { refreshActionsSourcePack } from '../dist/hosted-actions-job-pack.js';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { sourcePackCommand } = await import(moduleUrl('../convex/projectSourcePacks.ts'));
const { writableHostedCheck, writeHostedCheck } = await import(
  moduleUrl('../convex/projectHostedCheckStore.ts')
);
test('pack refresh selects the accepted base for a file the Candidate changed instead of denying it as a Candidate nonmember', async t => {
  const f = await physicalStateSourceFixture(t, 10),
    oldBytes = Buffer.from('old source'),
    oldBlob = f.s.put(oldBytes),
    baseFiles = f.files.map((file, index) => (index ? file : { ...file, blob: oldBlob.sha256 })),
    baseBytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: baseFiles,
        message: 'accepted base',
        at: '2026-01-01T00:00:00.000Z',
      }),
    ),
    base = f.s.put(baseBytes);
  const store = bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    f.r2.objects.set(`/synthetic/v1/p/${f.s.projectId}/o/${pin.sha256}`, bytes);
    return pin;
  };
  const entries = new Map(f.entries.map(entry => [entry.sha256, entry]));
  entries.set(oldBlob.sha256, oldBlob);
  const root = await writePhysicalManifest({
    state: base.sha256,
    members: baseFiles.map(file => file.blob),
    parent: null,
    describe: async ids => ids.map(id => entries.get(id)),
    put: store,
  });
  const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === base.sha256);
  f.s.patch('projectObjects', row._id, { statePhysical: root.pin });
  for (const [id, bytes] of [
    [oldBlob.sha256, oldBytes],
    [base.sha256, baseBytes],
  ]) {
    f.r2.objects.set(`/synthetic/v1/p/${f.s.projectId}/o/${id}`, bytes);
    f.r2.objects.set(`/synthetic/synthetic/${id}`, bytes);
  }
  f.run.candidate.base.head = base.sha256;
  await f.s.transaction(
    'physical-pin-accepted-base',
    {
      _handler: async ctx => {
        const selected = await writableHostedCheck(ctx, f.input);
        selected.run.candidate.base.head = base.sha256;
        await writeHostedCheck(ctx, selected.row._id, selected.run);
      },
    },
    {},
  );
  const directory = temporaryDirectory(t, 'forge-state-base-pack-'),
    cache = join(directory, 'objects');
  mkdirSync(cache);
  const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, async (url, init) => {
    if (init?.method === 'PUT') {
      const parts = [];
      for await (const bytes of init.body) parts.push(bytes);
      return fetch(url, { ...init, body: Buffer.concat(parts) });
    }
    return fetch(url, init);
  });
  client.run = f.run;
  client.capabilities = [...hostedActionsCapabilities, actionsSourceStateCapability];
  t.mock.method(client, 'call', async command => {
    if (command.kind === 'source')
      return command.state ? expandSourceGrants(await f.source(command)) : f.heads();
    assert.equal(command.kind, 'sourcePack');
    return sourcePackCommand(f.ctx, f.input, command.phase, command.object);
  });
  const source = await materializeActionsSource(client, join(directory, 'candidate'), cache);
  assert.equal(await refreshActionsSourcePack(client, source, cache), true);
  assert(
    f.calls.some(
      call => call.name === 'projectStateSourceSelection:runner' && call.args.state === base.sha256,
    ),
  );
  const published = [...f.s.tables.projectSourcePacks.values()][0].latest;
  assert.equal(published.stateRef, base.sha256);
});
