// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { serialize, deserialize } from 'node:v8';
import { randomUUID } from 'node:crypto';
import { childEnv } from '../scripts/child-env.mjs';
import { ensureSecretDevice, FileKeyStore, secretLocked, wipeDeviceKeys } from '../dist/sealed-local.js';
import { SecretPins } from '../dist/sealed-pins.js';
import { forgeSecretId } from '../dist/sealed-format.js';
import { deviceKeys } from '../dist/sealed-keys.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { fixture } from './helpers/sealed-fixture.mjs';

const clear = result => {
  result.key?.fill(0);
  for (const secret of result.secrets) secret.value.fill(0);
};
function local(t, f = fixture()) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-sharing-foundations-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...f.keys, pinCounter: 0 });
  return { directory, f, store, pins: new SecretPins(directory, store) };
}
const pinPath = (directory, project) =>
  join(directory, forgeSecretId('project', project).toString('hex') + '.bin');
const pinBytes = directory =>
  Object.fromEntries(
    readdirSync(directory)
      .filter(name => name.endsWith('.bin'))
      .map(name => [name, readFileSync(join(directory, name))]),
  );

for (const cause of ['older project file', 'missing index and project file'])
  test(`L2 rebuilding Development after ${cause} preserves lost Checks trust across later writes`, async t => {
    const { directory, f, pins } = local(t),
      project = f.request.forgeProjectId,
      checks = fixture(17, project, 2),
      path = pinPath(directory, project);
    clear(await pins.verifyAndSave(f.reply, f.request, 1));
    clear(await pins.verifyAndSave(checks.reply, checks.request, 1));
    const prior = readFileSync(path);
    f.bump();
    f.name();
    clear(await pins.verifyAndSave(f.reply, f.request, 2));
    if (cause === 'older project file') writeFileSync(path, prior);
    else {
      unlinkSync(path);
      unlinkSync(pins.indexPath);
    }
    await assert.rejects(pins.load(project, 1), { code: 'SECRETS_PIN_LOST' });
    clear(await pins.rebuild(f.reply, f.request, true, async () => true));
    assert(await pins.load(project, 1));
    await assert.rejects(pins.load(project, 2), { code: 'SECRETS_PIN_LOST' });
    assert.equal(await pins.load(project, 3), null, 'a never-pinned kind retains first contact');
    const rebuilt = readFileSync(path);
    writeFileSync(path, prior);
    await assert.rejects(pins.load(project, 1), { code: 'SECRETS_PIN_LOST' });
    writeFileSync(path, rebuilt);
    f.bump();
    f.name();
    clear(await pins.verifyAndSave(f.reply, f.request, 3));
    unlinkSync(pins.indexPath);
    clear(await pins.rebuild(f.reply, f.request, true, async () => true));
    await assert.rejects(pins.load(project, 2), { code: 'SECRETS_PIN_LOST' });
    assert.equal(await pins.load('never-pinned-project', 1), null);
  });

// GB-08 d2: the Checks owner rule is checked on the final roster only, against today's Development.
// An honest "add a co-owner, later remove them" history must stay readable after that co-owner left
// Development; the account claim is self-asserted, so per-step checks protected nothing (Gate B1).
function coOwnerHistory(t, { laterSigner = false, removeAtEnd = true } = {}) {
  const f = fixture(17, 'fixture-project', 2),
    local_ = local(t, f),
    accountId = forgeSecretId('account', 'second-owner'),
    other = deviceKeys(accountId, f.random);
  f.name('CHECKS_TOKEN', Buffer.from('synthetic-checks-value-0001'));
  return {
    ...local_,
    f,
    other,
    async build() {
      f.bump();
      f.transition({
        added: [f.entry(other, { accountId, role: 1, how: 6, addedAtRosterVersion: 2 })],
      });
      // L8 follow-up: the ineligible co-owner itself signs a later step.
      if (laterSigner) f.transition({ newSharingMode: 2 }, other);
      if (removeAtEnd) f.rekey({ removed: [other.id], epochBumped: 1 });
      else f.wrap();
    },
  };
}

test('L8/d2 a lagging Checks holder reads after an honest co-owner was added and removed', async t => {
  const h = coOwnerHistory(t);
  clear(await h.pins.verifyAndSave(h.f.reply, h.f.request, 1));
  await h.build();
  const result = await h.pins.verifyAndSave(h.f.reply, h.f.request, 2);
  try {
    assert.equal(result.secrets.map(s => s.name).join(), 'CHECKS_TOKEN');
    assert.equal(result.pin.roster.rosterVersion, 3);
  } finally {
    clear(result);
  }
});

test('L8/d2 a fresh Checks reader walks the same history from genesis and sees names only', async t => {
  const h = coOwnerHistory(t);
  await h.build();
  const { recipient, ...publicRequest } = h.f.request;
  assert(recipient);
  const result = verifySealedReply(h.f.reply, null, publicRequest);
  assert.equal(result.key, undefined);
  assert.equal(result.secrets.length, 0);
  assert.deepEqual(
    result.pin.head.names.map(n => n.name),
    ['CHECKS_TOKEN'],
  );
});

