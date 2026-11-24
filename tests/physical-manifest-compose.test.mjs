// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalProject, physicalObjectRow } from './convex-physical-manifest-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { physicalBucket } from '../dist/physical-manifest-codec.js';
import { physicalKey } from '../dist/physical-manifest-binary.js';
import { stateSchema } from '../dist/state/format.js';
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
async function compose(f, state, main, prepareOutput) {
  const entry = await f.s.lane(state, { base: { head: main.sha256, receiptId: 'main-1' } }),
    selection = f.s.selection([entry]);
  await f.s.prepare(selection);
  await f.s.stage(selection);
  const pending = await f.s.submit(selection),
    identity = { projectId: f.s.projectId, jobId: pending.jobId };
  if (prepareOutput) {
    const job = await f.s.run('compose job', ctx => jobs.loadSourceJob(ctx, f.s.projectId, pending.jobId));
    await prepareOutput(JSON.parse(f.s.objects.get(job.input.sha256)));
  }
  const old = process.env.FORGE_PHYSICAL_MANIFESTS;
  try {
    process.env.FORGE_PHYSICAL_MANIFESTS = '1';
    await f.c.call('projectConvexSource:dispatch', identity);
  } finally {
    if (old === undefined) delete process.env.FORGE_PHYSICAL_MANIFESTS;
    else process.env.FORGE_PHYSICAL_MANIFESTS = old;
  }
  await f.c.call('projectConvexSource:step', { ...identity, step: 0 });
  let job = await f.s.run('compose job', ctx => jobs.loadSourceJob(ctx, f.s.projectId, pending.jobId));
  for (let i = 0; i < 12 && job.status !== 'completed'; i++) {
    const step = [...f.s.tables.projectSourceSteps.values()].find(value => value.jobId === pending.jobId);
    await f.c.call('projectConvexSourceNode:step', { ...identity, step: step.step });
    job = await f.s.run('compose job', ctx => jobs.loadSourceJob(ctx, f.s.projectId, pending.jobId));
  }
  assert.equal(job.status, 'completed');
  return JSON.parse(f.s.objects.get(job.output.sha256)).result.state;
}
async function setup(t) {
  const f = await physicalProject(t, 1000);
  const sourceJob = await f.queueSeed();
  await f.seed();
  const seeded = await f.compose(f.files, f.base, 'main-0');
  f.s.main.head = seeded.head.sha256;
  f.s.main.receipt.id = 'main-1';
  f.s.moveMain(seeded.head.sha256, 'main-1');
  const save = async (files, parent, parentFiles) => {
    const state = f.s.state(files, [parent.sha256]),
      row = physicalObjectRow(f.s, parent.sha256),
      reader = await PhysicalManifestReader.open(parent.sha256, row.statePhysical, f.read),
      root = await writePhysicalManifest({
        state: state.sha256,
        members: files.map(file => file.blob),
        parent: reader,
        parentMembers: parentFiles.map(file => file.blob),
        put: async bytes => f.s.put(Buffer.from(bytes)),
        describe: async ids => ids.map(sha256 => ({ sha256, size: f.s.objects.get(sha256).length })),
      });
    f.s.patch('projectObjects', physicalObjectRow(f.s, state.sha256)._id, {
      statePhysical: root.pin,
      stateParents: [parent.sha256],
      stateGeneration: (row.stateGeneration ?? 1) + 1,
    });
    return { state, root };
  };
  return { ...f, main: seeded.head, save, sourceJob };
}

