// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { digest } from '../dist/hash.js';
import { physicalProject as project, physicalObjectRow as row } from './convex-physical-manifest-fixture.mjs';
test('captured default-off physical writer leaves old dispatches unchanged even when the setting later turns on', async t => {
  const f = await project(t, 20),
    result = await f.compose(f.files, f.base, 'main-0', false);
  assert.equal(row(f.s, f.base.sha256).statePhysical, undefined);
  assert.equal(row(f.s, result.head.sha256).statePhysical, undefined);
  assert.equal(f.requests.filter(request => request.seed).length, 0);
});
test('29k compose seeds once in catalog windows, extends only changed bindings, and retries retain the same physical root', async t => {
  const f = await project(t, 29000),
    changed = f.files.map((file, index) =>
      index < 8 ? f.s.file(file.path, `first\nchanged-${index}\nlast\n`) : file,
    );
  const first = await f.compose(changed, f.base, 'main-0');
  const basePin = row(f.s, f.base.sha256).statePhysical,
    firstPin = row(f.s, first.head.sha256).statePhysical;
  assert(basePin && firstPin);
  const seeds = f.requests.filter(request => request.seed);
  assert.equal(seeds.length, 29);
  assert.equal(
    seeds.reduce((sum, request) => sum + request.digests.length, 0),
    29000,
  );
  const firstReader = await PhysicalManifestReader.open(first.head.sha256, firstPin, f.read);
  assert.deepEqual(
    (await firstReader.lookup(changed.slice(0, 8).map(file => file.blob))).map(entry => entry.sha256),
    changed.slice(0, 8).map(file => file.blob),
  );
  assert.deepEqual(await firstReader.lookup(f.files.slice(0, 8).map(file => file.blob)), Array(8).fill(null));
  f.s.main.head = first.head.sha256;
  f.s.main.receipt.id = 'main-1';
  f.s.moveMain(first.head.sha256, 'main-1');
  const offset = f.requests.length;
  const next = changed.map((file, index) =>
    index === 8 ? f.s.file(file.path, 'first\nnext\nlast\n') : file,
  );
  const second = await f.compose(next, first.head, 'main-1');
  const requests = f.requests.slice(offset);
  assert.equal(
    requests.filter(request => request.seed).length,
    0,
    'following composes never reseed a manifest-bound main',
  );
  const catalogFiles = requests
    .filter(request => !request.ancestry && !request.probe)
    .flatMap(request => request.digests)
    .filter(id => next.some(file => file.blob === id));
  assert.deepEqual(catalogFiles, [next[8].blob], 'ordinary writer reads only its new file binding');
  const secondPin = row(f.s, second.head.sha256).statePhysical;
  assert(secondPin);
  const reader = await PhysicalManifestReader.open(second.head.sha256, secondPin, f.read);
  assert.equal((await reader.lookup([next[8].blob]))[0].sha256, next[8].blob);
  assert.equal(digest(f.s.objects.get(secondPin.sha256)), secondPin.sha256);
  const before = f.c.r2Puts.length;
  await f.c.call('projectConvexSource:dispatch', { projectId: f.s.projectId, jobId: second.job.id });
  assert.deepEqual(row(f.s, second.head.sha256).statePhysical, secondPin);
  assert.equal(f.c.r2Puts.length, before, 'terminal dispatch replay writes no metadata bodies');
  assert.equal(f.c.storageCalls(), 0, 'all manifest bytes are in R2');
  t.diagnostic(
    JSON.stringify({
      files: 29000,
      seedCalls: seeds.length,
      secondDescriptorCalls: requests.length,
      rootBytes: secondPin.size,
    }),
  );
});

