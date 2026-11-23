// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSealedWire, decodeSealedWire } from '../dist/sealed-wire.js';
import { sealedWrite, sealedRead } from '../dist/sealed-transport.js';
import { fixture } from './helpers/sealed-fixture.mjs';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { frame, framedHash, uint } from '../dist/sealed-format.js';

test('portable stored records preserve signed bytes with raw binary blocks in a non-Node decoder', () => {
  const f = fixture();
  f.name();
  const wire = sealedWrite(f.reply, 'synthetic-operation', null),
    reply = sealedRead(wire);
  assert.equal(
    verifySealedReply(reply, null, f.request).secrets[0].value.toString(),
    'synthetic-value-0123456789',
  );
  const decoded = decodeSealedWire(new Uint8Array(wire.payload));
  assert(decoded.roster.projectId instanceof Uint8Array);
  assert.equal(Buffer.isBuffer(decoded.roster.projectId), false);
  assert.equal(
    verifySealedReply(
      { ...decoded, genesis: decodeSealedWire(new Uint8Array(wire.history.genesis)), transitions: [] },
      null,
      f.request,
    ).secrets.length,
    1,
  );
  const bytes = encodeSealedWire({
    binary: Buffer.alloc(128, 173),
    empty: Buffer.alloc(0),
    nested: [new Uint8Array([1, 2, 3])],
  });
  assert(bytes.length < 256);
  assert.deepEqual(decodeSealedWire(bytes).nested[0], new Uint8Array([1, 2, 3]));
});
test('malformed wire versions, truncated blocks, invalid indexes and trailing bytes are refused before verification', () => {
  const valid = encodeSealedWire({ binary: new Uint8Array([1, 2, 3]) });
  for (const bytes of [
    new Uint8Array(0),
    Uint8Array.from(valid, (_, i) => (i === 3 ? 99 : valid[i])),
    valid.subarray(0, -1),
    new Uint8Array([...valid, 0]),
  ])
    assert.throws(() => decodeSealedWire(bytes), { code: 'SECRETS_FORMAT_REFUSED' });
  const invalidIndex = encodeSealedWire({ binary: { $sealedBytes: 2 } });
  assert.throws(() => decodeSealedWire(invalidIndex), { code: 'SECRETS_FORMAT_REFUSED' });
});
test('T24 mutation cannot turn a constructed frame into raw cryptographic input', () => {
  const bytes = frame('commit', Buffer.alloc(16), Buffer.alloc(16), uint(1));
  bytes.fill(0);
  assert.throws(() => framedHash(bytes), { code: 'SECRETS_FORMAT_REFUSED' });
});
