// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serialize, deserialize } from 'node:v8';
import { fixture } from './helpers/sealed-fixture.mjs';
import { reviewCases } from './helpers/sealed-review-cases.mjs';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { SecretPins } from '../dist/sealed-pins.js';
import { FileKeyStore, secretLocked } from '../dist/sealed-local.js';
import { safeSecretName } from '../dist/sealed-display.js';
import { sealedRead, sealedWrite } from '../dist/sealed-transport.js';
import { decodeSealedReply } from '../dist/sealed-decode.js';
import { framedHash, forgeSecretId } from '../dist/sealed-format.js';
import { rosterBytes } from '../dist/sealed-records.js';
import { deviceKeys } from '../dist/sealed-keys.js';
const clone = x => deserialize(serialize(x));
const clear = r => {
  r.key?.fill(0);
  for (const s of r.secrets) s.value.fill(0);
};
function local(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-sealed-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(),
    store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...f.keys, pinCounter: 0 });
  return { directory, f, pins: new SecretPins(directory, store) };
}
const files = d =>
  Object.fromEntries(
    readdirSync(d)
      .filter(n => n.endsWith('.bin'))
      .map(n => [n, readFileSync(join(d, n))]),
  );
for (const [name, run] of Object.entries(reviewCases)) test(name, () => run(verifySealedReply));

test('M1 T94 healthy or never-pinned trust cannot be re-pinned, including a restoration during confirmation', async t => {
  const { directory, f, pins } = local(t),
    old = clone(f.reply);
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  f.bump();
  f.name();
  clear(await pins.verifyAndSave(f.reply, f.request, 2));
  const before = files(directory);
  await assert.rejects(
    pins.rebuild(old, f.request, true, async () => true),
    { code: 'SECRETS_NOT_ALLOWED' },
  );
  assert.deepEqual(files(directory), before);
  const fresh = fixture(17, 'never-pinned-project');
  await assert.rejects(
    pins.rebuild(fresh.reply, fresh.request, true, async () => true),
    { code: 'SECRETS_NOT_ALLOWED' },
  );
  unlinkSync(join(directory, forgeSecretId('project', f.request.forgeProjectId).toString('hex') + '.bin'));
  await assert.rejects(
    pins.rebuild(f.reply, f.request, true, async () => {
      clear(await pins.rebuild(f.reply, f.request, true, async () => true));
      return true;
    }),
    { code: 'SECRETS_NOT_ALLOWED' },
  );
});
test('L9 hostile roster, equal-version fork and ciphertext tamper leave every pin/index/key-store byte unchanged', async t => {
  const { directory, f, pins } = local(t);
  f.name();
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  const valid = clone(f.reply),
    before = files(directory);
  const cases = [
    [
      r => {
        r.roster = { ...r.roster, sharingMode: 1 };
      },
      'SECRETS_FORK',
    ],
    [
      r => {
        r.head.signedAt++;
        f.signHead();
      },
      'SECRETS_FORK',
    ],
    [
      r => {
        r.ciphertexts[0].stored[55] ^= 1;
      },
      'SECRETS_VALUE_REFUSED',
    ],
  ];
  for (const [attack, code] of cases) {
    Object.assign(f.reply, clone(valid));
    attack(f.reply);
    await assert.rejects(pins.verifyAndSave(f.reply, f.request, 2), { code });
    assert.deepEqual(files(directory), before);
  }
});
test('L1 exact per-record decoding rejects unsigned extras, bad types and fixed-width lengths before they enter a cache', () => {
  const f = fixture();
  f.name();
  const targets = [
    r => r,
    r => r.genesis,
    r => r.roster.entries[0],
    r => r.head,
    r => r.head.names[0],
    r => r.wraps[0],
    r => r.ciphertexts[0],
  ];
  for (const target of targets) {
    const r = clone(f.reply);
    target(r).unsigned = 'injected';
    assert.throws(() => decodeSealedReply(r), { code: 'SECRETS_FORMAT_REFUSED' });
  }
  for (const change of [
    r => {
      r.head.headVersion = '1';
    },
    r => {
      r.head.names[0].projectId = Buffer.alloc(16);
    },
    r => {
      r.roster.setId = Buffer.alloc(15);
    },
  ]) {
    const r = clone(f.reply);
    change(r);
    assert.throws(() => verifySealedReply(r, null, f.request), { code: 'SECRETS_FORMAT_REFUSED' });
  }
  const wire = sealedWrite(f.reply, '00000000-0000-4000-8000-000000000001', null),
    decoded = sealedRead(wire);
  assert.deepEqual(sealedWrite(decoded, wire.operationId, null).history.genesis, wire.history.genesis);
});
test('L3 interrupted lock publication and a dead reclaim gate cannot permanently block the pin lock', async t => {
  const { directory } = local(t),
    path = join(directory, 'pins.lock'),
    old = new Date(Date.now() - 60000);
  writeFileSync(path, Buffer.alloc(0), { mode: 0o600 });
  utimesSync(path, old, old);
  writeFileSync(path + '.unreadable.reclaim', Buffer.alloc(0), { mode: 0o600 });
  utimesSync(path + '.unreadable.reclaim', old, old);
  assert.equal(await secretLocked(path, () => true), true);
  assert.equal(await secretLocked(path, () => true), true);
});
test('Gate B2 L6 a lock whose holder has no recorded start time is reclaimed once older than any holder keeps it', async t => {
  const { directory } = local(t),
    path = join(directory, 'pins.lock'),
    token = '00000000-0000-4000-8000-000000000042';
  // A live pid with no start identity: it cannot be told from a reused pid, so only its age can free the lock.
  writeFileSync(path, serialize({ pid: process.pid, token }), { mode: 0o600 });
  await assert.rejects(
    secretLocked(path, () => true, 0),
    { code: 'SECRETS_PIN_BUSY' },
  );
  const old = new Date(0); // far older than any holder keeps the lock
  utimesSync(path, old, old);
  assert.equal(await secretLocked(path, () => true), true);
});
test('L4 names printed by lists and missing-name notices cannot contain terminal controls', () => {
  const f = fixture(),
    name = 'API_\u001b[31mTOKEN';
  f.name(name);
  const p = f.pin();
  f.bump();
  f.bump();
  f.reply.head.names = [];
  f.reply.ciphertexts = [];
  f.reply.head.versionFloor = 2;
  f.signHead();
  const result = verifySealedReply(f.reply, p, f.request);
  assert(result.notices.some(s => s.includes(safeSecretName(name))));
  assert(!result.notices.join('').includes('\u001b'));
  assert.equal(safeSecretName(name), 'API_??31?TOKEN');
});
test('holder first contact walks from this device genesis and refuses a set minted around a copied public entry', () => {
  const f = fixture(),
    attacker = fixture(19);
  // A different creator is refused even though this device was subsequently enrolled legitimately.
  const accountId = forgeSecretId('account', 'fixture-owner');
  attacker.transition({ added: [attacker.entry(f.keys, { how: 4, role: 1, addedAtRosterVersion: 2 })] });
  attacker.wrap();
  assert.throws(() => verifySealedReply(attacker.reply, null, f.request), { code: 'SECRETS_ROSTER_REFUSED' });
  const copied = fixture();
  const attackerDevice = deviceKeys(accountId, copied.random);
  copied.reply.roster = {
    ...copied.reply.roster,
    rosterVersion: 2,
    entries: [
      ...copied.reply.roster.entries,
      copied.entry(attackerDevice, { how: 4, addedAtRosterVersion: 2 }),
    ],
  };
  copied.reply.head.rosterVersion = 2;
  copied.reply.head.rosterHash = framedHash(rosterBytes(copied.reply.roster));
  copied.signHead(attackerDevice);
  assert.throws(() => verifySealedReply(copied.reply, null, copied.request), { code: 'SECRETS_PIN_TOO_OLD' });
});

