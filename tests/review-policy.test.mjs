// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { WorkService } from '../dist/work.js';
import { fixture, git, write, code } from './helpers.mjs';

function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original source']);
  const work = new WorkService(root),
    local = command => work.execute(command, work.status().revision).result;
  const intent = local({ action: 'intent', outcome: 'Optional account-attributed approvals' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Original candidate' });
  const view = local({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const publicationId = randomUUID(),
    data = work.store.load();
  data.publications.push({
    id: publicationId,
    viewId: view.id,
    head: view.head,
    repository: 'tests/example',
    number: 7,
    base: 'main',
    title: 'Original PR',
    draft: false,
    at: '2026-10-02',
    status: 'published',
  });
  work.store.save(data);
  const stateFile = join(root, '.git/review-api.json'),
    callsFile = join(root, '.git/review-calls.log');
  const approval = (patch = {}) => ({
    id: 201,
    state: 'APPROVED',
    commit_id: view.head,
    submitted_at: '2026-10-02T00:00:00Z',
    user: { id: 42, login: '<literal-account>', type: 'User' },
    ...patch,
  });
  writeFileSync(stateFile, JSON.stringify({ head: view.head, reviews: [approval()], pullReads: 0 }));
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8')),
    change = patch => writeFileSync(stateFile, JSON.stringify({ ...state(), pullReads: 0, ...patch }));
  const bin = join(root, '.git/review-bin');
  mkdirSync(bin);
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const file=${JSON.stringify(stateFile)}, state=JSON.parse(readFileSync(file,'utf8')), endpoint=process.argv[7];
if(process.argv[6]!=='GET') process.exit(9);
appendFileSync(${JSON.stringify(callsFile)},endpoint+'\\n'); if(state.denied) process.exit(1);
if(endpoint==='repos/tests/example/pulls/7') {
 state.pullReads++; writeFileSync(file,JSON.stringify(state));
 console.log(JSON.stringify({number:state.badPull?8:7,html_url:'https://github.com/tests/example/pull/7',title:'Current PR',user:{id:1,login:'author'},state:'open',merged:false,merged_at:null,merge_commit_sha:null,head:{ref:'topic',sha:state.drift&&state.pullReads>1?'b'.repeat(40):state.head,repo:{full_name:'tests/example'}},base:{ref:'main',sha:state.head,repo:{full_name:'tests/example'}}}));
} else {
 const match=endpoint.match(/^repos\\/tests\\/example\\/pulls\\/7\\/reviews\\?per_page=100&page=(\\d+)$/); if(!match) process.exit(2);
 const start=state.repeat?0:(Number(match[1])-1)*100; console.log(JSON.stringify(state.malformed?{}:state.reviews.slice(start,start+100)));
}
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${previousPath}`;
  const dispatch = (command, revision = work.status().revision) => work.dispatch(command, revision);
  const define = (patch = {}) => ({
    action: 'define-invariant',
    operationId: randomUUID(),
    invariantId: randomUUID(),
    intentId: intent.id,
    name: 'Exact GitHub approval',
    statement: 'Selected account and source only.',
    checkIds: [],
    reviewers: [],
    githubReview: { target: { kind: 'publication', id: publicationId }, accountIds: [42] },
    ...patch,
  });
  const assess = policy =>
    dispatch(
      {
        action: 'assess-invariant',
        id: policy.id,
        definition: policy.definition,
        viewId: view.id,
        expectedHead: view.head,
      },
      0,
    );
  const accept = (policy, patch = {}) => ({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'reviewed',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
    ...(policy ? { invariant: { id: policy.id, definition: policy.definition } } : {}),
    ...patch,
  });
  const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').length : 0);
  return {
    root,
    work,
    local,
    intent,
    lane,
    view,
    publicationId,
    dispatch,
    define,
    assess,
    accept,
    approval,
    change,
    calls,
  };
}

test('exact current GitHub User account decisions stay separate from labels, drafts, comments, bots, withdrawals and other commits', async t => {
  const s = setup(t),
    policy = (
      await s.dispatch(
        s.define({
          githubReview: { target: { kind: 'publication', id: s.publicationId }, accountIds: [42, 42] },
        }),
      )
    ).result;
  assert.deepEqual(policy.githubReview.accountIds, [42]);
  s.local({
    action: 'review-view',
    viewId: s.view.id,
    expectedHead: s.view.head,
    reviewer: '42',
    decision: 'approve',
    invariant: { id: policy.id, definition: policy.definition },
  });
  write(s.root, 'a.ts', 'Unfinished owner source');
  write(s.work.store.path(s.lane.id), 'a.ts', 'Unfinished Lane source');
  const original = readWorkBytes(join(s.work.store.directory, 'work.json')),
    refs = git(s.root, ['for-each-ref']);
  const valid = (await s.assess(policy)).result;
  assert.equal(valid.satisfied, true);
  assert.equal(valid.githubReview.reviews[0].reviewId, 201);
  assert.equal(valid.githubReview.reviews[0].login, '<literal-account>');
  assert.match(valid.coverage, /physical human/);
  for (const reviews of [
    [],
    [s.approval({ state: 'COMMENTED' })],
    [s.approval({ state: 'PENDING', submitted_at: null })],
    [s.approval({ user: null })],
    [s.approval({ user: { id: 42, login: 'bot', type: 'Bot' } })],
    [s.approval({ user: { id: 43, login: 'same-label', type: 'User' } })],
    [s.approval({ state: 'DISMISSED' })],
    [s.approval({ commit_id: 'c'.repeat(40) })],
    [s.approval(), s.approval({ id: 202, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-02T00:01:00Z' })],
  ]) {
    s.change({ reviews });
    assert.equal((await s.assess(policy)).result.satisfied, false);
  }
  s.change({
    reviews: [
      s.approval(),
      s.approval({ id: 202, state: 'COMMENTED', submitted_at: '2026-10-02T00:01:00Z' }),
    ],
  });
  assert.equal(
    (await s.assess(policy)).result.satisfied,
    true,
    'A later comment does not withdraw the existing approval.',
  );
  s.change({ head: 'b'.repeat(40), reviews: [s.approval()] });
  assert.equal((await s.assess(policy)).result.satisfied, false);
  s.change({ head: s.view.head, drift: true });
  assert.equal((await s.assess(policy)).result.githubReview.complete, false);
  s.change({ drift: false, malformed: true });
  await assert.rejects(s.assess(policy), code('INVALID_REVIEW'));
  s.change({ malformed: false, badPull: true });
  await assert.rejects(s.assess(policy), code('PUBLICATION_CHANGED'));
  s.change({ badPull: false, denied: true });
  await assert.rejects(s.assess(policy), code('PUBLISH_GITHUB_FAILED'));
  assert.deepEqual(readWorkBytes(join(s.work.store.directory, 'work.json')), original);
  assert.equal(git(s.root, ['for-each-ref']), refs);
  assert.equal(readFileSync(join(s.root, 'a.ts'), 'utf8'), 'Unfinished owner source');
  assert.equal(readFileSync(join(s.work.store.path(s.lane.id), 'a.ts'), 'utf8'), 'Unfinished Lane source');
});

test('native optional Channel acceptance reobserves withdrawn decisions and reconciles original committed receipts without provider access', async t => {
  const s = setup(t),
    input = s.define(),
    policy = (await s.dispatch(input)).result;
  assert.equal((await s.dispatch(input, 0)).result.definition, policy.definition);
  await assert.rejects(
    s.dispatch({ ...input, githubReview: { ...input.githubReview, accountIds: [43] } }, 0),
    code('WORK_OPERATION_CHANGED'),
  );
  const reads = s.calls();
  await assert.rejects(s.dispatch(s.accept(policy), 0), code('WORK_STALE'));
  assert.equal(s.calls(), reads);
  s.change({ denied: true });
  assert.equal(
    (await s.dispatch(s.accept(undefined, { channel: 'unconditioned' }))).result.status,
    'accepted',
  );
  await assert.rejects(s.dispatch(s.accept(policy)), code('PUBLISH_GITHUB_FAILED'));
  assert.equal(s.work.status().channelMoves.length, 1);
  s.change({ denied: false });
  const pending = s.accept(policy),
    save = s.work.store.save.bind(s.work.store);
  s.work.store.save = data => {
    save(data);
    throw new Error('Lost pending journal');
  };
  await assert.rejects(s.dispatch(pending), /Lost pending journal/);
  s.work.store.save = save;
  s.change({ reviews: [s.approval({ state: 'DISMISSED' })] });
  await assert.rejects(s.dispatch(pending, 0), code('INVARIANT_UNSATISFIED'));
  assert.throws(() => git(s.root, ['rev-parse', 'refs/forge/channels/reviewed']));
  s.change({ reviews: [s.approval()] });
  s.work.store.save = data => {
    if (data.channelMoves.at(-1).status === 'accepted') throw new Error('Lost accepted reply');
    save(data);
  };
  await assert.rejects(s.dispatch(pending, 0), /Lost accepted reply/);
  s.work.store.save = save;
  assert.equal(
    git(s.root, ['rev-parse', `refs/forge/channel-moves/${pending.operationId}`]).trim(),
    s.view.head,
  );
  s.change({ denied: true });
  const count = s.calls();
  await s.dispatch(
    s.define({
      invariantId: policy.id,
      expectedDefinition: policy.definition,
      githubReview: undefined,
      statement: 'Later definition',
    }),
  );
  const result = (await s.dispatch(pending, 0)).result;
  assert.equal(result.status, 'accepted');
  assert.equal(result.invariant.githubReview.reviews[0].reviewId, 201);
  assert.equal(s.calls(), count);
  await assert.rejects(s.dispatch({ ...pending, expectedHead: 'b'.repeat(40) }, 0), code('CHANNEL_CHANGED'));
  assert.equal(s.calls(), count);
});