test('the writer preserves canonical raw and pack nonce bindings and skips foreign or malformed keys', async () => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const { physicalSourceBinding } = await import(moduleUrl('../convex/projectConvexPhysicalManifest.ts'));
  const sha256 = digest('source'),
    pack = digest('pack'),
    nonce = '00000000-0000-4000-8000-000000000001';
  const raw = { descriptor: { object: { sha256, size: 3 }, recipe: null }, storageId: null, url: null };
  assert.deepEqual(physicalSourceBinding('project', raw, `v1/p/project/o/${sha256}/u/${nonce}`), {
    sha256,
    size: 3,
    nonce,
  });
  const packed = { ...raw, range: { offset: 4, total: 10 } };
  assert.deepEqual(physicalSourceBinding('project', packed, `v1/p/project/o/${pack}/u/${nonce}`), {
    sha256,
    size: 3,
    pack: { digest: pack, size: 10, offset: 4, nonce },
  });
  for (const key of [
    `v1/p/other/o/${sha256}`,
    `bad/v1/p/project/o/${sha256}`,
    `v1/p/project/o/${sha256}/u/not-a-nonce`,
    `v1/p/project/o/${pack}`,
  ])
    assert.equal(physicalSourceBinding('project', raw, key), null);
  const signed = {
    ...packed,
    url: `https://store.invalid/bucket/v1/p/project/o/${pack}/u/${nonce}?signed=synthetic`,
  };
  assert.deepEqual(
    physicalSourceBinding('project', signed),
    physicalSourceBinding('project', packed, `v1/p/project/o/${pack}/u/${nonce}`),
  );
});

for (const count of [2500, 29000])
  test(`${count}-file first seed after dense retirement bounds every function's queries and documents`, async t => {
    const f = await project(t, count, { points: true });
    const result = await f.compose(f.files, f.base, 'main-0');
    const seeds = f.requests.filter(request => request.seed);
    assert.equal(seeds.length, Math.ceil(count / 1000));
    assert.equal(
      seeds.reduce((sum, request) => sum + request.digests.length, 0),
      count,
    );
    const measurements = f.s.counts.filter(row => row.name === 'projectConvexSourceObjects:resolve');
    for (const row of measurements) {
      assert(row.ranges <= 3100, `${row.ranges} queries`);
      assert(row.documents <= 3100, `${row.documents} document reads including misses`);
    }
    const pin = row(f.s, result.head.sha256).statePhysical;
    const reader = await PhysicalManifestReader.open(result.head.sha256, pin, f.read);
    const members = f.files.map(file => file.blob);
    assert.deepEqual(
      (await reader.lookup(members)).map(pin => pin?.sha256),
      members,
    );
    t.diagnostic(
      JSON.stringify({
        files: count,
        seedCalls: seeds.length,
        maxQueries: Math.max(...measurements.map(row => row.ranges)),
        maxDocuments: Math.max(...measurements.map(row => row.documents)),
        maxReturnedDocuments: Math.max(...measurements.map(row => row.returnedDocuments)),
      }),
    );
  });

test('ancestry prefetch counts absent hints and leaves exact requested reads available', async t => {
  const f = await project(t, 1);
  const { getFunctionName } = await import('convex/server');
  const roots = Array.from({ length: 100 }, (_, index) => {
    const id = digest(`hint-root-${index}`);
    f.s.insert('projectObjects', {
      projectId: f.s.projectId,
      digest: id,
      size: 0,
      nonce: 'synthetic',
      removed: false,
      location: 'r2',
      r2Committed: true,
      r2Key: `v1/p/${f.s.projectId}/o/${id}`,
      stateParents: Array.from({ length: 16 }, (_, parent) => digest(`missing-${index}-${parent}`)),
    });
    return id;
  });
  const original = f.c.context.runMutation;
  let checked = false;
  f.c.context.runMutation = async (ref, args) => {
    if (!checked && getFunctionName(ref) === 'projectConvexSourceObjects:resolve') {
      checked = true;
      const rows = JSON.parse(
        await original(ref, {
          projectId: args.projectId,
          jobId: args.jobId,
          step: args.step,
          digests: roots,
          ancestry: true,
          known: [],
          windows: 4,
        }),
      );
      assert(rows.length > 0 && rows.length < roots.length);
      const measured = f.s.counts.at(-1);
      assert(measured.ranges < 1300, 'one bounded function includes missing primary/catalog probes');
      // Prefetch hints never establish absence: every requested root still resolves
      // when the caller later asks for its exact descriptor.
      const exact = JSON.parse(
        await original(ref, {
          projectId: args.projectId,
          jobId: args.jobId,
          step: args.step,
          digests: roots,
          ancestry: false,
          known: [],
        }),
      );
      assert.deepEqual(
        exact.map(row => row.descriptor.object.sha256),
        roots,
      );
    }
    return original(ref, args);
  };
  await f.compose(f.files, f.base, 'main-0', false);
  assert(checked);
});
