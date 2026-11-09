// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { measureRootBudget } from './hosted-root-budget.mjs';
import { digest } from '../dist/hash.js';
import { rootFixture } from './hosted-root-fixture.mjs';
import { HostedCheckoutDownloads } from '../dist/hosted-checkout-downloads.js';
import { hostedCloneCli, cloneHostedProject } from '../dist/hosted-clone-cli.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentAddress } from '../dist/hosted-agent-cli.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
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
  agent.agentSession = 'one-agent-session'; // the identical start below replays within this session
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
    // Measured 2026-11-05 (12 runs, default V8 flags, busy 16 GB Mac): min 219, median ~261, max 312 MiB.
    // The spread is V8 young-generation slack, not live data (downloads stream to disk, live heap peaks
    // near 75 MiB), so this default-flag ceiling is only a crash guard against gross buffering. The
    // deterministic live-data bound is the semi-space-1 test below.
    if (count === 2538) assert(metrics.clonePeakRssMiB <= 380, `${metrics.clonePeakRssMiB} MiB RSS`);
    assert.equal(metrics.cloneDocuments.written, 0);
    assert(
      f.calls
        .filter(c => c.name === 'projectObjectDownloads:describe')
        // Signed run pages hold up to 500 pins; per-object pages stay at 100.
        .every(c => c.args.digests.length <= (c.args.runs ? 500 : 100)),
    );
    assert(!f.calls.some(c => /downloadPart|downloadBatch|signDownloads|projectMain:objects/.test(c.name)));
  });

// Deterministic live-data guard. Peak RSS is not a stable measure of retained data: on the Linux hosted
// runner identical runs of this test measured 196-248 MiB (glibc thread arenas and allocator slack), so an
// RSS bound either flaked (235) or was too wide to see a 30 MiB leak. The CLI child therefore measures live
// memory (V8 heapUsed + external Buffers/ArrayBuffers, every 2 ms and at every fetch), which does not depend
// on allocator, platform or young-generation sizing. Raw live samples still counted old-space garbage that
// a loaded runner had not collected yet: hosted Linux read 55.3-71.6 MiB over 10 identical runs on
// 2026-11-07 and failed this bound once (71.6). With --expose-gc the child re-measures every new peak after
// a full GC (tests/live-memory-sampler.mjs), so the asserted peak is retained data only. The flags are
// passed only to the child node process of this test; the product sets no V8 flags.
// Confirmed peak, 2026-11-07: macOS 34.3-35.6 MiB, 3 idle runs and 3 with 6 CPU burners (load ~58) on
// `nforge heavy`. On Linux the confirmed peak is at most the lowest raw peak, 55.3 MiB. Bound 70 MiB is
// unchanged: one extra copy of the 24 MiB source set (about 79 MiB on Linux) still fails it. The RSS, raw
// peak and pre-clone baseline stay diagnostics; re-tighten from hosted confirmed samples.
const SEMI_SPACE_1_LIVE_BOUND_MIB = 70;
test('2538-file clone peak live memory stays bounded with a 1 MiB semi-space (live-data guard)', async t => {
  const f = await rootFixture(t, 2538, 24 * 1024 * 1024, 10);
  const metrics = await measureRootBudget(t, f, { nodeArgs: ['--max-semi-space-size=1', '--expose-gc'] });
  t.diagnostic(
    `semi-space-1 clone RSS ${metrics.clonePeakRssMiB} MiB, live ${metrics.clonePeakLiveMiB} MiB ` +
      `(raw ${metrics.clonePeakSampledLiveMiB}, baseline ${metrics.cloneBaselineLiveMiB}, ` +
      `${metrics.cloneCollections} GCs, ${metrics.cloneMs} ms)`,
  );
  assert(metrics.cloneCollections > 0, 'the peak is GC-confirmed');
  assert(
    metrics.clonePeakLiveMiB <= SEMI_SPACE_1_LIVE_BOUND_MIB,
    `${metrics.clonePeakLiveMiB} MiB live memory with --max-semi-space-size=1 (bound ${SEMI_SPACE_1_LIVE_BOUND_MIB})`,
  );
});

