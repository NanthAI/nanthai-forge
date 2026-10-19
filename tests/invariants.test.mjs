// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';

function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const work = new WorkService(root);
  const local = command => work.execute(command, work.status().revision).result;
  const dispatch = (command, revision = work.status().revision) => work.dispatch(command, revision);
  const intent = local({ action: 'intent', outcome: 'Assess named evidence on exact source' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const compose = () =>
    local({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: work.status().lanes[0].actualHead }],
    });
  const view = compose();
  const define = (patch = {}) => ({
    action: 'define-invariant',
    operationId: randomUUID(),
    invariantId: randomUUID(),
    intentId: intent.id,
    name: 'Named outcome',
    statement: 'Synthetic statement; this is not a proof.',
    checkIds: [],
    reviewers: [],
    ...patch,
  });
  const assess = (policy, pin = view) =>
    dispatch(
      {
        action: 'assess-invariant',
        id: policy.id,
        definition: policy.definition,
        viewId: pin.id,
        expectedHead: pin.head,
      },
      0,
    );
  const review = (policy, decision = 'approve', pin = view) =>
    local({
      action: 'review-view',
      viewId: pin.id,
      expectedHead: pin.head,
      reviewer: 'Owner label',
      decision,
      ...(policy ? { invariant: { id: policy.id, definition: policy.definition } } : {}),
    });
  const accept = (policy, patch = {}) => ({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
    ...(policy ? { invariant: { id: policy.id, definition: policy.definition } } : {}),
    ...patch,
  });
  async function run(check, pin = view) {
    const command = {
      action: 'run-check',
      operationId: randomUUID(),
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: work.status().environment.fingerprint,
      viewId: pin.id,
      expectedHead: pin.head,
    };
    await dispatch(command);
    for (let n = 0; n < 200; n++) {
      const result = work.status().runs.find(item => item.id === command.operationId);
      if (result.endedAt) return result;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Run did not finish');
  }
  return { root, work, local, dispatch, intent, lane, compose, view, define, assess, review, accept, run };
}

test('immutable Invariant versions reconcile original writes, reject changed scopes and keep policy reviews independent', async t => {
  const { work, local, dispatch, define, assess, review, view, compose, intent } = setup(t);
  const input = define({ reviewers: ['Owner label', 'Owner label'] }),
    save = work.store.save.bind(work.store);
  work.store.save = data => {
    save(data);
    throw new Error('Lost definition reply');
  };
  await assert.rejects(dispatch(input), /Lost definition reply/);
  work.store.save = save;
  const first = (await dispatch(input, 0)).result;
  assert.equal(first.version, 1);
  assert.deepEqual(first.reviewers, ['Owner label']);
  await assert.rejects(dispatch({ ...input, statement: 'Changed' }, 0), code('WORK_OPERATION_CHANGED'));
  review();
  assert.equal((await assess(first)).result.satisfied, false);
  const approval = review(first);
  assert.equal((await assess(first)).result.reviews[0].reviewId, approval.id);
  assert.equal((await assess(first)).result.satisfied, true);
  review(first, 'request-changes');
  assert.equal((await assess(first)).result.satisfied, false);
  review(first);
  const second = (
    await dispatch(
      define({
        invariantId: first.id,
        expectedDefinition: first.definition,
        name: first.name,
        statement: 'Updated meaning',
        reviewers: ['Owner label'],
      }),
    )
  ).result;
  assert.equal(second.version, 2);
  assert.equal((await assess(second)).result.satisfied, false);
  assert.equal((await assess(first)).result.currentPolicy, false);
  assert.equal((await assess(first)).result.satisfied, false);
  assert.throws(() => review(first), code('INVARIANT_CHANGED'));
  const third = (
    await dispatch(
      define({
        invariantId: second.id,
        expectedDefinition: second.definition,
        name: first.name,
        statement: first.statement,
        reviewers: first.reviewers,
      }),
    )
  ).result;
  assert.notEqual(third.definition, first.definition);
  assert.equal(third.version, 3);
  assert.equal((await dispatch(input, 0)).result.definition, first.definition);
  assert.equal(work.status().invariants.length, 3);
  await assert.rejects(
    dispatch(define({ invariantId: third.id, expectedDefinition: first.definition })),
    code('INVARIANT_CHANGED'),
  );
  await assert.rejects(dispatch(define({ checkIds: [randomUUID()] })), code('NOT_FOUND'));
  const other = local({ action: 'intent', outcome: 'Other policy scope' });
  await assert.rejects(
    dispatch(define({ invariantId: third.id, expectedDefinition: third.definition, intentId: other.id })),
    code('INVARIANT_CHANGED'),
  );
  review(third);
  const sameHead = compose();
  assert.equal(sameHead.head, view.head);
  assert.equal((await assess(third, sameHead)).result.satisfied, false);
  assert.equal((await assess(third)).result.satisfied, true); // Explicit old View stays assessable, without inheritance to its successor.
  assert.equal(work.status().intents.find(item => item.id === intent.id).status, 'active');
});

