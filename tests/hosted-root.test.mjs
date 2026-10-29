// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureRootBudget } from './hosted-root-budget.mjs';
import { digest } from '../dist/hash.js';
import { rootFixture } from './hosted-root-fixture.mjs';
import { HostedCheckoutDownloads } from '../dist/hosted-checkout-downloads.js';
import { hostedCloneCli, cloneHostedProject } from '../dist/hosted-clone-cli.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentAddress } from '../dist/hosted-agent-cli.js';
const transport = f => {
  const downloads = new HostedCheckoutDownloads(f.exchange);
  return {
    current: expected => f.exchange.current(expected),
    objects: ids => downloads.objects(ids),
    downloadToFile: (pin, path) => downloads.downloadToFile(pin, path),
    downloadFiles: files => downloads.downloadFiles(files),
  };
};
const clone = f =>
  hostedCloneCli(['https://forge.example/alice/project', f.root, '--deployment', f.address.url], {
    client: f.exchange.client,
    transport: () => transport(f),
  });
test('clone binds and materializes hosted main in an empty DIR, with no owner or listener; nonempty is preserved', async t => {
  const f = await rootFixture(t);
  mkdirSync(f.root);
  const result = await clone(f);
  assert.equal(result.head, f.main.head);
  assert.equal(result.path, f.root);
  assert.deepEqual(hostedAgentAddress(f.root, {}), f.address);
  assert.equal(readFileSync(join(f.root, 'large.bin')).length, 4 * 1024 * 1024);
  assert(!existsSync(join(f.root, '.forge/native.json')));
  assert(!existsSync(join(f.root, '.forge/work')));
  const occupied = join(f.root, '..', 'occupied');
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'keep'), 'private local draft');
  await assert.rejects(cloneHostedProject(occupied, f.address, transport(f)), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(occupied, 'keep'), 'utf8'), 'private local draft');
  assert.equal((await clone(f)).replayed, true);
  f.revoke();
  await assert.rejects(clone(f), { code: 'PROJECT_UNAVAILABLE' });
});
test('second and third Lane use independent paths and locks, retain drafts, replay and open from one root', async t => {
  const f = await rootFixture(t);
  await clone(f);
  const agent = new HostedAgentTransport(f.root, f.address, f.exchange);
  const first = await agent.dispatch('start', { outcome: 'First' });
  writeFileSync(join(first.result.path, 'draft'), 'keep');
  const [second, third] = await Promise.all([
    agent.dispatch('start', { outcome: 'Second' }),
    agent.dispatch('start', { outcome: 'Third' }),
  ]);
  assert.equal(new Set([first, second, third].map(r => r.result.path)).size, 3);
  for (const r of [first, second, third]) {
    assert.equal(hostedAgentAddress(r.result.path, {}).projectId, 'project');
    assert.equal(readFileSync(join(r.result.path, 'large.bin')).length, 4 * 1024 * 1024);
  }
  assert.equal(readFileSync(join(first.result.path, 'draft'), 'utf8'), 'keep');
  assert.equal((await agent.dispatch('start', { outcome: 'First' })).result.path, first.result.path);
  const reopened = await agent.dispatch('open', { laneId: second.result.lane.laneId });
  assert.equal(reopened.result.root, second.result.path);
  const before = f.calls.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, before, 'idle installs no observer or transport');
});
test('single-Lane roots keep their original path and can start another Lane', async t => {
  const f = await rootFixture(t),
    agent = new HostedAgentTransport(f.root, f.address, f.exchange);
  const first = await agent.dispatch('start', { outcome: 'Original unopened root' });
  // Existing open protocol still materializes its first Lane directly in ROOT.
  await agent.dispatch('open', { laneId: first.result.lane.laneId });
  writeFileSync(join(f.root, 'draft'), 'keep');
  const second = await agent.dispatch('start', { outcome: 'Second from single-Lane root' });
  assert.notEqual(second.result.path, f.root);
  assert.equal(readFileSync(join(f.root, 'draft'), 'utf8'), 'keep');
});
for (const count of [2538, 5076])
  test(`recipe clone and warm starts fit call budgets at ${count} files`, async t => {
    const f = await rootFixture(
      t,
      count,
      count === 2538 ? 24 * 1024 * 1024 : 48 * 1024 * 1024,
      count === 2538 ? 10 : 20,
    );
    const metrics = await measureRootBudget(t, f);
    t.diagnostic(JSON.stringify(metrics));
    assert(metrics.cloneCalls <= (count === 2538 ? 40 : 80), `${metrics.cloneCalls} clone calls`);
    assert(f.files.filter(file => file.path.startsWith('large')).length >= 10);
    assert(metrics.startCalls <= 10, `${metrics.startCalls} start calls`);
    // The brief applies the RSS ceiling to the dogfood-size clone; doubled-size
    // and start RSS are measured, while their specified call budgets stay enforced.
    if (count === 2538) assert(metrics.clonePeakRssMiB <= 300, `${metrics.clonePeakRssMiB} MiB RSS`);
    assert.equal(metrics.cloneDocuments.written, 0);
    assert(
      f.calls
        .filter(c => c.name === 'projectObjectDownloads:describe')
        .every(c => c.args.digests.length <= 100),
    );
    assert(!f.calls.some(c => /downloadPart|downloadBatch|signDownloads|projectMain:objects/.test(c.name)));
  });

