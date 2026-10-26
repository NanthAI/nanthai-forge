import { childWorker, until } from './landing-worker-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  appendFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { landingRuntime, landingRuntimeSchema, changedLandingRuntime } from '../dist/landing-environment.js';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch } from '../dist/landing-batch-store.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { ForgeError } from '../dist/errors.js';

for (const field of ['platform', 'arch', 'os'])
  test(`a retained unstarted batch refuses changed ${field} even at the same executable path`, async t => {
    const f = await fixture(t, { remote: false });
    await f.candidate('host-runtime.txt');
    await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
    await batchEdit(f.work, 'old-host', data => {
      data.landingEntries[0].environmentSnapshot[field] = 'synthetic-prior-runtime';
      data.landingBatches[0].environment[field] = 'synthetic-prior-runtime';
    });
    await drainLandingBatches(f.work, 'main');
    const data = f.store.load();
    assert.equal(data.landingBatches[0].status, 'superseded');
    assert.equal(data.landingEntries[0].status, 'interrupted');
    assert.match(data.landingEntries[0].reason, new RegExp(field));
    assert.doesNotMatch(data.landingEntries[0].reason, /synthetic-prior-runtime/);
    assert.equal(data.runs.length, 0);
    assert.equal(data.channelMoves.length, 0);
  });

test('an accepted receipt reconciles after an in-place Node upgrade and lost reply', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('accepted-runtime.txt');
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = async (...args) => {
    const response = await dispatch(...args);
    if (args[0].action === 'accept-channel') throw new ForgeError('SYNTHETIC_EXIT', 'Lost acceptance reply');
    return response;
  };
  await assert.rejects(drainLandingBatches(f.work, 'main'), { code: 'SYNTHETIC_EXIT' });
  await drainPostAccept(f.store);
  const receipt = f.store.load().channelMoves[0];
  await batchEdit(f.work, 'old-node', data => {
    data.landingEntries[0].environmentSnapshot.node = 'synthetic-prior-node';
    data.landingBatches[0].environment.node = 'synthetic-prior-node';
  });
  const replacement = new AgentWorkflow(f.root).work;
  const replay = replacement.dispatch.bind(replacement);
  replacement.dispatch = (...args) => {
    assert.notEqual(args[0].action, 'run-check');
    return replay(...args);
  };
  await drainLandingBatches(replacement, 'main');
  const data = f.store.load();
  assert.equal(data.landingEntries[0].status, 'accepted');
  assert.equal(data.landingEntries[0].acceptanceId, receipt.id);
  assert.equal(data.channelMoves.length, 1);
  assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
});

test('Node binary identity pins the executable bytes as well as its location and version', () => {
  assert.equal(
    landingRuntime().nodeBinary,
    createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  );
});

for (const selected of [false, true])
  test(`changed Node bytes re-admit a ${selected ? 'selected' : 'queued'} landing with fresh evidence`, async t => {
    const f = await fixture(t, { remote: false });
    await f.candidate('same-version.txt');
    if (selected) await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
    await batchEdit(f.work, 'prior-binary', data => {
      data.landingEntries[0].runtimeSnapshot.nodeBinary = 'f'.repeat(64);
    });
    await drainLandingBatches(f.work, 'main');
    const data = f.store.load();
    assert.equal(data.landingEntries[0].status, 'accepted');
    assert.deepEqual(data.landingEntries[0].runtimeRepins[0].fields, ['nodeBinary']);
    assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
    assert.equal(data.channelMoves.length, 1);
  });

test('runtime snapshots predating the binary digest retain their available identity checks', () => {
  const legacy = { ...landingRuntime() };
  delete legacy.nodeBinary;
  assert.deepEqual(changedLandingRuntime(landingRuntimeSchema.parse(legacy)), []);
  assert.deepEqual(changedLandingRuntime({ ...legacy, cli: 'prior-build' }), ['cli']);
});

test('CLI identity pins packaged runtime helpers as well as compiled modules', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-helper-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  cpSync(fileURLToPath(new URL('../dist', import.meta.url)), dist, { recursive: true });
  copyFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(root, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const file of manifest.files.filter(
    file => file.startsWith('scripts/') && /\.(?:mjs|py)$/.test(file),
  )) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), join(root, file));
  }
  const script = `import { landingRuntime } from ${JSON.stringify(pathToFileURL(join(dist, 'landing-environment.js')).href)};console.log(JSON.stringify(landingRuntime()));`;
  const read = () =>
    JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
  assert.deepEqual(changedLandingRuntime(landingRuntime(), read()), []);
  appendFileSync(join(root, 'scripts', 'test-coverage.mjs'), '\n// synthetic installed helper change\n');
  assert.deepEqual(changedLandingRuntime(landingRuntime(), read()), ['cli']);
});

test('Node-only version upgrades keep entry identities, order and immutable source pins', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('first.txt');
  await f.candidate('second.txt');
  await f.checkCandidates();
  const original = f.store.load().landingEntries;
  await batchEdit(f.work, 'old-node', data => {
    for (const entry of data.landingEntries) {
      entry.environmentSnapshot.node = 'synthetic-old-node';
      entry.environment = 'f'.repeat(64);
    }
  });
  await drainLandingBatches(f.work, 'main');
  const data = f.store.load();
  assert.deepEqual(
    data.landingEntries.map(e => [e.id, e.head, e.arrivedAt]),
    original.map(e => [e.id, e.head, e.arrivedAt]),
  );
  assert.ok(data.landingEntries.every(e => e.status === 'accepted'));
  assert.deepEqual(
    data.landingBatches[0].entryIds,
    original.map(e => e.id),
  );
  assert.ok(data.landingEntries.every(e => e.runtimeRepins[0].fields.includes('node')));
  assert.ok(data.runs.filter(r => !r.mainCheck).every(r => r.environment.node === process.version));
});

for (const changed of ['candidate head', 'check definition'])
  test(`a Node upgrade does not re-admit changed ${changed}`, async t => {
    const f = await fixture(t, { remote: false });
    await f.candidate('pins.txt');
    await batchEdit(f.work, 'changed-pins', data => {
      const entry = data.landingEntries[0];
      entry.environmentSnapshot.node = 'synthetic-old-node';
      if (changed === 'candidate head') entry.head = 'f'.repeat(64);
      else entry.definition = 'f'.repeat(64);
    });
    await drainLandingBatches(f.work, 'main');
    const data = f.store.load();
    assert.equal(data.landingEntries[0].status, 'interrupted');
    assert.match(data.landingEntries[0].reason, new RegExp(changed));
    assert.equal(data.landingEntries[0].runtimeRepins, undefined);
    assert.equal(data.runs.length, 0);
  });

test('worker startup re-admits Node-only queued entries without manual resubmission', async t => {
  const f = await fixture(t, { remote: false });
  const input = await f.candidate('restart.txt');
  await batchEdit(f.work, 'prior-worker-node', data => {
    data.landingEntries[0].environmentSnapshot.node = 'synthetic-prior-node';
  });
  const worker = await childWorker(f);
  try {
    await until(
      f,
      () => f.store.load().landingEntries[0]?.status === 'accepted',
      're-pinned queued entry lands',
    );
    const entry = f.store.load().landingEntries[0];
    assert.equal(entry.id, input.command.operationId);
    assert.equal(entry.status, 'accepted');
    assert.deepEqual(entry.runtimeRepins[0].fields, ['node']);
    assert.equal(f.store.load().landingEntries.length, 1);
  } finally {
    await worker.stop();
  }
});
