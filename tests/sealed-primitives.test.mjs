// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frame, framedHash, uint, forgeSecretId, codeBytes, replyBytes } from '../dist/sealed-format.js';
import {
  deviceKeys,
  keyCommit,
  inboxKeys,
  signBytes,
  wrapSetKey,
  unwrapSetKey,
  agree,
} from '../dist/sealed-keys.js';
import { bucketSize, sealValue, openValue, ciphertextHash } from '../dist/sealed-value.js';
import { changeBytes, repinBytes } from '../dist/sealed-records.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/sealed-v1.json', import.meta.url)));
const b = (length, byte) => Buffer.alloc(length, byte);
const context = {
  projectId: b(16, 4),
  setId: b(16, 5),
  epoch: 7,
  name: 'API_TOKEN',
  kind: 1,
  valueVersion: 11,
  valueEpoch: 7,
  sealEpoch: 7,
};
const key = b(32, 6),
  value = Buffer.from('fixture-value-0123456789');
const random =
  (...bytes) =>
  length =>
    b(length, bytes.shift());
const device = () => deviceKeys(b(16, 3), random(1, 2, 15));
const hex = (name, bytes) => assert.equal(Buffer.from(bytes).toString('hex'), vectors[name], name);

test('T11 independent Node/OpenSSL known answers bind frame, IDs, device keys, set keys, value, author and wrap', () => {
  hex('frame', frame('commit', context.projectId, context.setId, uint(7)));
  hex('projectId', forgeSecretId('project', 'fixture-project'));
  hex('accountId', forgeSecretId('account', 'fixture-account'));
  assert.notDeepEqual(
    forgeSecretId('project', 'fixture-project'),
    forgeSecretId('project', 'fixture-project-2'),
  );
  assert.notDeepEqual(
    forgeSecretId('account', 'fixture-account'),
    forgeSecretId('account', 'fixture-account-2'),
  );
  assert.notDeepEqual(forgeSecretId('project', '\u00e9'), forgeSecretId('project', 'e\u0301'));
  const d = device();
  for (const name of ['signPub', 'encPub', 'bindSig']) hex(name, d[name]);
  hex('deviceId', d.id);
  hex('commit', keyCommit(key, context));
  const inbox = inboxKeys(key, context);
  hex('inbox', inbox.privateKey);
  hex('inboxPub', inbox.publicKey);
  const sealed = sealValue(key, context, value, { r: b(32, 10), random: random(8, 9) });
  for (const name of ['stored', 'ctHash', 'valueCommit']) hex(name, sealed[name]);
  const record = {
    ...context,
    changedAt: 1234,
    proposalId: b(0),
    valueCommit: sealed.valueCommit,
    changedBy: d.id,
  };
  const bytes = changeBytes({ ...context, setKind: 1 }, record);
  hex(
    'repinInput',
    repinBytes({ ...context, rosterVersion: 1 }, b(32, 13), { headVersion: 11 }, b(32, 14), d.id, b(16, 15)),
  );
  hex('changeInput', bytes);
  hex('changeSig', signBytes(bytes, d.sign));
  const wrap = wrapSetKey(key, context, { id: d.id, encPub: d.encPub, kind: 1 }, random(12));
  hex('ephPub', wrap.ephPub);
  hex('wrap', wrap.ciphertext);
  assert.deepEqual(
    unwrapSetKey(wrap, context, { id: d.id, enc: d.enc, kind: 1 }, keyCommit(key, context)),
    key,
  );
  const opened = openValue(key, context, sealed.stored, sealed);
  assert.deepEqual(opened.value, value);
  assert.deepEqual(opened.r, b(32, 10));
});

test('T11 code and reply known answers cover every purpose', () => {
  const d = device(),
    bytes = Buffer.from(vectors.changeInput, 'hex');
  // Rebuild the framed change input rather than trusting unframed bytes from disk.
  const input = changeBytes(
    { ...context, setKind: 1 },
    {
      ...context,
      changedAt: 1234,
      proposalId: b(0),
      valueCommit: Buffer.from(vectors.valueCommit, 'hex'),
      changedBy: d.id,
    },
  );
  assert.deepEqual(Buffer.from(input), bytes);
  for (const purpose of [1, 2, 3, 4]) {
    hex(
      `code${purpose}`,
      codeBytes({
        purpose,
        ...context,
        rosterVersion: 1,
        rosterHash: b(32, 13),
        accountId: b(16, 3),
        deviceId: d.id,
        signPub: d.signPub,
        encPub: d.encPub,
        nonce: b(16, 14),
      }),
    );
    hex(`reply${purpose}`, replyBytes(purpose, input, signBytes(input, d.sign)));
  }
});

test('T5 value authentication binds name, project, set, kind, version and both epochs', () => {
  const sealed = sealValue(key, context, value);
  for (const changed of [
    { name: 'OTHER' },
    { projectId: b(16, 22) },
    { setId: b(16, 22) },
    { kind: 2 },
    { valueVersion: 12 },
    { valueEpoch: 6 },
    { sealEpoch: 8, epoch: 8 },
  ])
    assert.throws(
      () =>
        openValue(key, { ...context, ...changed }, sealed.stored, {
          ...sealed,
          ctHash: ciphertextHash(changed.name ?? context.name, sealed.stored),
        }),
      { code: 'SECRETS_VALUE_REFUSED' },
    );
});

test('T9 wraps reject another recipient, epoch and server-chosen key commitment', () => {
  const d = device(),
    wrap = wrapSetKey(key, context, { id: d.id, encPub: d.encPub, kind: 1 });
  for (const [ctx, recipient, commit] of [
    [context, { id: b(16, 22), enc: d.enc, kind: 1 }, keyCommit(key, context)],
    [{ ...context, epoch: 8 }, { id: d.id, enc: d.enc, kind: 1 }, keyCommit(key, context)],
    [context, { id: d.id, enc: d.enc, kind: 1 }, keyCommit(b(32, 22), context)],
  ])
    assert.throws(
      () => unwrapSetKey(wrap, ctx, recipient, commit),
      error => ['SECRETS_WRAP_REFUSED', 'SECRETS_VALUE_REFUSED'].includes(error.code),
    );
});

test('T10 agreement rejects zero and low-order public keys', () => {
  for (const pub of [b(32, 0), Buffer.concat([Buffer.from([1]), b(31, 0)])])
    assert.throws(() => agree(b(32, 2), pub), { code: 'SECRETS_WRAP_REFUSED' });
});

test('T18 value padding uses only format buckets and fresh hiding randomness, including a full-size file', () => {
  for (const length of [0, 1, 220, 221, 476, 477, 4060, 4061, 65536]) {
    const input = b(length, 17),
      sealed = sealValue(key, context, input);
    assert.equal(sealed.stored.length, bucketSize(length) + 60);
    assert.deepEqual(openValue(key, context, sealed.stored, sealed).value, input);
    assert.notDeepEqual(sealValue(key, context, input).valueCommit, sealed.valueCommit);
  }
});

test('T24 unframed bytes cannot reach protocol hashes or signatures; pin key is independently drawn', () => {
  assert.throws(() => framedHash(Buffer.from('not framed')), { code: 'SECRETS_FORMAT_REFUSED' });
  assert.throws(() => signBytes(Buffer.from('not framed'), key), { code: 'SECRETS_FORMAT_REFUSED' });
  const d = device();
  assert.deepEqual(d.sign, b(32, 1));
  assert.deepEqual(d.enc, b(32, 2));
  assert.deepEqual(d.pinKey, b(32, 15));
});