test('L1 reserved proposal and recipient enum fields are decoded strictly even before their journeys exist', () => {
  const f = fixture();
  const proposal = {
    proposalId: Buffer.alloc(16),
    epoch: 1,
    op: 1,
    name: 'API_TOKEN',
    kind: 1,
    baseValueVersion: 0,
    valueCommit: Buffer.alloc(32),
    changeSig: Buffer.alloc(64),
    ephPub: Buffer.alloc(32),
    ciphertext: Buffer.alloc(48),
    ciphertextHash: Buffer.alloc(32),
    proposerId: f.keys.id,
    proposedAt: 1,
    signature: Buffer.alloc(64),
  };
  f.reply.proposals = [proposal];
  decodeSealedReply(f.reply);
  proposal.op = 4;
  assert.throws(() => decodeSealedReply(f.reply), { code: 'SECRETS_FORMAT_REFUSED' });
  f.reply.proposals = [];
  f.reply.roster.entries[0].how = 7;
  assert.throws(() => decodeSealedReply(f.reply), { code: 'SECRETS_FORMAT_REFUSED' });
});

test('L9 genuine older signed head and same-epoch ciphertext rollback preserve every pin file', async t => {
  const { directory, f, pins } = local(t);
  f.name();
  const older = clone(f.reply);
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  f.bump();
  f.name('API_TOKEN', Buffer.from('newer-synthetic-value'));
  clear(await pins.verifyAndSave(f.reply, f.request, 2));
  const current = clone(f.reply),
    before = files(directory);
  for (const [reply, code] of [
    [older, 'SECRETS_ROLLBACK'],
    [{ ...current, ciphertexts: older.ciphertexts }, 'SECRETS_VALUE_REFUSED'],
  ]) {
    await assert.rejects(pins.verifyAndSave(reply, f.request, 3), { code });
    assert.deepEqual(files(directory), before);
  }
});