test('combined signed pages recheck access and bindings; expired signatures refresh once and corrupt bytes fail', async t => {
  const f = await rootFixture(t),
    downloads = new HostedCheckoutDownloads(f.exchange);
  const [pin] = await downloads.objects([f.files[1].blob]);
  const before = f.calls.length;
  f.fake.forbidGets = 1;
  await downloads.downloadToFile(pin, join(f.root, '..', 'refreshed'));
  assert.equal(f.calls.length - before, 1, 'one fresh metadata/signature page');
  const row = f.s.tables.projectObjects.get(pin.sha256),
    key = f.fake.key(row.r2Key);
  f.fake.corrupt.add(key);
  await assert.rejects(downloads.downloadToFile(pin, join(f.root, '..', 'corrupt')), {
    code: 'INVALID_NATIVE_SOURCE',
  });
  assert.equal(existsSync(join(f.root, '..', 'corrupt')), false);
  f.fake.corrupt.delete(key);
  const nativeFetch = globalThis.fetch;
  let interrupted = false;
  globalThis.fetch = (input, init) => {
    if (!interrupted && new URL(String(input)).pathname.endsWith(pin.sha256)) {
      interrupted = true;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0x62]));
              setTimeout(() => controller.error(new Error('Synthetic interrupted body')), 0);
            },
          }),
        ),
      );
    }
    return nativeFetch(input, init);
  };
  try {
    const target = join(f.root, '..', 'retried');
    await downloads.downloadToFile(pin, target);
    assert.equal(
      readFileSync(target).length,
      pin.size,
      'partial body retries replace their private staging bytes',
    );
    assert(interrupted);
  } finally {
    globalThis.fetch = nativeFetch;
  }
  row.projectId = 'foreign';
  await assert.rejects(
    new HostedCheckoutDownloads(f.exchange).objects([pin.sha256]),
    error => error.data?.code === 'INVALID_WORK_BACKUP',
  );
  row.projectId = 'project';
  f.s.caller('stranger');
  await assert.rejects(
    new HostedCheckoutDownloads(f.exchange).objects([pin.sha256]),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

for (const cycle of [false, true])
  test(`recipe nodes retain nested representations and reject cycles: ${cycle}`, async t => {
    const f = await rootFixture(t);
    const node = [...f.s.tables.projectObjects.values()].find(row => row.size === 1024 * 1024);
    assert(node);
    const put = bytes => {
      const sha256 = digest(bytes),
        r2Key = `v1/p/project/o/${sha256}`;
      f.fake.objects.set(f.fake.key(r2Key), bytes);
      f.s.tables.projectObjects.set(sha256, {
        _id: sha256,
        projectId: 'project',
        digest: sha256,
        size: bytes.length,
        r2Key,
        location: 'r2',
        r2Committed: true,
        removed: false,
        nonce: 'synthetic',
      });
      return { sha256, size: bytes.length };
    };
    const leaf = put(Buffer.alloc(node.size / 2, 0x61));
    const tree = cycle
      ? { sha256: node.digest, size: node.size, height: 0, length: node.size }
      : {
          ...put(
            Buffer.from(
              JSON.stringify({
                schema: 1,
                kind: 'forge-byte-tree',
                children: [
                  { ...leaf, height: 0, length: leaf.size },
                  { ...leaf, height: 0, length: leaf.size },
                ],
              }),
            ),
          ),
          height: 1,
          length: node.size,
        };
    const recipe = put(
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-object-recipe',
          object: { sha256: node.digest, size: node.size },
          tree,
        }),
      ),
    );
    f.s.tables.projectObjects.set(node.digest, {
      _id: node._id,
      projectId: 'project',
      digest: node.digest,
      size: node.size,
      removed: false,
      nonce: 'synthetic',
      recipe: { digest: recipe.sha256, size: recipe.size },
    });
    if (cycle) {
      await assert.rejects(clone(f), error => error.code === 'INVALID_WORK_BACKUP');
      assert(!existsSync(f.root));
    } else {
      await clone(f);
      assert.deepEqual(readFileSync(join(f.root, 'large.bin')), Buffer.alloc(4 * 1024 * 1024, 0x61));
    }
  });