test('latest outcomes and exact source, definitions and runtime determine assessment without running or mutating work', async t => {
  const { root, work, local, dispatch, define, assess, run, lane, view, compose } = setup(t);
  const marker = join(root, '.git/outcome');
  writeFileSync(marker, '0');
  const check = local({
    action: 'define-check',
    name: 'Explicit synthetic command',
    executable: process.execPath,
    args: ['-e', `process.exit(Number(require('node:fs').readFileSync(${JSON.stringify(marker)},'utf8')))`],
  });
  const policy = (await dispatch(define({ checkIds: [check.id, check.id] }))).result;
  assert.equal((await assess(policy)).result.checks[0].status, 'missing');
  write(work.store.path(lane.id), 'a.ts', 'unfinished Lane edits');
  write(root, 'a.ts', 'unfinished owner edits');
  git(root, ['add', 'a.ts']);
  const head = git(root, ['rev-parse', 'HEAD']),
    index = git(root, ['write-tree']);
  const first = await run(check);
  assert.equal(first.status, 'passed');
  assert.equal((await assess(policy)).result.satisfied, true);
  const before = readWorkBytes(join(work.store.directory, 'work.json'));
  await assess(policy);
  assert.deepEqual(readWorkBytes(join(work.store.directory, 'work.json')), before);
  assert.equal(work.status().runs.length, 1);
  const snapshot = work.store.load();
  for (const status of ['running', 'preparing', 'cancelled', 'interrupted', 'failed']) {
    const data = structuredClone(snapshot);
    data.runs[0].status = status;
    data.runs[0].runner.pid = process.pid;
    work.store.save(data);
    const observed = (await assess(policy)).result;
    assert.equal(observed.satisfied, false);
    assert.equal(observed.checks[0].status, ['running', 'preparing'].includes(status) ? 'pending' : status);
  }
  for (const patch of [
    { head: '0'.repeat(40) },
    { base: '0'.repeat(40) },
    { inputs: [] },
    { dependencies: [{ kind: 'view', viewId: view.id, head: view.head }] },
    { cancelRequested: true },
    { endedAt: undefined },
    { exitCode: 7 },
  ]) {
    const data = structuredClone(snapshot);
    Object.assign(data.runs[0], patch);
    work.store.save(data);
    assert.equal((await assess(policy)).result.checks[0].status, 'stale');
  }
  work.store.save(snapshot);
  const tz = process.env.TZ;
  try {
    process.env.TZ = 'Etc/GMT+5';
    assert.equal((await assess(policy)).result.checks[0].status, 'stale');
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
  assert.equal((await assess(policy)).result.satisfied, true);
  writeFileSync(marker, '7');
  assert.equal((await run(check)).status, 'failed');
  assert.equal((await assess(policy)).result.checks[0].status, 'failed'); // Never fall back to an older pass.
  writeFileSync(marker, '0');
  await run(check);
  const changed = local({
    action: 'define-check',
    checkId: check.id,
    name: check.name,
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });
  assert.equal((await assess(policy)).result.checks[0].status, 'stale');
  await run(changed);
  const next = compose();
  assert.equal(next.head, view.head);
  assert.equal((await assess(policy, next)).result.checks[0].status, 'missing');
  assert.equal((await assess(policy)).result.satisfied, true);
  git(root, ['update-ref', `refs/forge/views/${view.id}`, 'HEAD']); // The fixture head coincides; a missing ref still cannot pass.
  git(root, ['update-ref', '-d', `refs/forge/views/${view.id}`]);
  await assert.rejects(assess(policy), code('WORK_GIT_FAILED'));
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
  assert.equal(git(root, ['write-tree']), index);
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'unfinished Lane edits');
});