test('L8/d2 a later step signed by the ineligible co-owner is accepted once the final roster is clean', async t => {
  const h = coOwnerHistory(t, { laterSigner: true });
  clear(await h.pins.verifyAndSave(h.f.reply, h.f.request, 1));
  await h.build();
  clear(await h.pins.verifyAndSave(h.f.reply, h.f.request, 2));
});

for (const laterSigner of [false, true])
  test(`L8/d2 an ineligible Checks owner still in the final roster is refused${laterSigner ? ' after signing a later step' : ''}`, async t => {
    const h = coOwnerHistory(t, { laterSigner, removeAtEnd: false });
    clear(await h.pins.verifyAndSave(h.f.reply, h.f.request, 1));
    const before = pinBytes(h.directory);
    await h.build();
    await assert.rejects(
      h.pins.verifyAndSave(h.f.reply, h.f.request, 2),
      error =>
        error.code === 'SECRETS_ROSTER_REFUSED' &&
        error.message === 'Checks owner account has no Development owner device.',
    );
    assert.deepEqual(pinBytes(h.directory), before);

    // The identical Checks chain remains valid when trusted Development authorizes that account.
    const development = fixture();
    development.transition({
      added: [
        development.entry(h.other, {
          accountId: forgeSecretId('account', 'second-owner'),
          role: 1,
          how: 6,
          addedAtRosterVersion: 2,
        }),
      ],
    });
    development.transition({ newChecksPointer: h.f.request.development.roster.checksPointer });
    clear(await h.pins.verifyAndSave(h.f.reply, { ...h.f.request, development: development.pin() }, 2));
  });

for (const [kind, label] of [
  [1, 'Development'],
  [2, 'Checks'],
  [3, 'Production'],
])
  test(`a lost ${label} pin names its set before asking a person to rebuild it`, async t => {
    const { directory, f, pins } = local(t, fixture(17, 'fixture-project', kind));
    const request = {
      ...f.request,
      ...(kind === 3 ? { development: fixture().pin() } : {}),
    };
    clear(await pins.verifyAndSave(f.reply, request, 1));
    unlinkSync(pinPath(directory, request.forgeProjectId));
    await assert.rejects(
      pins.rebuild(f.reply, request, true, async summary => {
        assert(summary.startsWith(`${label} as of `));
        return false;
      }),
      { code: 'CANCELLED' },
    );
    await assert.rejects(pins.load(request.forgeProjectId, kind), { code: 'SECRETS_PIN_LOST' });
  });

test('device-key startup removes an unpublished private temp left by a killed writer', async t => {
  const { directory, f, store } = local(t),
    temporaryName = `device.bin.${randomUUID()}`,
    temporary = join(directory, temporaryName),
    unrelated = join(directory, 'device.bin.keep'),
    nilUuid = join(directory, 'device.bin.00000000-0000-0000-0000-000000000000'),
    published = readFileSync(store.path);
  const child = spawn(
    process.execPath,
    ['tests/fixtures/sealed-pin-worker.mjs', 'hold-key-write', directory, temporaryName],
    {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    published.fill(0);
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  assert.equal(existsSync(temporary), true);
  await assert.rejects(
    secretLocked(join(directory, 'pins.lock'), () => true, 0),
    { code: 'SECRETS_PIN_BUSY' },
  );
  assert.equal(existsSync(temporary), true, 'a live writer still owns the copy');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;

  writeFileSync(unrelated, 'synthetic unrelated file', { mode: 0o600 });
  writeFileSync(nilUuid, 'synthetic unrelated file', { mode: 0o600 });
  const keys = await ensureSecretDevice(directory, f.account);
  try {
    assert(keys.id.equals(f.keys.id));
    assert(readFileSync(store.path).equals(published));
    assert.equal(existsSync(temporary), false);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(nilUuid), true);
  } finally {
    wipeDeviceKeys(keys);
  }
});

test('F3 a killed holder loses its lock candidate while live and unidentifiable candidates are preserved', async t => {
  const { directory } = local(t),
    path = join(directory, 'pins.lock'),
    child = spawn(process.execPath, ['tests/fixtures/sealed-pin-worker.mjs', 'hold', directory], {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  const candidate = readdirSync(directory).find(name => name.endsWith('.candidate')),
    candidatePath = join(directory, candidate),
    bytes = readFileSync(candidatePath);
  await assert.rejects(
    secretLocked(path, () => true, 0),
    { code: 'SECRETS_PIN_BUSY' },
  );
  assert.deepEqual(readFileSync(candidatePath), bytes, 'a live candidate must not be swept');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const mismatched = `${path}.${randomUUID()}.candidate`,
    incomplete = `${path}.${randomUUID()}.candidate`;
  writeFileSync(mismatched, serialize(deserialize(bytes)), { mode: 0o600 });
  writeFileSync(incomplete, Buffer.alloc(0), { mode: 0o600 });
  assert.equal(await secretLocked(path, () => true), true);
  assert.equal(existsSync(candidatePath), false, 'the dead holder candidate must be reclaimed');
  assert.deepEqual(readFileSync(mismatched), bytes);
  assert.equal(readFileSync(incomplete).length, 0);
});