// The guard above is only as good as its measurement: a planted 24 MiB retention must show, and
// promoted objects that later die (old-space garbage awaiting a major GC) must not.
test('live-memory sampler counts retained data, not garbage awaiting a major GC', async t => {
  const churn = `
    const { liveMemorySampler } = await import(${JSON.stringify(pathToFileURL(resolve('tests/live-memory-sampler.mjs')).href)});
    const memory = liveMemorySampler();
    const kept = process.env.PLANT ? Buffer.alloc(24 * 1048576, 1) : undefined;
    let held = [];
    for (let round = 0; round < 40; round++) {
      // About 2 MiB of objects per round, held for four rounds so they are promoted, then dropped.
      held.push(Array.from({ length: 20000 }, (_, i) => ({ round, i, text: 'synthetic-' + i })));
      if (held.length === 4) held = [];
      memory.sample();
      await new Promise(resolve => setImmediate(resolve));
    }
    memory.sample();
    console.log(JSON.stringify({ ...memory.report(), kept: kept?.length ?? 0 }));`;
  const run = async plant =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          ['--expose-gc', '--max-semi-space-size=1', '--input-type=module', '-e', churn],
          { env: { ...process.env, PLANT: plant ? '1' : '' } },
        )
      ).stdout,
    );
  const [clean, planted] = [await run(false), await run(true)];
  t.diagnostic(JSON.stringify({ clean, planted }));
  assert(clean.confirmed && clean.collections > 0);
  // About 80 MiB of objects pass through the heap; at most about 8 MiB are reachable at once.
  assert(clean.peakLiveMiB < 24, `clean peak ${clean.peakLiveMiB} MiB`);
  assert(
    planted.peakLiveMiB - clean.peakLiveMiB >= 22,
    `planted ${planted.peakLiveMiB} vs ${clean.peakLiveMiB} MiB`,
  );
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

// Issue ca49dc6c: a completed checkout replays only while its folder still holds it.
test('incident replay 8fbda971: clone into a folder deleted or emptied after an earlier clone installs it again', async t => {
  const f = await rootFixture(t);
  mkdirSync(f.root);
  const first = await clone(f);
  assert.equal(first.replayed, false);
  assert.equal((await clone(f)).replayed, true, 'an intact clone still replays');
  rmSync(f.root, { recursive: true, force: true });
  assert(existsSync(`${f.root}.forge-client`), 'the sidecar receipt is kept');
  const again = await clone(f);
  assert.equal(again.replayed, false);
  assert.notEqual(again.operationId, first.operationId);
  assert.equal(again.head, f.main.head);
  assert.equal(readFileSync(join(f.root, 'large.bin')).length, 4 * 1024 * 1024);
  // Emptied (folder kept): the same.
  for (const name of readdirSync(f.root)) rmSync(join(f.root, name), { recursive: true, force: true });
  const emptied = await clone(f);
  assert.equal(emptied.replayed, false);
  assert(existsSync(join(f.root, 'large.bin')));
  // A folder replaced by other files is never overwritten: it refuses with the empty-folder rule.
  for (const name of readdirSync(f.root)) rmSync(join(f.root, name), { recursive: true, force: true });
  writeFileSync(join(f.root, 'keep'), 'synthetic local draft');
  await assert.rejects(cloneHostedProject(f.root, f.address, transport(f)), {
    code: 'WORK_CONFLICT',
  });
  assert.equal(readFileSync(join(f.root, 'keep'), 'utf8'), 'synthetic local draft');
});

test('open and a replayed start into a deleted Lane folder install the Lane again, never report empty success', async t => {
  const f = await rootFixture(t);
  mkdirSync(f.root);
  await clone(f);
  const agent = new HostedAgentTransport(f.root, f.address, f.exchange);
  agent.agentSession = 'one-agent-session'; // the identical start below replays within this session
  const started = await agent.dispatch('start', { outcome: 'Deleted folder' });
  const laneId = started.result.lane.laneId,
    path = started.result.path;
  assert(existsSync(join(path, 'large.bin')));
  const opened = await agent.dispatch('open', { laneId });
  assert.equal(opened.result.root, path);
  rmSync(path, { recursive: true, force: true });
  const reopened = await agent.dispatch('open', { laneId });
  assert.notEqual(reopened.operationId, opened.operationId, 'the open is new work');
  assert.equal(reopened.result.replayed, false);
  assert.equal(readFileSync(join(path, 'large.bin')).length, 4 * 1024 * 1024);
  assert.equal(readHostedLaneCheckout(path).selection.laneId, laneId);
  rmSync(path, { recursive: true, force: true });
  const replayed = await agent.dispatch('start', { outcome: 'Deleted folder' });
  assert.equal(replayed.operationId, started.operationId, 'the same start replays');
  assert.equal(replayed.result.lane.laneId, laneId);
  assert.equal(replayed.result.checkout.replayed, false);
  assert(existsSync(join(path, 'large.bin')));
});