test('compose repairs an adopted Lane root without a usable main root', async t => {
  const f = await setup(t);
  const extras = Array.from({ length: 8 }, (_, i) => f.s.file(`rootless-${i}.txt`, `working file ${i}`)).sort(
    (a, b) => physicalBucket(a.blob) - physicalBucket(b.blob),
  );
  const removed = extras[3],
    withExtra = [...f.files, ...extras],
    files = withExtra.filter(file => file !== removed),
    intermediate = await f.save(withExtra, f.main, f.files),
    final = await f.save(files, intermediate.state, withExtra),
    privatePack = intermediate.root.root.chunks.find(chunk => chunk.bucket === physicalBucket(removed.blob))
      .pack.digest;
  for (const main of [f.base, f.main])
    f.s.patch('projectObjects', physicalObjectRow(f.s, main.sha256)._id, { statePhysical: undefined });
  const before = f.requests.length;
  const selected = await compose(f, final.state, f.main);
  const pin = physicalObjectRow(f.s, selected.sha256).statePhysical,
    root = await PhysicalManifestReader.open(selected.sha256, pin, f.read);
  assert.equal(selected.sha256, final.state.sha256);
  assert.equal(f.requests.length - before, 2, 'prefetch leaves two descriptor calls for this repair');
  assert.equal(
    root.root.chunks.some(chunk => chunk.pack?.digest === privatePack),
    false,
  );
  assert.deepEqual(await root.lookup([removed.blob, extras[2].blob]), [
    null,
    { sha256: extras[2].blob, size: f.s.objects.get(extras[2].blob).length },
  ]);
});

test('compose uses the selected State catalog for a generated merge without a usable main root', async t => {
  const f = await setup(t);
  const mainFile = f.s.file('rootless-main.txt', 'accepted main file'),
    laneFile = f.s.file('rooted-lane.txt', 'working file'),
    lane = await f.save([...f.files, laneFile], f.main, f.files),
    main = f.s.state([...f.files, mainFile], [f.main.sha256]);
  f.s.patch('projectObjects', physicalObjectRow(f.s, main.sha256)._id, {
    stateParents: [f.main.sha256],
    stateGeneration: 3,
  });
  f.s.patch('projectObjects', physicalObjectRow(f.s, f.base.sha256)._id, { statePhysical: undefined });
  f.s.main.head = main.sha256;
  f.s.moveMain(main.sha256, 'main-1');
  const selected = await compose(f, lane.state, main);
  const state = JSON.parse(f.s.objects.get(selected.sha256)),
    row = physicalObjectRow(f.s, selected.sha256);
  assert.notEqual(selected.sha256, lane.state.sha256);
  assert.deepEqual(state.parents, [main.sha256, lane.state.sha256]);
  assert(state.files.some(file => file.blob === mainFile.blob));
  assert(state.files.some(file => file.blob === laneFile.blob));
  assert.equal(row.statePhysical, undefined);
});

test('generated compose clears a pre-existing working root outside its descriptor window', async t => {
  const f = await setup(t),
    mainFile = f.s.file('rootless-main.txt', 'accepted main file'),
    laneFile = f.s.file('rooted-lane.txt', 'working file'),
    lane = await f.save([...f.files, laneFile], f.main, f.files),
    main = f.s.state([...f.files, mainFile], [f.main.sha256]);
  f.s.patch('projectObjects', physicalObjectRow(f.s, f.base.sha256)._id, { statePhysical: undefined });
  f.s.main.head = main.sha256;
  f.s.moveMain(main.sha256, 'main-1');
  let existing;
  const before = f.requests.length;
  const selected = await compose(f, lane.state, main, async plan => {
    const files = [laneFile, mainFile, ...f.files].sort((a, b) => a.path.localeCompare(b.path));
    existing = f.s.put(
      JSON.stringify(
        stateSchema.parse({
          schema: 1,
          kind: 'forge-source-state',
          parents: [main.sha256, lane.state.sha256],
          files,
          message: plan.message,
          at: plan.at,
        }),
      ),
    );
    const working = await PhysicalManifestReader.open(lane.state.sha256, lane.root.pin, f.read);
    const prior = await writePhysicalManifest({
      state: existing.sha256,
      members: files.map(file => file.blob),
      parent: working,
      parentMembers: [...f.files, laneFile].map(file => file.blob),
      put: async bytes => f.s.put(Buffer.from(bytes)),
      describe: async ids => ids.map(sha256 => ({ sha256, size: f.s.objects.get(sha256).length })),
    });
    f.s.patch('projectObjects', physicalObjectRow(f.s, existing.sha256)._id, { statePhysical: prior.pin });
  });
  assert.deepEqual(selected, existing);
  assert(f.requests.slice(before).every(request => !request.digests.includes(selected.sha256)));
  assert.equal(physicalObjectRow(f.s, selected.sha256).statePhysical, undefined);
});
for (const differentBuckets of [false, true])
  test(`compose keeps a fully live ${differentBuckets ? 'two-save disjoint' : 'one-save'} root without metadata PUTs`, async t => {
    const f = await setup(t),
      a = f.s.file('a.txt', 'new a');
    const first = await f.save([...f.files, a], f.main, f.files);
    let last = first;
    if (differentBuckets) {
      let b;
      for (let i = 0; !b || physicalBucket(b.blob) === physicalBucket(a.blob); i++)
        b = f.s.file('b.txt', `new b ${i}`);
      last = await f.save([...f.files, a, b], first.state, [...f.files, a]);
    }
    const puts = f.c.r2Puts.length;
    const result = await compose(f, last.state, f.main);
    assert.equal(result.sha256, last.state.sha256);
    assert.deepEqual(physicalObjectRow(f.s, result.sha256).statePhysical, last.root.pin);
    const metadata = f.c.r2Puts.slice(puts).filter(id => f.s.objects.get(id)[0] === 70);
    assert.deepEqual(metadata, [], 'kept roots publish no FPR/FPM metadata');
  });
