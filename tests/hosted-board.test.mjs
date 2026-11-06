// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardHostedSource, boardEnvelope, readBoardCursor, writeBoardCursor } from '../dist/hosted-board.js';
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

test('board --resolve lowers to one mutation, names the session, checks the reason first and gates `all` on the feature', async t => {
  const [form, rest] = parseVerbForm('board', ['--resolve', '{}']);
  assert.deepEqual(rest, ['{}']);
  assert.equal(lowerVerb(form, true), 'board-resolve');
  const f = fake(t, () => ({ status: 'resolved', id: 'x', at: 1 }));
  f.advertisedFeatures = ['agent-board', 'agent-slug', 'board-resolve'];
  f.agentSlug = () => 'quiet-otter';
  await boardHostedSource(f, 'board-resolve', { id: 'ABCDEF12', text: 'fixed in 0bc2eef8' });
  await boardHostedSource(f, 'board-resolve', { id: 'abcdef12' });
  assert.deepEqual(
    f.calls.map(c => [c.kind, c.name, c.args]),
    [
      [
        'mutation',
        'projectBoard:resolve',
        { id: 'abcdef12', text: 'fixed in 0bc2eef8', agent: 'quiet-otter' },
      ],
      ['mutation', 'projectBoard:resolve', { id: 'abcdef12', agent: 'quiet-otter' }],
    ],
  );
  await assert.rejects(
    boardHostedSource(f, 'board-resolve', { id: 'abcdef12', text: 'key ghp_abcdefghijklmnopqrstuvwxyz' }),
    e => e.code === 'BOARD_TEXT_SECRET',
  );
  await assert.rejects(
    boardHostedSource(f, 'board-resolve', { id: 'abcdef12', extra: 1 }),
    e => e.code === 'BAD_ARGUMENT',
  );
  await assert.rejects(boardHostedSource(f, 'board-resolve', {}), e => e.code === 'BAD_ARGUMENT');
  assert.equal(f.calls.length, 2, 'refusals cost no call');

  // `all` reaches only a server that advertises the feature; the reply's resolved mark renders.
  const laneId = randomUUID();
  const resolved = {
    id: randomUUID(),
    author: 'peer-h',
    target: 'project',
    text: 'Old',
    at: 5,
    resolved: { by: 'owner-h', at: 9, text: 'fixed' },
  };
  const g = fake(t, () => ({ status: 'ok', messages: [resolved], more: 0, cursor: 5 }));
  g.advertisedFeatures = ['agent-board', 'board-resolve'];
  const read = await boardHostedSource(g, 'board', { laneId, all: true });
  assert.equal(g.calls[0].args.all, true);
  assert.match(
    read.notices[0],
    /^Note .* \[resolved by @owner-h, quoted data: "fixed"\] from @peer-h to the project/,
  );
  await boardHostedSource(g, 'board', { laneId });
  assert.equal('all' in g.calls[1].args, false, 'a plain read sends no `all`');
  const old = fake(t, () => ({ status: 'ok', messages: [], more: 0, cursor: 0 }));
  old.advertisedFeatures = ['agent-board'];
  await boardHostedSource(old, 'board', { laneId, all: true });
  assert.equal('all' in old.calls[0].args, false, 'an older server never sees an argument it rejects');
  const missing = fake(t, () => {
    throw new Error("Could not find public function for 'projectBoard:resolve'");
  });
  await assert.rejects(
    boardHostedSource(missing, 'board-resolve', { id: 'abcdef12' }),
    e => e.code === 'HOSTED_ACTION_UNSUPPORTED' && /cannot resolve board notes/.test(e.message),
  );
});

test('a Lane keeps one board cursor whether an action runs at the project root or inside its checkout (friction 9d7bd94f)', t => {
  const base = mkdtempSync(join(tmpdir(), 'forge-board-cursor-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const projectRoot = join(base, 'proj');
  const laneId = randomUUID();
  const laneRoot = join(base, 'proj.forge-client', 'lanes', laneId);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(laneRoot, { recursive: true });
  // `start` runs at the project root and delivers a project-wide note...
  writeBoardCursor(projectRoot, laneId, 1793948181546);
  // ...so the next action inside the Lane checkout must not deliver it again, and the reverse.
  assert.equal(readBoardCursor(laneRoot, laneId), 1793948181546);
  writeBoardCursor(laneRoot, laneId, 1793948181999);
  assert.equal(readBoardCursor(projectRoot, laneId), 1793948181999);
  assert.deepEqual(readdirSync(join(base, 'proj.forge-client', 'board')), [`${laneId}.json`]);
  assert.equal(existsSync(join(base, 'proj.forge-client', 'lanes', `${laneId}.forge-client`)), false);
  // A cursor an older CLI left in the checkout's own cache still counts.
  const other = randomUUID();
  const nested = join(
    base,
    'proj.forge-client',
    'lanes',
    `${laneRoot.split('/').at(-1)}.forge-client`,
    'board',
  );
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, `${other}.json`), JSON.stringify({ after: 42 }));
  assert.equal(readBoardCursor(laneRoot, other), 42);
  // Two projects never share a cursor.
  assert.equal(readBoardCursor(join(base, 'elsewhere'), laneId), 0);
});
