// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs } from './convex-args.mjs';

export const board = await import(moduleUrl('../convex/projectBoard.ts'));
export const operator = await import(moduleUrl('../convex/projectBoardOperator.ts'));
export const delivery = await import(moduleUrl('../convex/projectBoardDelivery.ts'));
export const limits = await import(moduleUrl('../convex/projectBoardLimits.ts'));
const day = 24 * 60 * 60 * 1000;

/** Owner `owner` (@owner-h), contributor `writer` (@writer-h), reader `reader`, stranger `outsider`.
 * Lanes: A (writer's, Issue I), B (owner's, Issue I), C (owner's, closed). Counts reads per call. */
export function boardFixture() {
  const s = state([]);
  for (const name of [
    'hostedProjects',
    'projectContributors',
    'projectReaders',
    'projectHostedOverlapLanes',
    'projectHostedRecordHeads',
    'projectBoardMessages',
    'projectBoardInboxes',
    'projectBoardSenders',
    'projectBoardProjects',
    'boardAccounts',
    'boardSwitches',
    'boardAudit',
    'boardEvidence',
  ])
    s.tables[name] ??= new Map();
  const project = (id, extra = {}) =>
    s.tables.hostedProjects.set(id, {
      _id: id,
      _creationTime: Date.now() - 30 * day,
      owner: 'owner',
      visibility: 'private',
      sourceAuthority: { mode: 'server', epoch: 1 },
      ...extra,
    });
  project('project');
  s.tables.projectContributors.set('c1', { _id: 'c1', projectId: 'project', contributor: 'writer' });
  s.tables.projectReaders.set('r1', { _id: 'r1', projectId: 'project', reader: 'reader' });
  for (const [owner, handle, age] of [
    ['owner', 'owner-h', 30 * day],
    ['writer', 'writer-h', 30 * day],
  ])
    s.tables.forgeAccounts.set(`acct-${owner}`, {
      _id: `acct-${owner}`,
      _creationTime: Date.now() - age,
      owner,
      handle,
    });
  const issue = randomUUID();
  const lanes = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
  const lane = (key, actor, open, projectId = 'project') =>
    s.tables.projectHostedOverlapLanes.set(`lane-${key}-${projectId}`, {
      _id: `lane-${key}-${projectId}`,
      _creationTime: Date.now(),
      projectId,
      laneId: lanes[key],
      intentId: issue,
      actor,
      intent: issue,
      head: 'h',
      baseHead: 'h',
      baseReceiptId: 'r',
      baseSequence: 0,
      recordVersion: 0,
      open,
      changes: '[]',
      complete: true,
    });
  lane('A', 'writer', true);
  lane('B', 'owner', true);
  lane('C', 'owner', false);
  for (const key of ['A', 'B'])
    s.tables.projectHostedRecordHeads.set(`head-${key}`, {
      _id: `head-${key}`,
      projectId: 'project',
      kind: 'lane',
      key: lanes[key],
      parent: issue,
      status: 'active',
      version: 0,
      recordId: 'x',
    });
  let reads = 0;
  const query = s.ctx.db.query;
  s.ctx.db.query = (...args) => {
    const q = query(...args);
    for (const method of ['unique', 'take']) {
      const run = q[method];
      q[method] = async (...rest) => {
        const result = await run(...rest);
        reads += Array.isArray(result) ? Math.max(1, result.length) : 1;
        return result;
      };
    }
    return q;
  };
  const alerts = () =>
    s.scheduled.filter(task => getFunctionName(task.fn) === 'projectBoardLimits:deliver').map(t => t.args);
  async function invoke(fn, name, args, actor = 'owner') {
    s.caller(actor);
    checkArgs(fn, args, name);
    reads = 0;
    const run = () => fn._handler(s.ctx, args);
    try {
      const result = fn.isMutation ? await s.transaction(run) : await run();
      return typeof result === 'string' ? JSON.parse(result) : result;
    } finally {
      invoke.reads = reads;
    }
  }
  const post = (args, actor = 'owner') =>
    invoke(
      board.post,
      'projectBoard:post',
      { projectId: 'project', operationId: randomUUID(), ...args },
      actor,
    );
  const read = (args = {}, actor = 'owner') =>
    invoke(board.read, 'projectBoard:read', { projectId: 'project', ...args }, actor);
  const op = (name, args) => invoke(operator[name], `projectBoardOperator:${name}`, args, null);
  return { ...s, invoke, post, read, op, alerts, lanes, issue, project, lane };
}
