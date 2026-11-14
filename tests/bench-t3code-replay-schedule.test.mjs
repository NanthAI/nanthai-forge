// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replayPlan,
  replayDigest,
  replayExpected,
  replaySchedule,
} from '../scripts/bench-t3code/replay-schedule.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function service(options = {}) {
  const accepted = new Map();
  const tasks = new Set();
  return {
    accepted,
    tasks,
    async prepare(task) {
      return { pinned: 'synthetic-base', task: task.id };
    },
    async stage() {},
    async land(task, context) {
      assert.equal(context.task, task.id);
      assert.equal(context.pinned, 'synthetic-base');
      await options.beforeAccept?.(task);
      for (const edit of task.edits) {
        const lines = new Set((accepted.get(edit.path) ?? '').split('\n').filter(Boolean));
        for (const line of edit.text.split('\n').filter(Boolean)) lines.add(line);
        accepted.set(edit.path, [...lines].sort().join('\n') + '\n');
      }
      tasks.add(task.id);
      return { landed: true, accepted: task.id };
    },
    async readMain(paths) {
      return { head: 'synthetic-final', files: new Map(paths.map(path => [path, accepted.get(path)])) };
    },
  };
}

test('synthetic conflict topology and relative edits repeat without live identities', () => {
  const first = replayPlan();
  assert.deepEqual(first, replayPlan());
  assert.equal(replayDigest(first), replayDigest(replayPlan()));
  assert.equal(replayExpected(first).get('.bench/replay/group-triple.txt'), 's08\ns09\ns10\n');
  assert.equal(replayExpected(first).get('.bench/replay/group-pair-a.txt'), 's04\ns05\n');
  assert.equal(replayExpected(replayPlan({ independent: true })).size, 10);
  assert.notEqual(replayDigest(first), replayDigest(replayPlan({ release: 'late-third' })));
});

test('no landing starts until every workspace is staged, then independent submissions overlap', async () => {
  const staging = deferred(),
    accepting = deferred(),
    released = deferred();
  const backend = service({
    beforeAccept: async task => {
      if (task.id === 's01') await accepting.promise;
    },
  });
  backend.stage = async task => {
    if (task.id === 's10') await staging.promise;
  };
  const emitted = [];
  const run = replaySchedule(replayPlan(), backend, {
    emit: e => {
      emitted.push(e);
      if (e.event === 'accepted' && e.task === 's10') released.resolve();
    },
  });
  await Promise.resolve();
  assert.equal(backend.tasks.size, 0);
  staging.resolve();
  await released.promise;
  assert.equal(backend.tasks.size, 9);
  assert.equal(backend.tasks.has('s01'), false);
  accepting.resolve();
  const result = await run;
  assert.equal(result.results.length, 10);
  assert.equal(result.modelTokens, 0);
  assert.equal(result.scored, false);
  assert.equal(result.verifiedHead, 'synthetic-final');
  assert.equal(emitted.at(-1).event, 'verified');
});

test('preparation failure drains the other preparation and submits no partial cell', async () => {
  const gate = deferred(),
    failing = deferred();
  const backend = service();
  backend.prepare = async task => {
    if (task.id === 's01') {
      failing.resolve();
      throw Error('checkout failed');
    }
    if (task.id === 's10') await gate.promise;
    return { task: task.id };
  };
  let ended = false;
  const run = replaySchedule(replayPlan(), backend).catch(error => {
    ended = true;
    throw error;
  });
  const rejection = assert.rejects(run, /preparation failed/);
  await failing.promise;
  assert.equal(ended, false);
  assert.equal(backend.tasks.size, 0);
  gate.resolve();
  await rejection;
  assert.equal(backend.tasks.size, 0);
});

test('relative late-third schedule starts after staging and reports service-induced slip', async () => {
  let clock = 1000;
  const backend = service();
  backend.stage = async () => {
    clock += 10;
  };
  const result = await replaySchedule(replayPlan({ release: 'late-third' }), backend, {
    now: () => clock,
    sleep: async ms => {
      clock += ms + 17;
    },
  });
  const late = result.events.find(e => e.event === 'submit' && e.task === 's10');
  assert.equal(result.prepMs, 100);
  assert.equal(late.releaseAtMs, 200_000);
  assert.equal(late.atMs, 200_017);
  assert.equal(late.slipMs, 17);
});

test('a rejected landing never leaves another started landing unobserved', async () => {
  const gate = deferred(),
    failed = deferred();
  const backend = service({
    beforeAccept: async task => {
      if (task.id === 's01') {
        failed.resolve();
        throw Error('terminal failure');
      }
      if (task.id === 's10') await gate.promise;
    },
  });
  let settled = false;
  const run = replaySchedule(replayPlan(), backend).catch(error => {
    settled = true;
    throw error;
  });
  const rejection = assert.rejects(run, /landing failed/);
  await failed.promise;
  assert.equal(settled, false);
  gate.resolve();
  await rejection;
  assert.equal(backend.tasks.size, 9);
  assert.equal(backend.tasks.has('s10'), true);
});

test('an acceptance receipt cannot hide a dropped peer contribution', async () => {
  const backend = service();
  const read = backend.readMain;
  backend.readMain = async paths => {
    const source = await read(paths);
    source.files.set('.bench/replay/group-triple.txt', 's10\n');
    return source;
  };
  await assert.rejects(replaySchedule(replayPlan(), backend), /lost or changed.*group-triple/);
  assert.equal(backend.tasks.size, 10);
});

test('a missing terminal acceptance is a diagnostic failure even if the adapter returns normally', async () => {
  const backend = service();
  backend.land = async () => ({ landed: false });
  await assert.rejects(replaySchedule(replayPlan(), backend), /landing failed/);
});

test('caller mutations during preparation cannot change the pinned replay workload', async () => {
  const plan = replayPlan();
  const expectedDigest = replayDigest(plan);
  const backend = service();
  backend.prepare = async task => {
    plan.tasks[0].edits[0].text = 'changed\n';
    return { task: task.id, pinned: 'synthetic-base' };
  };
  const result = await replaySchedule(plan, backend);
  assert.equal(result.planDigest, expectedDigest);
  assert.equal(backend.accepted.get('.bench/replay/unique-s01.txt'), 's01\n');
});

test('final verification rejects source without a single pinned accepted head', async () => {
  const backend = service();
  backend.readMain = async () => ({ files: backend.accepted });
  await assert.rejects(replaySchedule(replayPlan(), backend), /one exact head/);
});
