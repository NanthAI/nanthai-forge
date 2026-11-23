// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { serialize, deserialize } from 'node:v8';
import { childEnv } from '../scripts/child-env.mjs';
import { FileKeyStore, secretLocked } from '../dist/sealed-local.js';
import { SecretPins } from '../dist/sealed-pins.js';
import { fixture } from './helpers/sealed-fixture.mjs';
import { forgeSecretId } from '../dist/sealed-format.js';
const clone = x => deserialize(serialize(x));
function setup(t, project = 'fixture-project') {
  const directory = mkdtempSync(join(tmpdir(), 'forge-sealed-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(17, project),
    store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...f.keys, pinCounter: 0 });
  return { directory, f, store, pins: new SecretPins(directory, store) };
}
const pinPath = (d, p) => join(d, forgeSecretId('project', p).toString('hex') + '.bin');
const localBytes = d =>
  Object.fromEntries(
    readdirSync(d)
      .filter(n => !n.endsWith('.lock'))
      .map(n => [n, readFileSync(join(d, n))]),
  );
const clear = r => {
  r.key?.fill(0);
  for (const s of r.secrets) s.value.fill(0);
};

test('T22 deleted index with a raised key-store counter never restores first-contact trust', async t => {
  const { directory, f, pins } = setup(t);
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  unlinkSync(join(directory, 'index.bin'));
  for (const project of ['fixture-project', 'different-project'])
    await assert.rejects(pins.load(project, 1), { code: 'SECRETS_PIN_LOST' });
});
test('T60 independent project/kind pins preserve first contact and localize a missing project file', async t => {
  const { directory, f, pins } = setup(t);
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  assert.equal(await pins.load('another-project', 1), null);
  const g = fixture(17, 'another-project');
  clear(await pins.verifyAndSave(g.reply, g.request, 1));
  unlinkSync(pinPath(directory, 'fixture-project'));
  await assert.rejects(pins.load('fixture-project', 1), { code: 'SECRETS_PIN_LOST' });
  assert(await pins.load('another-project', 1));
});
test('T86 older MAC-valid index and file restoration are refused', async t => {
  for (const target of ['index.bin', 'file']) {
    const { directory, f, pins } = setup(t);
    f.name();
    clear(await pins.verifyAndSave(f.reply, f.request, 1));
    const path = target === 'file' ? pinPath(directory, 'fixture-project') : join(directory, target),
      old = readFileSync(path);
    f.bump();
    f.name();
    clear(await pins.verifyAndSave(f.reply, f.request, 2));
    writeFileSync(path, old);
    await assert.rejects(pins.load('fixture-project', 1), { code: 'SECRETS_PIN_LOST' });
  }
});
test('T86 interrupted index/counter and file/index publications load and repair without lost trust', async t => {
  const { directory, f, store, pins } = setup(t);
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  const oldKey = readFileSync(store.path),
    oldIndex = readFileSync(pins.indexPath);
  f.bump();
  f.name();
  clear(await pins.verifyAndSave(f.reply, f.request, 2));
  writeFileSync(store.path, oldKey);
  assert(await pins.load('fixture-project', 1));
  // Restoring the preceding index creates the other permitted +1 crash state.
  writeFileSync(pins.indexPath, oldIndex);
  assert(await pins.load('fixture-project', 1));
  f.bump();
  f.name();
  clear(await pins.verifyAndSave(f.reply, f.request, 3));
  assert.equal(store.load().pinCounter, deserialize(readFileSync(pins.indexPath)).counter);
});
test('T86 unchanged verification writes no pin/index/key-store bytes and stale fetches reverify under lock', async t => {
  const { directory, f, pins } = setup(t);
  f.name();
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  const old = clone(f.reply),
    before = localBytes(directory);
  clear(await pins.verifyAndSave(f.reply, f.request, 2));
  assert.deepEqual(localBytes(directory), before);
  f.bump();
  f.name();
  clear(await pins.verifyAndSave(f.reply, f.request, 3));
  const newer = localBytes(directory);
  await assert.rejects(pins.verifyAndSave(old, f.request, 4), { code: 'SECRETS_ROLLBACK' });
  assert.deepEqual(localBytes(directory), newer);
});
test('T86 four real processes update independent project pins repeatedly with one consistent counter', async t => {
  const { directory, pins, store } = setup(t);
  const children = Array.from({ length: 4 }, (_, i) =>
    spawn(process.execPath, ['tests/fixtures/sealed-pin-worker.mjs', 'write', directory, `project-${i}`], {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const results = await Promise.all(
    children.map(async child => {
      let err = '';
      child.stderr.on('data', d => {
        err += d;
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, err);
    }),
  );
  assert.equal(results.length, 4);
  assert.equal(store.load().pinCounter, 48);
  for (let i = 0; i < 4; i++) assert.equal((await pins.load(`project-${i}`, 1)).pin.head.headVersion, 12);
});
test('T86 dead lock holder is recoverable while a live holder is preserved', async t => {
  const { directory } = setup(t),
    child = spawn(process.execPath, ['tests/fixtures/sealed-pin-worker.mjs', 'hold', directory], {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  await assert.rejects(
    secretLocked(join(directory, 'pins.lock'), () => true, 0),
    { code: 'SECRETS_PIN_BUSY' },
  );
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const path = join(directory, 'pins.lock'),
    stale = deserialize(readFileSync(path));
  // Model a second process dying after it published the reclaim gate.
  writeFileSync(`${path}.${stale.token}.reclaim`, serialize({ ...stale, token: randomUUID() }), {
    mode: 0o600,
  });
  assert.equal(await secretLocked(path, () => true), true);
});
test('T94 solo owner explicitly rebuilds only its own signed view; agents and rejected views leave files untouched', async t => {
  const { directory, f, pins } = setup(t);
  f.name();
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  unlinkSync(pinPath(directory, 'fixture-project'));
  unlinkSync(pins.indexPath);
  const before = localBytes(directory);
  await assert.rejects(
    pins.rebuild(f.reply, f.request, false, async () => true),
    { code: 'SECRETS_PIN_LOST' },
  );
  assert.deepEqual(localBytes(directory), before);
  await assert.rejects(
    pins.rebuild(f.reply, f.request, true, async () => false),
    { code: 'CANCELLED' },
  );
  assert.deepEqual(localBytes(directory), before);
  let summary = '';
  clear(
    await pins.rebuild(f.reply, f.request, true, async line => {
      summary = line;
      return true;
    }),
  );
  assert(summary.includes('may be older') && summary.includes('Devices:') && summary.includes('1970-'));
  // Gate B2 nit: devices are shown by short fingerprint, never by their full ids.
  assert(summary.includes('(fp '));
  assert.equal(summary.includes(f.keys.id.toString('hex')), false);
  assert(await pins.load('fixture-project', 1));
  unlinkSync(pinPath(directory, f.request.forgeProjectId));
  const bad = clone(f.reply);
  bad.head.signature.fill(0);
  await assert.rejects(
    pins.rebuild(bad, f.request, true, async () => true),
    { code: 'SECRETS_PIN_LOST' },
  );
});
test('T94 rebuilding one project cannot erase the lost trust of another project', async t => {
  const { directory, f, pins } = setup(t);
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  const other = fixture(17, 'another-project');
  clear(await pins.verifyAndSave(other.reply, other.request, 1));
  unlinkSync(pins.indexPath);
  clear(await pins.rebuild(f.reply, f.request, true, async () => true));
  assert(await pins.load('fixture-project', 1));
  await assert.rejects(pins.load('another-project', 1), { code: 'SECRETS_PIN_LOST' });
  assert.equal(await pins.load('never-pinned-project', 1), null);
});
