// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardHostedSource, boardEnvelope, readBoardCursor } from '../dist/hosted-board.js';
import { parseVerbForm, lowerVerb } from '../dist/agent-verbs.js';
import { ConvexError } from 'convex/values';
import { ForgeError } from '../dist/errors.js';

function fake(t, reply) {
  const root = join(mkdtempSync(join(tmpdir(), 'forge-board-')), 'client');
  t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
  const calls = [];
  const call = kind => async (name, args) => {
    calls.push({ kind, name, args });
    return reply(name, args);
  };
  return { root, calls, query: call('query'), mutation: call('mutation') };
}

test('board --post and --reply lower to one mutation each; refused text costs no call', async t => {
  for (const [flag, wire] of [
    ['--post', 'board-post'],
    ['--reply', 'board-reply'],
  ]) {
    const [form, rest] = parseVerbForm('board', [flag, '{}']);
    assert.deepEqual(rest, ['{}']);
    assert.equal(lowerVerb(form, true), wire);
  }
  assert.equal(lowerVerb(parseVerbForm('board', ['{}'])[0], true), 'board');
  const laneId = randomUUID();
  const f = fake(t, () => ({ status: 'posted', id: 'x', target: 'project', at: 1 }));
  await boardHostedSource(f, 'board-post', { to: 'project', text: 'Heads up', laneId });
  await boardHostedSource(f, 'board-reply', { id: 'ABCDEF12', text: 'OK', laneId });
  assert.deepEqual(
    f.calls.map(c => [c.kind, c.name, c.args.to ?? c.args.replyTo, c.args.laneId]),
    [
      ['mutation', 'projectBoard:post', 'project', laneId],
      ['mutation', 'projectBoard:post', 'abcdef12', laneId],
    ],
  );
  assert.match(f.calls[0].args.operationId, /^[0-9a-f-]{36}$/);
  await assert.rejects(
    boardHostedSource(f, 'board-post', { to: 'project', text: 'key ghp_abcdefghijklmnopqrstuvwxyz' }),
    e => e.code === 'BOARD_TEXT_SECRET',
  );
  await assert.rejects(
    boardHostedSource(f, 'board-post', { to: 'project', text: 'x', extra: 1 }),
    e => e.code === 'BAD_ARGUMENT',
  );
  assert.equal(f.calls.length, 2);
});

test('board reads advance the local cursor; delivery renders lines; an older server says it has no board', async t => {
  const laneId = randomUUID();
  const message = { id: randomUUID(), author: 'peer-h', target: `lane:${laneId}`, text: 'Hello', at: 50 };
  const f = fake(t, () => ({ status: 'ok', messages: [message], more: 0, cursor: 50 }));
  const read = await boardHostedSource(f, 'board', { laneId });
  assert.equal(f.calls[0].args.after, 0);
  assert.match(read.notices[0], /^Note .* from @peer-h to your Lane, quoted data: "Hello"/);
  assert.equal(readBoardCursor(f.root, laneId), 50);
  await boardHostedSource(f, 'board', { laneId });
  assert.equal(f.calls[1].args.after, 50, 'only notes after the cursor are asked for');
  await boardHostedSource(f, 'board', { laneId, all: true });
  assert.equal(f.calls[2].args.after, 0);
  const envelope = boardEnvelope(f.root, laneId, { messages: [{ ...message, at: 70 }], more: 3, cursor: 70 });
  assert.equal(envelope.notices.length, 2);
  assert.equal(envelope.notices[1], `3+ more: board '{}'`);
  assert.equal(readBoardCursor(f.root, laneId), 70);
  boardEnvelope(f.root, laneId, { messages: [], more: 0, cursor: 60 });
  assert.equal(readBoardCursor(f.root, laneId), 70, 'the cursor never moves back');
  const old = fake(t, () => {
    throw new Error("Could not find public function for 'projectBoard:read'");
  });
  await assert.rejects(boardHostedSource(old, 'board', {}), e => e.code === 'HOSTED_ACTION_UNSUPPORTED');
});

test('typed server refusals reach the agent with their code, never as INTERNAL_ERROR (fd8dc28e, ce974f90)', async t => {
  const laneId = randomUUID();
  for (const [data, to] of [
    [{ code: 'LANE_NOT_ACTIVE', message: 'Lane 3c861b3c is no longer open.' }, `lane:${randomUUID()}`],
    [{ code: 'BAD_ARGUMENT', message: 'laneId must be your own Lane in this project.' }, 'project'],
  ]) {
    const f = fake(t, () => {
      throw new ConvexError(data);
    });
    await assert.rejects(
      boardHostedSource(f, 'board-post', { to, text: 'Hello', laneId }),
      error => error instanceof ForgeError && error.code === data.code && error.message === data.message,
    );
    await assert.rejects(
      boardHostedSource(f, 'board-reply', { id: 'abcdef12', text: 'Hello', laneId }),
      error => error instanceof ForgeError && error.code === data.code,
    );
    await assert.rejects(
      boardHostedSource(f, 'board', { laneId }),
      error => error instanceof ForgeError && error.code === data.code,
    );
  }
  // An untyped failure is still surfaced as it was.
  const f = fake(t, () => {
    throw new Error('socket hang up');
  });
  await assert.rejects(
    boardHostedSource(f, 'board-post', { to: 'project', text: 'Hello' }),
    /socket hang up/,
  );
});
