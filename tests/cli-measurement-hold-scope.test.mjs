// SPDX-License-Identifier: Apache-2.0
// A measurement hold that names the measured project lets that project's own landings run on the
// held build; every other project's landings still wait, and CLI updates stay refused (8c9b84fc:
// the exit bench smoke cell hung in `land --save` behind its own hold).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliBuildCommit, selectCliBuild } from '../dist/cli-installation.js';
import { cliStartup, cliVersionCheck } from '../dist/cli-version.js';
import { updateCli as updateCliChecked } from '../dist/cli-update.js';
import { measurementHoldProjects } from '../dist/cli-measurement-hold.js';
import { testReleaseSigner, withSignedReleases } from './release-trust-fixture.mjs';
import { benchHoldText } from '../scripts/bench-t3code/versions.mjs';
import { staleBenchFreeze } from '../scripts/bench-t3code/drive.mjs';

const a = 'a'.repeat(64),
  b = 'b'.repeat(64);
const source = { url: 'https://synthetic.convex.cloud', projectId: 'forge-source' };
const BENCH = 'bench-project',
  DOGFOOD = 'dogfood-project';

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-hold-scope-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = join(directory, 'client.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 0 }));
  const previous = process.env.FORGE_CLIENT_SETTINGS;
  process.env.FORGE_CLIENT_SETTINGS = settings;
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_CLIENT_SETTINGS;
    else process.env.FORGE_CLIENT_SETTINGS = previous;
  });
  const installation = join(directory, 'forge-cli');
  const old = join(installation, 'builds', a);
  mkdirSync(join(old, 'dist'), { recursive: true });
  writeFileSync(join(old, '.commit'), a);
  writeFileSync(join(old, '.managed-cli'), '1');
  writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@nanthai/forge', type: 'module' }));
  writeFileSync(join(old, 'dist', 'cli-version.js'), '// synthetic controller capability');
  copyFileSync(new URL('../dist/cli-launcher.js', import.meta.url), join(old, 'dist', 'cli-launcher.js'));
  writeFileSync(join(old, 'dist', 'cli-entry.js'), '// complete');
  writeFileSync(join(old, 'dist', 'agent-edit-hook.js'), '// complete');
  selectCliBuild(installation, old);
  const root = join(directory, 'work');
  mkdirSync(root);
  return { directory, installation, old, root, hold: join(installation, '.freeze') };
}

/** Synthetic signed release service whose main is `head`; counts its reads. */
async function release(t, f, head) {
  const calls = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('../scripts/package-cli-release-worker.mjs', import.meta.url), {
    workerData: { head, projectId: source.projectId, calls: calls.buffer, signer: testReleaseSigner() },
  });
  t.after(() => worker.terminate());
  const url = await new Promise((done, reject) => {
    worker.once('message', done);
    worker.once('error', reject);
  });
  writeFileSync(join(f.installation, 'source.json'), JSON.stringify({ url, projectId: source.projectId }));
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-cli-test-token';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
  return calls;
}

const land = (f, projectId) =>
  cliStartup(
    ['agent', f.root, 'land', '--save', JSON.stringify({ url: source.url, projectId, laneId: 'synthetic' })],
    f.old,
    cliVersionCheck(),
    { validated: true },
  );
/** 'waiting' while the landing is still held after a few event-loop turns. */
const settled = pending =>
  Promise.race([pending, new Promise(done => setTimeout(() => done('waiting'), 300))]);

test('the measured project lands under its own hold, on the held build even after main moves', async t => {
  const f = fixture(t),
    calls = await release(t, f, b);
  writeFileSync(f.hold, benchHoldText({ forge: { projectId: BENCH } }, 'bench cell n1-r1 pid 1'));
  assert.deepEqual(measurementHoldProjects(f.installation), [BENCH]);
  assert.equal(await settled(land(f, BENCH)), true);
  assert.equal(Atomics.load(calls, 0), 1, 'one release read, no install');
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a, 'the held build stays selected');
});

