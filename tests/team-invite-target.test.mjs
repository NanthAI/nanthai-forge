// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The team invite field takes a Forge handle or an address (Item 2a47e8b3): a handle goes to the pending-handle action,
// an address to the pending-address action, and a lost reply retries with the same operation id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteToTeam } from '../web/src/app/people/team-invite.ts';

const fake = (replies = []) => {
  const calls = [];
  const send = name => async args => {
    calls.push({ name, args });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next ?? 'pending';
  };
  return { calls, client: { handle: send('addMember'), email: send('addByEmail') } };
};

test('team invite routes @handle and bare handle to addMember and an address to addByEmail', async () => {
  const { client, calls } = fake();
  const invite = inviteToTeam(client, new Map());
  for (const who of [' @wren ', 'wren', 'name@example.test'])
    assert.equal(await invite('team', who), 'pending');
  assert.deepEqual(
    calls.map(c => [c.name, c.args.member ?? c.args.email]),
    [
      ['addMember', '@wren'],
      ['addMember', 'wren'],
      ['addByEmail', 'name@example.test'],
    ],
  );
});

test('a lost reply retries the same target with the same operation id, and a new target gets a new one', async () => {
  const { client, calls } = fake([new Error('lost')]);
  const attempts = new Map();
  const invite = inviteToTeam(client, attempts);
  await assert.rejects(invite('team', '@wren'), /lost/);
  await invite('team', '@wren');
  await invite('team', '@rook');
  assert.equal(calls[0].args.operationId, calls[1].args.operationId);
  assert.notEqual(calls[1].args.operationId, calls[2].args.operationId);
  assert.equal(attempts.size, 0, 'finished attempts are forgotten');
});

test('the same recipient retried in another spelling reuses the first operation id and first typed text', async () => {
  const { client, calls } = fake([new Error('lost'), 'pending', new Error('lost')]);
  const invite = inviteToTeam(client, new Map());
  await assert.rejects(invite('team', '@Wren'), /lost/);
  await invite('team', 'wren');
  await assert.rejects(invite('team', 'Name@Example.test'), /lost/);
  await invite('team', 'name@example.test');
  assert.equal(calls[0].args.operationId, calls[1].args.operationId);
  assert.equal(calls[1].args.member, '@Wren', 'the retry repeats the original text');
  assert.equal(calls[2].args.operationId, calls[3].args.operationId);
  assert.equal(calls[3].args.email, 'Name@Example.test');
});

test('routing: a second @ after the first character is an address; whitespace is trimmed; a bare @ stays a handle', async () => {
  const { client, calls } = fake();
  const invite = inviteToTeam(client, new Map());
  for (const who of ['@foo@bar', 'a@b', '@', '  @wren  ']) await invite('team', who);
  assert.deepEqual(
    calls.map(c => [c.name, c.args.member ?? c.args.email]),
    [
      ['addByEmail', '@foo@bar'],
      ['addByEmail', 'a@b'],
      ['addMember', '@'],
      ['addMember', '@wren'],
    ],
  );
});
