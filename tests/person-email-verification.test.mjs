// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { findPersonByEmail, personByEmail } = await import(moduleUrl('../convex/projectPeople.ts'));
test('membership email lookup requires an exact verified address, including secondary addresses', async t => {
  const previous = process.env.CLERK_SECRET_KEY,
    fetch = globalThis.fetch;
  process.env.CLERK_SECRET_KEY = 'synthetic-provider-key';
  let users = [];
  globalThis.fetch = async () => Response.json(users);
  t.after(() => {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = previous;
  });
  for (const verification of [
    undefined,
    null,
    {},
    { status: 'unverified' },
    { status: 'reserved' },
    { status: 'expired' },
  ]) {
    users = [
      { id: 'unverified-account', email_addresses: [{ email_address: 'target@example.test', verification }] },
    ];
    assert.equal(await findPersonByEmail(' TARGET@example.test '), null);
    await assert.rejects(personByEmail('target@example.test'), e => e.code === 'BAD_ARGUMENT');
  }
  users.push({
    id: 'verified-account',
    primary_email_address_id: 'primary',
    email_addresses: [
      { id: 'primary', email_address: 'other@example.test', verification: { status: 'verified' } },
      { id: 'secondary', email_address: 'target@example.test', verification: { status: 'verified' } },
    ],
  });
  assert.equal((await findPersonByEmail('target@example.test')).id, 'verified-account');
  users.push({
    id: 'another-verified-account',
    email_addresses: [{ email_address: 'target@example.test', verification: { status: 'verified' } }],
  });
  await assert.rejects(findPersonByEmail('target@example.test'), e => e.code === 'BAD_ARGUMENT');
});