test("another project's landing waits under the scoped hold until the hold is gone", async t => {
  const f = fixture(t),
    calls = await release(t, f, a);
  writeFileSync(f.hold, `bench driver batch n3-r1 pid 1\nproject ${BENCH}\n`);
  const dogfood = land(f, DOGFOOD);
  assert.equal(await settled(dogfood), 'waiting');
  // A landing whose project cannot be read locally stays held too.
  const unknown = cliStartup(['agent', f.root, 'land', '--save', '{}'], f.old, cliVersionCheck(), {
    validated: true,
  });
  assert.equal(await settled(unknown), 'waiting');
  assert.equal(Atomics.load(calls, 0), 0, 'no release read while held');
  // The measured project still passes beside the waiting ones.
  assert.equal(await settled(land(f, BENCH)), true);
  rmSync(f.hold);
  assert.equal(await dogfood, true);
  assert.equal(await unknown, true);
});

test('CLI updates stay refused for everyone under a scoped hold', async t => {
  const f = fixture(t);
  await release(t, f, b);
  writeFileSync(f.hold, `bench cell n1-r1 pid 1\nproject ${BENCH}\n`);
  assert.equal(await settled(land(f, BENCH)), true);
  const read = { source: { current: async () => assert.fail('unexpected release read') } };
  await assert.rejects(
    updateCliChecked(f.installation, source, undefined, withSignedReleases(read, source.projectId)),
    { code: 'CLI_UPDATE_FROZEN' },
  );
  // Another project's write under the same hold still refuses to run on a stale build.
  await assert.rejects(
    cliStartup(
      ['agent', f.root, 'save', JSON.stringify({ url: source.url, projectId: DOGFOOD })],
      f.old,
      cliVersionCheck(),
      { validated: true },
    ),
    { code: 'CLI_UPDATE_FROZEN' },
  );
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
});

test('a hold without a scope holds every project, the measured one included', async t => {
  const f = fixture(t),
    calls = await release(t, f, a);
  writeFileSync(f.hold, `project ${BENCH}\n`);
  assert.equal(await settled(land(f, BENCH)), true);
  // The same holder drops the scope: now every landing waits again, as before scopes existed.
  writeFileSync(f.hold, `bench cell n1-r1 pid 1 ${BENCH}\n`);
  assert.deepEqual(measurementHoldProjects(f.installation), []);
  const measured = land(f, BENCH);
  assert.equal(await settled(measured), 'waiting');
  const reads = Atomics.load(calls, 0);
  rmSync(f.hold);
  assert.equal(await measured, true);
  assert.equal(Atomics.load(calls, 0), reads + 1);
});

test('re-scoping a hold releases a waiting landing for the newly named project', async t => {
  const f = fixture(t);
  await release(t, f, a);
  writeFileSync(f.hold, `bench cell n1-r1 pid 1\nproject ${BENCH}\n`);
  const dogfood = land(f, DOGFOOD);
  assert.equal(await settled(dogfood), 'waiting');
  writeFileSync(f.hold, `bench cell n1-r1 pid 1\nproject ${BENCH}\nproject ${DOGFOOD}\n`);
  assert.equal(await dogfood, true);
});

test('bench hold text names the bench project and keeps its owner pid for stale detection', () => {
  const text = benchHoldText({ forge: { projectId: BENCH } }, 'bench driver batch n3-r1 pid 999999999');
  assert.equal(text, `bench driver batch n3-r1 pid 999999999\nproject ${BENCH}\n`);
  assert.equal(staleBenchFreeze(text), true);
  assert.equal(
    staleBenchFreeze(benchHoldText({ forge: { projectId: BENCH } }, `bench cell x pid ${process.pid}`)),
    false,
  );
  assert.throws(() => benchHoldText({ forge: {} }, 'bench cell x pid 1'), /BENCH_HOLD_PROJECT/);
});
