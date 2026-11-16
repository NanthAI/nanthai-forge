// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const { chargePasskey, PASSKEY_BUDGET } = await import(moduleUrl('../convex/authBudgets.ts'));
const auth = await import(moduleUrl('../convex/auth.ts'));
const refused = error => error.data?.code === 'RATE_LIMITED';
function fixture() {
  const s = state([]);
  s.tables.deviceAttempts = new Map();
  s.tables.users = new Map();
  s.ctx = {
    ...s.ctx,
    auth: { getUserIdentity: async () => null },
    runQuery: async () => null,
    runMutation: async () => {
      throw new Error('A refused ceremony must not write to a component');
    },
  };
  return s;
}

test('passkey budgets enforce exact handle and shared global allowances before any over-budget write', async () => {
  const s = fixture();
  for (const kind of ['starts', 'signups']) {
    const limit = PASSKEY_BUDGET[kind];
    for (let n = 0; n < limit.handle; n++) await chargePasskey(s.ctx, kind, 'one-handle', 60001);
    const before = JSON.stringify([...s.tables.deviceAttempts]);
    await assert.rejects(chargePasskey(s.ctx, kind, 'one-handle', 60002), refused);
    assert.equal(JSON.stringify([...s.tables.deviceAttempts]), before);
    for (let n = limit.handle; n < limit.global; n++) await chargePasskey(s.ctx, kind, `handle-${n}`, 60003);
    const full = JSON.stringify([...s.tables.deviceAttempts]);
    await assert.rejects(chargePasskey(s.ctx, kind, 'another-handle', 60004), refused);
    assert.equal(JSON.stringify([...s.tables.deviceAttempts]), full);
  }
  assert.equal(s.tables.deviceAttempts.size, 2);
});

test('passkey budget windows replace their bounded handle lists without accumulating visitor rows or scheduled work', async () => {
  const s = fixture();
  for (let window = 1; window <= 3; window++) {
    for (const kind of ['starts', 'signups']) {
      const limit = PASSKEY_BUDGET[kind];
      for (let n = 0; n < limit.global; n++)
        await chargePasskey(s.ctx, kind, `handle-${window}-${n}`, window * 60000);
    }
    assert.equal(s.tables.deviceAttempts.size, 2);
    for (const row of s.tables.deviceAttempts.values()) {
      const kind = row.owner.endsWith('starts') ? 'starts' : 'signups';
      assert.equal(row.handles.length, PASSKEY_BUDGET[kind].global);
      assert.ok(row.handles.every(value => value.handle.startsWith(`handle-${window}-`)));
    }
  }
  const row = [...s.tables.deviceAttempts.values()][0];
  await chargePasskey(s.ctx, 'starts', undefined, 4 * 60000);
  assert.equal(row.handles.length, 0);
  assert.equal(row.count, 1);
});

test('direct sign-in, autofill and sign-up endpoints all refuse a spent server budget without starting a ceremony', async t => {
  t.mock.method(Date, 'now', () => 60000);
  const s = fixture();
  const windowAt = Date.now() - (Date.now() % 60000);
  for (const kind of ['starts', 'signups'])
    s.tables.deviceAttempts.set(kind, {
      _id: kind,
      _creationTime: 1,
      owner: `system:passkey-${kind}`,
      windowAt,
      count: PASSKEY_BUDGET[kind].global,
      handles: [],
    });
  const before = JSON.stringify([...s.tables.deviceAttempts]);
  await assert.rejects(
    auth.startSignInWithUsernamePasskey._handler(s.ctx, { username: 'new-handle' }),
    refused,
  );
  await assert.rejects(auth.startAutofillSignInWithUsernamePasskey._handler(s.ctx, {}), refused);
  await assert.rejects(
    auth.finishSignUpWithUsernamePasskey._handler(s.ctx, {
      username: 'new-handle',
      response: {
        id: 'credential',
        rawId: 'credential',
        type: 'public-key',
        response: { clientDataJSON: '', attestationObject: '' },
        clientExtensionResults: {},
      },
    }),
    refused,
  );
  assert.equal(JSON.stringify([...s.tables.deviceAttempts]), before);
  assert.equal(s.tables.users.size, 0);
});