test('explicit Channel policy blocks only selected acceptance, rechecks pending writes and reconciles committed receipts after policy changes', async t => {
  const { root, work, dispatch, define, assess, review, accept } = setup(t);
  const policy = (await dispatch(define({ reviewers: ['Owner label'] }))).result;
  await assert.rejects(dispatch(accept(policy)), code('INVARIANT_UNSATISFIED'));
  assert.equal(work.store.load().channelMoves.length, 0);
  assert.equal((await dispatch(accept(undefined, { channel: 'unconditioned' }))).result.status, 'accepted');
  review(policy);
  assert.equal((await assess(policy)).result.satisfied, true);
  const pending = accept(policy),
    save = work.store.save.bind(work.store);
  work.store.save = data => {
    save(data);
    throw new Error('Lost pending journal');
  };
  await assert.rejects(dispatch(pending), /Lost pending journal/);
  work.store.save = save;
  assert.throws(() => git(root, ['rev-parse', 'refs/forge/channels/main']));
  review(policy, 'request-changes');
  await assert.rejects(dispatch(pending, 0), code('INVARIANT_UNSATISFIED'));
  assert.equal(work.store.load().channelMoves.at(-1).status, 'pending');
  await assert.rejects(dispatch({ ...pending, invariant: undefined }, 0), code('CHANNEL_CHANGED'));
  review(policy);
  work.store.save = data => {
    if (data.channelMoves.at(-1).status === 'accepted') throw new Error('Lost accepted journal');
    save(data);
  };
  await assert.rejects(dispatch(pending, 0), /Lost accepted journal/);
  work.store.save = save;
  assert.equal(
    git(root, ['rev-parse', `refs/forge/channel-moves/${pending.operationId}`]).trim(),
    pending.expectedHead,
  );
  const updated = (
    await dispatch(
      define({
        invariantId: policy.id,
        expectedDefinition: policy.definition,
        reviewers: ['Owner label'],
        statement: 'Changed after native receipt',
      }),
    )
  ).result;
  await dispatch(accept(undefined, { expectedPrevious: pending.expectedHead }));
  const reconciled = (await dispatch(pending, 0)).result;
  assert.equal(reconciled.status, 'accepted');
  assert.equal(reconciled.invariant.policy.definition, policy.definition);
  assert.equal(reconciled.invariant.reviews[0].decision, 'approve');
  assert.equal(reconciled.invariant.satisfied, true);
  assert.notEqual(work.status().channels.find(item => item.name === 'main').moveId, pending.operationId);
  await assert.rejects(
    dispatch(accept(policy, { expectedPrevious: pending.expectedHead })),
    code('INVARIANT_UNSATISFIED'),
  );
  assert.equal((await assess(updated)).result.satisfied, false);
  review(updated);
  const racing = accept(updated, { channel: 'policy-race' });
  work.store.save = data => {
    save(data);
    throw new Error('Lost policy-race journal');
  };
  await assert.rejects(dispatch(racing), /Lost policy-race journal/);
  work.store.save = save;
  await dispatch(
    define({
      invariantId: updated.id,
      expectedDefinition: updated.definition,
      statement: 'Changed before native acceptance',
    }),
  );
  await assert.rejects(dispatch(racing, 0), code('INVARIANT_UNSATISFIED'));
  assert.throws(() => git(root, ['rev-parse', `refs/forge/channel-moves/${racing.operationId}`]));
  assert.throws(() => git(root, ['rev-parse', 'refs/forge/channels/policy-race']));
});

test('HTTP capability and CLI expose the same optional policy commands without a second metadata owner', async t => {
  const { root, work, view, define } = setup(t);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`,
    headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const command = define(),
    body = JSON.stringify({ command, revision: work.status().revision });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://outside.invalid' }, body }))
      .status,
    403,
  );
  const policy = (await (await fetch(url, { method: 'POST', headers, body })).json()).result;
  const assessment = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'work',
        root,
        JSON.stringify({
          action: 'assess-invariant',
          id: policy.id,
          definition: policy.definition,
          viewId: view.id,
          expectedHead: view.head,
        }),
        '0',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(assessment.result.satisfied, true);
  assert.equal(assessment.result.checks.length, 0);
  assert.match(assessment.result.coverage, /not verified identity/);
  assert.equal(work.status().invariants.length, 1);
  assert.equal(work.status().runs.length, 0);
});
