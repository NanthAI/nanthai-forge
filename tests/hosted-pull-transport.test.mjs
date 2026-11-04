// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rootFixture } from './hosted-root-fixture.mjs';
import { cloneHostedProject } from '../dist/hosted-clone-cli.js';
import { pullHostedProject, mainCheckoutTransport } from '../dist/hosted-pull.js';
import { HostedCheckoutDownloads } from '../dist/hosted-checkout-downloads.js';
import { digest } from '../dist/hash.js';
import { hostedAgentAddress } from '../dist/hosted-agent-cli.js';
import { laneHousekeeping } from '../dist/lane-prune.js';
import { recordLane, forgetLane } from '../dist/lane-registry.js';
const initialTransport = f => {
  const downloads = new HostedCheckoutDownloads(f.exchange);
  return {
    current: () => f.exchange.current(),
    objects: ids => downloads.objects(ids),
    downloadToFile: (pin, path) => downloads.downloadToFile(pin, path),
    downloadFiles: files => downloads.downloadFiles(files),
  };
};
test('real R2 descriptors: one bounded head read, changed-only bytes, DB read budget and revocation', async t => {
  const f = await rootFixture(t, 30);
  await cloneHostedProject(f.root, f.address, initialTransport(f));
  const before = f.documents(),
    start = f.calls.length,
    gets = f.fake.requests.filter(r => r.method === 'GET').length;
  await pullHostedProject(f.root, f.address, mainCheckoutTransport(f.root, f.address, f.exchange));
  assert.equal(f.calls.length - start, 1);
  assert.equal(f.fake.requests.filter(r => r.method === 'GET').length - gets, 0);
  assert(f.documents().read - before.read <= 6);
  assert.equal(f.documents().written, before.written);
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const id = digest(bytes),
      r2Key = `v1/p/project/o/${id}`;
    f.fake.objects.set(f.fake.key(r2Key), bytes);
    f.s.tables.projectObjects.set(id, {
      _id: id,
      projectId: 'project',
      digest: id,
      size: bytes.length,
      r2Key,
      location: 'r2',
      r2Committed: true,
      removed: false,
      nonce: 'synthetic',
    });
    return id;
  };
  const files = f.files.map((file, i) => (i < 10 ? { ...file, blob: put(`changed ${i}\n`) } : file));
  const head = put(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [f.main.head],
      files,
      message: 'synthetic changes',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  const main = {
    ...f.main,
    head,
    sourceRevision: 1,
    snapshotId: randomUUID(),
    receipt: {
      id: randomUUID(),
      kind: 'server',
      previousHead: f.main.head,
      previousReceiptId: f.main.receipt.id,
    },
  };
  f.s.tables.projectHostedChannels.get('main').selection = JSON.stringify(main);
  const start2 = f.calls.length,
    before2 = f.documents(),
    gets2 = f.fake.requests.filter(r => r.method === 'GET').length;
  await pullHostedProject(f.root, f.address, mainCheckoutTransport(f.root, f.address, f.exchange));
  assert.equal(f.calls.length - start2, 4);
  assert.equal(f.fake.requests.filter(r => r.method === 'GET').length - gets2, 11);
  assert(f.documents().read - before2.read < 50);
  assert.equal(f.documents().written, before2.written);
  // The root address is stable across changing receipts and mismatched projects fail locally.
  assert.deepEqual(hostedAgentAddress(f.root, {}), f.address);
  assert.throws(() => hostedAgentAddress(f.root, { ...f.address, projectId: 'foreign' }), {
    code: 'PROJECT_UNAVAILABLE',
  });
  // A stale registry entry must not allow prune to reclaim a main checkout.
  const laneId = randomUUID();
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(f.root, '..', 'private-registry');
  try {
    assert(recordLane({ laneId, root: f.root, ...f.address, lastActionAt: 1 }, 1));
    const pruned = await laneHousekeeping({
      address: f.address,
      apply: true,
      now: Date.now(),
      settings: { autoPruneHours: 1, idleLaneHours: 1 },
      readStates: async () => new Map([[laneId, 'completed']]),
    });
    assert.equal(pruned.pruned.length, 0);
    assert(existsSync(f.root));
    assert(pruned.kept.some(item => item.laneId === laneId && item.reason === 'not this Lane checkout'));
  } finally {
    forgetLane(laneId);
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  }
  f.s.caller('stranger');
  await assert.rejects(
    pullHostedProject(f.root, f.address, mainCheckoutTransport(f.root, f.address, f.exchange)),
    /PROJECT_UNAVAILABLE/,
  );
  assert.equal(readFileSync(join(f.root, files[0].path), 'utf8'), 'changed 0\n');
});