test('repair rebinds the adopted State once, and repeating compose changes no metadata', async t => {
  const f = await setup(t),
    extras = Array.from({ length: 8 }, (_, i) => f.s.file(`extra-${i}.txt`, `extra ${i}`));
  const first = await f.save([...f.files, ...extras], f.main, f.files),
    finalFiles = [...f.files, ...extras.slice(1)],
    last = await f.save(finalFiles, first.state, [...f.files, ...extras]);
  const selected = await compose(f, last.state, f.main),
    repaired = physicalObjectRow(f.s, selected.sha256).statePhysical;
  assert.notEqual(repaired.sha256, last.root.pin.sha256);
  const puts = f.c.r2Puts.length;
  await compose(f, last.state, f.main);
  assert.deepEqual(physicalObjectRow(f.s, selected.sha256).statePhysical, repaired);
  assert.deepEqual(
    f.c.r2Puts.slice(puts).filter(id => f.s.objects.get(id)[0] === 70),
    [],
  );
  assert.deepEqual(
    await (await PhysicalManifestReader.open(selected.sha256, repaired, f.read)).lookup([extras[0].blob]),
    [null],
  );
});
test('compose after main moved derives a new root without any Lane-written pack', async t => {
  const f = await setup(t),
    extras = Array.from({ length: 8 }, (_, i) => f.s.file(`lane-${i}.txt`, `Lane ${i}`)),
    mainFile = f.s.file('main.txt', 'accepted main');
  const intermediate = await f.save([...f.files, ...extras], f.main, f.files),
    lane = await f.save([...f.files, ...extras.slice(1)], intermediate.state, [...f.files, ...extras]),
    nextMain = await f.save([...f.files, mainFile], f.main, f.files);
  f.s.main.head = nextMain.state.sha256;
  f.s.moveMain(nextMain.state.sha256, 'main-1');
  const selected = await compose(f, lane.state, nextMain.state),
    root = await PhysicalManifestReader.open(
      selected.sha256,
      physicalObjectRow(f.s, selected.sha256).statePhysical,
      f.read,
    );
  const mainKeys = new Set(
      nextMain.root.root.chunks.map(pin => physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce)),
    ),
    laneKeys = new Set(
      [...intermediate.root.root.chunks, ...lane.root.root.chunks]
        .map(pin => physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce))
        .filter(key => !mainKeys.has(key)),
    );
  for (const pin of root.root.chunks)
    assert(!laneKeys.has(physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce)));
});
test('ordinary save and sync outputs refuse root replacement; the trusted compose flag rebinds atomically', async t => {
  const f = await setup(t),
    { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts')),
    { r2Key } = await import(moduleUrl('../convex/r2.ts'));
  const replacement = f.s.put(Buffer.from('another verified root')),
    original = physicalObjectRow(f.s, f.main.sha256).statePhysical,
    output = { ...f.main, r2Key: r2Key(f.s.projectId, f.main.sha256), statePhysical: replacement };
  const store = pin =>
    f.s.run('bind physical State', ctx => storeSourceOutputs(ctx, f.s.projectId, 'synthetic', [pin]));
  await assert.rejects(store(output), /Immutable State physical manifest changed/);
  assert.deepEqual(physicalObjectRow(f.s, f.main.sha256).statePhysical, original);
  await store({ ...output, statePhysicalRebind: true });
  assert.deepEqual(physicalObjectRow(f.s, f.main.sha256).statePhysical, replacement);
  await assert.rejects(
    store({ ...output, statePhysical: original }),
    /Immutable State physical manifest changed/,
  );
});
test('a competing compose repair falls back to the catalog and its retry cannot restore the old root', async t => {
  const f = await setup(t),
    { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts')),
    { r2Key } = await import(moduleUrl('../convex/r2.ts')),
    original = physicalObjectRow(f.s, f.main.sha256).statePhysical,
    next = f.s.put(Buffer.from('rootless-main repair')),
    stale = f.s.put(Buffer.from('older rooted-main repair'));
  const store = statePhysical =>
    f.s.run('compose root replacement', ctx =>
      storeSourceOutputs(ctx, f.s.projectId, 'synthetic', [
        {
          ...f.main,
          r2Key: r2Key(f.s.projectId, f.main.sha256),
          statePhysical,
          statePhysicalRebind: true,
          statePhysicalPrevious: original,
        },
      ]),
    );
  await store(next);
  await store(next);
  assert.deepEqual(physicalObjectRow(f.s, f.main.sha256).statePhysical, next);
  await store(stale);
  await store(stale);
  assert.equal(physicalObjectRow(f.s, f.main.sha256).statePhysical, undefined);
  assert(f.s.objects.has(f.main.sha256));
});
test('compose treats a hash-invalid root read as absent and rebuilds from verified main', async t => {
  const f = await setup(t),
    extra = f.s.file('new.txt', 'new file'),
    saved = await f.save([...f.files, extra], f.main, f.files);
  const fetch = globalThis.fetch;
  let corrupted = false;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (
      !corrupted &&
      init.method !== 'HEAD' &&
      init.method !== 'PUT' &&
      new URL(url).pathname.endsWith(saved.root.pin.sha256)
    ) {
      corrupted = true;
      return new Response(Buffer.alloc(saved.root.pin.size, 0));
    }
    return fetch(url, init);
  });
  const selected = await compose(f, saved.state, f.main),
    pin = physicalObjectRow(f.s, selected.sha256).statePhysical,
    reader = await PhysicalManifestReader.open(selected.sha256, pin, f.read);
  assert.deepEqual(
    (await reader.lookup([extra.blob])).map(entry => entry.sha256),
    [extra.blob],
  );
});
test('compose propagates a non-hash root read failure and publishes no replacement', async t => {
  const f = await setup(t),
    { sourcePhysicalManifests } = await import(moduleUrl('../convex/projectConvexPhysicalManifest.ts')),
    extra = f.s.file('new.txt', 'new file'),
    saved = await f.save([...f.files, extra], f.main, f.files),
    outputs = [],
    location = pin => ({
      descriptor: { object: pin, recipe: null },
      storageId: null,
      url: null,
      statePhysical: physicalObjectRow(f.s, pin.sha256).statePhysical,
    }),
    failure = new Error('synthetic storage outage'),
    manifests = sourcePhysicalManifests({
      enabled: true,
      sourceKind: 'compose',
      projectId: f.s.projectId,
      locations: new Map([f.main, saved.state].map(pin => [pin.sha256, location(pin)])),
      outputs,
      key: id => `v1/p/${f.s.projectId}/o/${id}`,
      reader: async () => {
        throw failure;
      },
      members: () => undefined,
      describe: async () => {
        assert.fail('no catalog scan on storage failure');
      },
      put: async () => {
        assert.fail('no metadata PUT on storage failure');
      },
      log: () => {},
    });
  await assert.rejects(
    manifests.composePhysicalState(saved.state, [...f.files, extra], f.main.sha256),
    error => error === failure,
  );
  assert.deepEqual(outputs, []);
});
test('a batch terminal quantum repairs its adopted final State after the action-local transport was replaced', async t => {
  const f = await setup(t),
    extras = Array.from({ length: 8 }, (_, i) => f.s.file(`batch-${i}.txt`, `batch ${i}`)),
    intermediate = await f.save([...f.files, ...extras], f.main, f.files),
    final = await f.save([...f.files, ...extras.slice(1)], intermediate.state, [...f.files, ...extras]);
  const { randomUUID } = await import('node:crypto'),
    { buildComposePages } = await import('../dist/hosted-compose.js'),
    { initialSourceStep, runSourceStep } = await import('../dist/hosted-source-step.js'),
    { saveBytes } = await import('../dist/hosted-save.js'),
    { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts')),
    { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  const members = [intermediate.state, final.state].map(state => ({
      candidateId: randomUUID(),
      head: state.sha256,
      state: { object: state, recipe: null },
    })),
    inputs = buildComposePages([]),
    dependencies = buildComposePages(members);
  for (const page of [...inputs.pages, ...dependencies.pages]) f.s.put(saveBytes(page.value));
  const input = f.s.put(
    saveBytes({
      schema: 1,
      kind: 'forge-hosted-compose-input',
      batch: { members: members.map(value => value.candidateId) },
      main: { object: f.main, recipe: null },
      base: { head: f.main.sha256, receiptId: 'main-1' },
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      algorithm: 'forge-native-compose-v1',
      message: 'batch compose',
      at: '2026-01-01T00:00:00.000Z',
    }),
  );
  let cursor = initialSourceStep(input),
    steps = 0;
  while (cursor.phase !== 'done') {
    assert(++steps < 20);
    const locations = [...f.s.tables.projectObjects.values()].map(row => ({
      descriptor: { object: { sha256: row.digest, size: row.size }, recipe: null },
      storageId: null,
      url: `https://store.invalid/synthetic/v1/p/${f.s.projectId}/o/${row.digest}`,
      ...(row.statePhysical ? { statePhysical: row.statePhysical } : {}),
      ...(row.stateGeneration ? { stateGeneration: row.stateGeneration } : {}),
    }));
    const transport = convexSourceTransport(
      f.c.context,
      { projectId: f.s.projectId, jobId: 'synthetic batch', step: steps },
      locations,
      undefined,
      { physicalManifests: true, sourceKind: 'compose' },
    );
    cursor = (await runSourceStep(cursor, transport.io)).cursor;
    await transport.settle();
    await f.s.run('batch quantum commit', ctx =>
      storeSourceOutputs(ctx, f.s.projectId, 'synthetic', transport.outputs),
    );
    cursor = JSON.parse(JSON.stringify(cursor));
  }
  assert.equal(cursor.head, final.state.sha256);
  const pin = physicalObjectRow(f.s, final.state.sha256).statePhysical,
    reader = await PhysicalManifestReader.open(final.state.sha256, pin, f.read),
    removedChunk = intermediate.root.root.chunks.find(
      chunk => chunk.bucket === physicalBucket(extras[0].blob),
    );
  assert.notEqual(pin.sha256, final.root.pin.sha256);
  assert(!reader.root.chunks.some(chunk => chunk.pack?.digest === removedChunk.pack.digest));
  assert.deepEqual(await reader.lookup([extras[0].blob]), [null]);
});

async function resumeColdBatch(f, saved, { warmMain = false } = {}) {
  const { buildComposePages } = await import('../dist/hosted-compose.js'),
    { computeMergeStep } = await import('../dist/hosted-source-step-merge.js'),
    { initialSourceStep } = await import('../dist/hosted-source-step.js'),
    { saveBytes } = await import('../dist/hosted-save.js'),
    { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts')),
    { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  // A plan with a recipe can load main's bytes without consulting main's State row.
  const makeRecipe = object => {
    const body = f.s.objects.get(object.sha256),
      children = [body.subarray(0, 4096), body.subarray(4096)].map(bytes => ({
        ...f.s.put(bytes),
        height: 0,
        length: bytes.length,
      })),
      tree = f.s.put(saveBytes({ schema: 1, kind: 'forge-byte-tree', children })),
      recipe = f.s.put(
        saveBytes({
          schema: 1,
          kind: 'forge-object-recipe',
          object,
          tree: { ...tree, height: 1, length: body.length },
        }),
      );
    f.s.patch('projectObjects', physicalObjectRow(f.s, object.sha256)._id, {
      recipe: { digest: recipe.sha256, size: recipe.size },
    });
    return { object, recipe };
  };
  const mainRef = makeRecipe(f.main),
    headRef = warmMain ? makeRecipe(saved.state) : { object: saved.state, recipe: null },
    members = ['b87e3a8d-b15c-4cbc-96f6-47f21676671a', '7d1efbeb-218c-4539-a855-c98e9cdc44e1'],
    selections = members.map(candidateId => ({ candidateId, head: saved.state.sha256, state: headRef })),
    plan = {
      schema: 1,
      kind: 'forge-hosted-compose-input',
      batch: { members },
      main: mainRef,
      base: { head: f.main.sha256, receiptId: 'main-1' },
      inputs: buildComposePages([]).manifest,
      dependencies: buildComposePages(selections).manifest,
      algorithm: 'forge-native-compose-v1',
      message: 'batch compose',
      at: '2026-01-01T00:00:00.000Z',
    },
    cursor = {
      ...initialSourceStep(f.s.put(saveBytes(plan))),
      plan,
      selections,
      phase: 'compute',
      index: selections.length,
      batchMerged: members,
      head: saved.state.sha256,
      inventory: { [saved.state.sha256]: headRef, [f.main.sha256]: plan.main },
    },
    transport = convexSourceTransport(
      f.c.context,
      { ...f.sourceJob, step: 0 },
      warmMain
        ? [
            {
              descriptor: mainRef,
              storageId: null,
              url: null,
              statePhysical: physicalObjectRow(f.s, f.main.sha256).statePhysical,
            },
          ]
        : [],
      undefined,
      { physicalManifests: true, sourceKind: 'compose' },
    );
  const puts = f.c.r2Puts.length,
    gets = f.c.r2Gets.length,
    putBytes = f.c.r2PutBytes(),
    calls = f.c.calls.length;
  await computeMergeStep(cursor, transport.io);
  await transport.settle();
  await f.s.run('terminal batch publication', ctx =>
    storeSourceOutputs(ctx, f.s.projectId, 'synthetic', transport.outputs),
  );
  assert.equal(cursor.phase, 'done');
  assert.deepEqual(JSON.parse(f.s.objects.get(cursor.output.sha256)).result.state, saved.state);
  return {
    metadata: f.c.r2Puts.slice(puts).filter(id => f.s.objects.get(id)[0] === 70),
    gotMainBody: f.c.r2Gets.slice(gets).includes(mainRef.recipe.sha256),
    putBytes: f.c.r2PutBytes() - putBytes,
    calls: f.c.calls.slice(calls),
  };
}

test('incident 8b7ab7a9: clean batch resume keeps its rooted main lineage without a full metadata repack', async t => {
  const f = await setup(t),
    extra = f.s.file('extra.txt', 'new file'),
    saved = await f.save([...f.files.slice(1), extra], f.main, f.files),
    result = await resumeColdBatch(f, saved);
  assert.deepEqual(physicalObjectRow(f.s, saved.state.sha256).statePhysical, saved.root.pin);
  assert.deepEqual(result.metadata, [], 'accepted partial packs are not copied');
  assert.equal(result.gotMainBody, false, 'root verification needs no recipe reads');
  assert(result.putBytes < 1024, 'the terminal quantum writes only its small result');
  assert.deepEqual(result.calls, ['projectConvexSourceObjects:resolve'], 'one page instead of a seed check');
});

test('cold batch resume reads exact main membership before adding an absent final root', async t => {
  const f = await setup(t),
    extra = f.s.file('extra.txt', 'new file'),
    saved = await f.save([...f.files, extra], f.main, f.files);
  f.s.patch('projectObjects', physicalObjectRow(f.s, saved.state.sha256)._id, { statePhysical: undefined });
  const result = await resumeColdBatch(f, saved);
  assert.equal(result.gotMainBody, true, 'bounded incremental writes verify exact main membership');
  assert.deepEqual(physicalObjectRow(f.s, saved.state.sha256).statePhysical, saved.root.pin);
});

test('cold batch with a warm main still repairs a recipe-backed final State from its actual row', async t => {
  const f = await setup(t),
    extras = Array.from({ length: 8 }, (_, i) => f.s.file(`cold-${i}.txt`, `cold member ${i}`)),
    prior = await f.save([...f.files, ...extras], f.main, f.files),
    saved = await f.save([...f.files, ...extras.slice(1)], prior.state, [...f.files, ...extras]);
  await resumeColdBatch(f, saved, { warmMain: true });
  const stored = physicalObjectRow(f.s, saved.state.sha256).statePhysical,
    opened = await PhysicalManifestReader.open(saved.state.sha256, stored, f.read);
  assert.notEqual(stored.sha256, saved.root.pin.sha256);
  assert.deepEqual(await opened.lookup([extras[0].blob]), [null]);
});

test('cold batch with a truly rootless main still repairs adopted packs without requeuing the seed', async t => {
  const f = await setup(t),
    extra = f.s.file('rootless.txt', 'new file'),
    saved = await f.save([...f.files.slice(1), extra], f.main, f.files);
  f.s.patch('projectObjects', physicalObjectRow(f.s, f.main.sha256)._id, { statePhysical: undefined });
  const result = await resumeColdBatch(f, saved);
  assert(result.metadata.length > 0, 'without main lineage the partial pack must be repacked');
  assert.equal(result.gotMainBody, false);
  assert.deepEqual(result.calls, ['projectConvexSourceObjects:resolve']);
});

for (const packed of [false, true])
  for (const repair of [false, true])
    test(`compose ${repair ? 'repairs' : 'adds'} a root on an adopted ${packed ? 'packed' : 'raw'} nonce State without rebinding its bytes`, async t => {
      const f = await setup(t),
        extras = Array.from({ length: 8 }, (_, i) => f.s.file(`nonce-${i}.txt`, `nonce member ${i}`));
      const first = await f.save([...f.files, ...extras], f.main, f.files),
        files = [...f.files, ...extras.slice(1)],
        saved = await f.save(files, first.state, [...f.files, ...extras]),
        row = physicalObjectRow(f.s, saved.state.sha256),
        nonce = '11111111-1111-4111-8111-111111111111',
        carrier = packed
          ? f.s.put(
              Buffer.concat([
                Buffer.from('prefix'),
                f.s.objects.get(saved.state.sha256),
                Buffer.from('suffix'),
              ]),
            )
          : saved.state,
        key = `v1/p/${f.s.projectId}/o/${carrier.sha256}/u/${nonce}`;
      f.s.patch('projectObjects', row._id, {
        r2Key: key,
        ...(packed ? { pack: { digest: carrier.sha256, size: carrier.size, offset: 6 } } : {}),
        ...(!repair ? { statePhysical: undefined } : {}),
      });
      if (packed) f.s.patch('projectObjects', physicalObjectRow(f.s, carrier.sha256)._id, { r2Key: key });
      const fetch = globalThis.fetch;
      let reads = 0;
      t.mock.method(globalThis, 'fetch', (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path.includes('/o/' + carrier.sha256) && init.method !== 'PUT') {
          assert(path.endsWith('/' + key), 'only the adopted exact key is readable');
          reads++;
        }
        return fetch(url, init);
      });
      const before = f.c.calls.length,
        oldRoot = row.statePhysical,
        selected = await compose(f, saved.state, f.main),
        stored = physicalObjectRow(f.s, selected.sha256);
      assert.equal(stored.r2Key, key, 'publication preserves the exact hash-verified nonce key');
      assert(reads > 0, 'the real compose verified bytes through the adopted nonce key');
      t.diagnostic(
        JSON.stringify({
          packed,
          repair,
          descriptorCalls: f.c.calls
            .slice(before)
            .filter(name => name === 'projectConvexSourceObjects:resolve').length,
        }),
      );
      assert.notEqual(stored.statePhysical.sha256, oldRoot?.sha256);
      assert.equal(stored.sourceReferenced, true);
      assert.equal(physicalObjectRow(f.s, carrier.sha256).sourceReferenced, true, 'whole carrier stays live');
      const reader = await PhysicalManifestReader.open(selected.sha256, stored.statePhysical, f.read);
      assert.deepEqual(await reader.lookup([extras[0].blob]), [null]);
      assert.deepEqual(
        (await reader.lookup([extras[1].blob])).map(pin => pin.sha256),
        [extras[1].blob],
      );
    });

test('trusted source publication refuses wrong-project keys, wrong digests and a different nonce copy of a committed pack', async t => {
  const f = await setup(t),
    { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts')),
    pin = f.s.put(Buffer.from('publication member')),
    carrier = f.s.put(Buffer.concat([f.s.objects.get(pin.sha256), Buffer.from('neighbour')])),
    prefix = `v1/p/${f.s.projectId}/o/`,
    nonce = '11111111-1111-4111-8111-111111111111',
    key = prefix + carrier.sha256 + '/u/' + nonce;
  f.s.patch('projectObjects', physicalObjectRow(f.s, carrier.sha256)._id, { r2Key: key });
  for (const r2Key of [
    `v1/p/other/o/${pin.sha256}`,
    prefix + carrier.sha256,
    prefix + pin.sha256 + '/u/bad',
    key.replace(nonce, '22222222-2222-4222-8222-222222222222'),
  ])
    await assert.rejects(
      f.s.run('refuse publication binding', ctx =>
        storeSourceOutputs(ctx, f.s.projectId, 'synthetic', [
          {
            ...pin,
            r2Key,
            pack: { digest: carrier.sha256, size: carrier.size, offset: 0 },
          },
        ]),
      ),
      error => (error.code ?? error.data?.code) === 'SOURCE_HASH_MISMATCH',
    );
  assert.equal(physicalObjectRow(f.s, carrier.sha256).sourceReferenced, undefined);
});

for (const failure of [false, true])
  test(`State body publication ${failure ? 'failure settles independent manifest I/O without exposing bindings' : 'overlaps its derived manifest read and settles both before exposing bindings'}`, async t => {
    const f = await setup(t),
      { digest } = await import('../dist/hash.js'),
      { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
    const bytes = Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [f.main.sha256],
          files: f.files,
          message: 'overlap',
          at: '2026-01-01T00:00:00.000Z',
        }),
      ),
      pin = { sha256: digest(bytes), size: bytes.length };
    const locations = [...f.s.tables.projectObjects.values()].map(row => ({
      descriptor: { object: { sha256: row.digest, size: row.size }, recipe: null },
      storageId: null,
      url: `https://store.invalid/synthetic/v1/p/${f.s.projectId}/o/${row.digest}`,
      ...(row.statePhysical ? { statePhysical: row.statePhysical } : {}),
      ...(row.stateGeneration ? { stateGeneration: row.stateGeneration } : {}),
    }));
    const transport = convexSourceTransport(
      f.c.context,
      { projectId: f.s.projectId, jobId: 'overlap', step: 0 },
      locations,
      undefined,
      { overlapWrites: true, physicalManifests: true, sourceKind: 'save' },
    );
    transport.io.rememberLoadedState(f.main, f.files.length, f.files);
    transport.io.rememberOutputState(pin, [f.main.sha256], f.files);
    const original = globalThis.fetch,
      started = Promise.withResolvers(),
      release = Promise.withResolvers();
    let bodyStarted = false;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).includes('/o/' + pin.sha256) && init.method === 'PUT') {
        bodyStarted = true;
        release.resolve();
        if (failure) throw Error('synthetic State PUT failure');
      }
      if (
        String(url).includes('/o/' + physicalObjectRow(f.s, f.main.sha256).statePhysical.sha256) &&
        !init.method
      ) {
        started.resolve();
        await release.promise;
      }
      return original(url, init);
    };
    try {
      await transport.io.upload(
        pin,
        (async function* () {
          yield bytes;
        })(),
      );
      await started.promise;
      assert.equal(transport.outputs.length, 0, 'no incomplete representation escapes');
      // The root GET can finish only after the independent State PUT starts. A serial
      // implementation cannot settle; no wall-clock sleep or latency assertion is needed.
      if (failure) await assert.rejects(transport.settle(), { name: 'SourceIoError' });
      else await transport.settle();
      assert(bodyStarted, 'State body PUT starts while the independent physical root GET is blocked');
    } finally {
      release.resolve();
      await transport.settle();
      globalThis.fetch = original;
    }
    assert.equal(transport.outputs.length, failure ? 0 : 1);
    if (!failure) {
      assert(transport.outputs[0].statePhysical);
      assert.equal(transport.outputs[0].sha256, pin.sha256);
    }
  });
