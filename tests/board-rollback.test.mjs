// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvexError } from 'convex/values';
import { boardHostedSource } from '../dist/hosted-board.js';
import { rememberBoardServerFeatures } from '../dist/board-local.js';
import { readHostedEditPeers } from '../dist/agent-edit-hosted.js';
import { readHostedOverlapAdvice } from '../dist/hosted-overlap-client.js';

// Recorded from the dev server's argument validator with an unsupported laneAfter
// on projectHostedAgent:capabilities; validation rejects it before the handler runs.
const rollbackError =
  'ArgumentValidationError: Object contains extra field `laneAfter` that is not in the validator.';
const features = ['agent-board', 'board-lane-after'];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-board-rollback-'));
  const prior = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');
  t.after(() => {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
  });
  rememberBoardServerFeatures('project', features);
  const laneId = randomUUID();
  const board = {
    messages: [{ id: randomUUID(), target: `lane:${laneId}`, text: 'Recovered note', at: 1 }],
    more: 0,
    cursor: 1,
  };
  const reply = {
    ...board,
    board,
    behindMain: { commits: 0, conflictingPaths: [], more: 0, coverage: 'hosted' },
  };
  return { root, laneId, reply };
}
const read = (kind, f, query) => {
  if (kind === 'board')
    return boardHostedSource({ root: f.root, advertisedFeatures: features, query }, 'board', {
      laneId: f.laneId,
    });
  if (kind === 'hook')
    return readHostedEditPeers(
      {
        root: f.root,
        project: 'project',
        url: 'https://synthetic.invalid',
        laneId: f.laneId,
        path: 'src/file.ts',
      },
      query,
    );
  return readHostedOverlapAdvice({ query }, f.laneId, false, undefined, undefined, {
    after: 0,
    laneAfter: 0,
  });
};
for (const kind of ['board', 'hook', 'advice']) {
  test(`${kind}: a cached laneAfter rejected after server rollback retries once without changing the ordinary cursor`, async t => {
    const f = fixture(t),
      calls = [];
    const result = await read(kind, f, async (_name, args) => {
      const cursor = args.board ?? args;
      calls.push(cursor);
      if ('laneAfter' in cursor) throw Error(rollbackError);
      return f.reply;
    });
    assert.match(JSON.stringify(result), /Recovered note/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].laneAfter, 0, 'zero is still a sent optional field');
    assert.equal(calls[1].laneAfter, undefined);
    assert.equal(calls[1].after, calls[0].after);
  });
  test(`${kind}: a second query failure never creates a third rollback retry`, async t => {
    const f = fixture(t);
    let calls = 0;
    const promise = read(kind, f, async (_name, args) => {
      calls++;
      if ('laneAfter' in (args.board ?? args)) throw Error(rollbackError);
      throw Error('Synthetic unavailable');
    });
    if (kind === 'advice') assert.equal((await promise).behindMain.coverage, 'unavailable');
    else await assert.rejects(promise, /Synthetic unavailable/);
    assert.equal(calls, 2);
  });
  test(`${kind}: access refusal is preserved without a retry`, async t => {
    const f = fixture(t);
    let calls = 0;
    await assert.rejects(
      read(kind, f, async () => {
        calls++;
        throw new ConvexError({ code: 'FORBIDDEN', message: 'Access denied' });
      }),
      error => (error.data?.code ?? error.code) === 'FORBIDDEN',
    );
    assert.equal(calls, 1);
  });
  test(`${kind}: a supported server uses one query`, async t => {
    const f = fixture(t);
    let calls = 0;
    const result = await read(kind, f, async () => {
      calls++;
      return f.reply;
    });
    assert.match(JSON.stringify(result), /Recovered note/);
    assert.equal(calls, 1);
  });
}
