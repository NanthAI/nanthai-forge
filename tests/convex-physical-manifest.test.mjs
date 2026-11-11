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
  assert.equal(seeds.length, 11);
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
