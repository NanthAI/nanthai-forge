// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { batchesFixture, batchStore, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const landingStore = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const { withdraw } = await import(moduleUrl('../convex/projectHostedLandingWithdraw.ts'));
const flag = 'FORGE_QUEUE_COHORT_KEEP_HEALTHY';
const prior = Object.fromEntries([...Object.keys(synthetic), flag].map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const row = (f, i) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === f.entries[i].state.id);
const active = f => f.runs().filter(run => ['queued', 'running'].includes(run.status));
const files = f => JSON.parse(f.c.objects.get(f.currentMain().head)).files.map(file => file.path);

for (const enabled of [false, true]) {
  test(`O3 ${enabled ? 'on' : 'off'}: an arriving member ${enabled ? 'leaves' : 'can regroup'} a live individual run`, async t => {
    process.env[flag] = enabled ? '1' : '0';
    const f = await batchesFixture(t, { count: 1 });
    await f.drain();
    const id = f.entries[0].state.id;
    const original = await f.rawChecks.activate(f.runs()[0].id);
    await f.add(1);
    const formed = await f.transaction(
      'select-new-cohort',
      {
        _handler: async ctx =>
          batchStore.formLandingBatch(
            ctx,
            { projectId: f.projectId, submissionId: id },
            await landingStore.loadLanding(ctx, { projectId: f.projectId, submissionId: id }),
          ),
      },
      {},
    );
    assert.equal(formed, !enabled);
    if (enabled) {
      assert.equal(row(f, 0).runId, original.id);
      await f.rawChecks.pass(original);
      await f.drain();
      const first = states(f).find(state => state.id === id);
      assert.equal(first.phase, 'landed');
      const receipt = [...f.tables.projectHostedAcceptances.values()].find(
        row => row.receiptId === first.acceptance.receiptId,
      );
      assert.equal(JSON.parse(receipt.value).check.runId, original.id);
    }
  });

  test(`O3 ${enabled ? 'on' : 'off'}: withdrawing a member ${enabled ? 'keeps survivors together' : 'uses serial fallback'}`, async t => {
    process.env[flag] = enabled ? '1' : '0';
    const paths = ['src/withdrawn.ts', 'src/healthy-a.ts', 'src/healthy-b.ts'];
    const f = await batchesFixture(t, { count: 3, memberPaths: paths });
    await f.drain();
    const old = await f.rawChecks.activate(f.runs()[0].id);
    const request = JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      laneId: f.entries[0].lane.laneId,
    });
    const args = { projectId: f.projectId, request };
    const receipt = JSON.parse(await f.transaction('withdraw', withdraw, args));
    assert.equal(receipt.error.code, 'LANDING_CANCELLED');
    assert.equal(receipt.batchId, undefined);
    assert.deepEqual(JSON.parse(await f.transaction('withdraw-replay', withdraw, args)), receipt);
    await f.drain();
    const replacement = active(f).find(run => run.id !== old.id);
    assert(replacement);
    const checked = JSON.parse(f.c.objects.get(replacement.request.expectedHead)).files.map(
      file => file.path,
    );
    assert(!checked.includes(paths[0]));
    assert.equal(paths.slice(1).filter(path => checked.includes(path)).length, enabled ? 2 : 1);
    for (let n = 0; n < 3 && states(f).some(state => state.observation.state === 'pending'); n++) {
      for (const run of active(f).filter(run => run.id !== old.id))
        await f.rawChecks.pass(run.status === 'queued' ? await f.rawChecks.activate(run.id) : run);
      await f.drain();
    }
    assert(
      states(f)
        .slice(1)
        .every(state => state.phase === 'landed'),
    );
    assert(!files(f).includes(paths[0]));
    assert.equal(f.runs().length, enabled ? 2 : 3);
    t.diagnostic(
      JSON.stringify({
        calls: f.counts.length,
        readBytes: f.counts.reduce((sum, cost) => sum + cost.readBytes, 0),
        writeBytes: f.counts.reduce((sum, cost) => sum + cost.writeBytes, 0),
      }),
    );
  });

  test(`O3 ${enabled ? 'on' : 'off'}: attributed static failure ${enabled ? 'keeps' : 'replaces'} healthy admission evidence`, async t => {
    process.env[flag] = enabled ? '1' : '0';
    const paths = ['src/failing.ts', 'src/healthy-a.ts', 'src/healthy-b.ts'];
    const f = await batchesFixture(t, { count: 3, admissionCheck: true, memberPaths: paths });
    const admissions = f.runs();
    assert.equal(admissions.length, 3);
    for (const run of admissions) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.drain();
    const shared = await f.rawChecks.activate(f.runs()[3].id);
    const shard = shared.plan.shardCount - 1;
    f.insert('projectHostedOutputStreams', {
      projectId: f.projectId,
      runId: shared.id,
      streamId: randomUUID(),
      descriptor: JSON.stringify({ shard }),
      chunks: 0,
      bytes: 0,
      maxSequence: 0,
      seal: null,
      failureExcerpt: `${paths[0]}: error TS2322: incompatible types`,
    });
    for (let i = 0; i <= shard; i++)
      await f.rawChecks.callback(f.rawChecks.shard(shared, i, i === shard ? 'failed' : 'passed'));
    await f.rawChecks.callback(f.rawChecks.complete(shared, 'failed'));
    while (row(f, 1).runId === shared.id && f.pending().length) await f.execute(f.pending()[0]);
    if (enabled) {
      assert.equal(row(f, 1).runId, admissions[1].id);
      assert.equal(row(f, 2).runId, admissions[2].id);
    } else {
      assert.notEqual(row(f, 1).runId, admissions[1].id);
      assert.notEqual(row(f, 2).runId, admissions[2].id);
    }
    await f.drain();
    const accepted = [...f.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value));
    assert.equal(
      accepted.some(receipt => receipt.check.runId === admissions[1].id),
      enabled,
    );
    assert(!accepted.some(receipt => receipt.check.runId === shared.id));
  });

  test(`O3 ${enabled ? 'on' : 'off'}: an unavailable admission ${enabled ? 'checks alone' : 'joins its admitted peers'}`, async t => {
    process.env[flag] = enabled ? '1' : '0';
    const f = await batchesFixture(t, { count: 3, admissionCheck: true });
    const [first, ...others] = f.runs();
    const unavailable = await f.rawChecks.activate(first.id);
    for (let i = 0; i < unavailable.plan.shardCount; i++)
      await f.rawChecks.callback(f.rawChecks.shard(unavailable, i, 'cancelled'));
    await f.rawChecks.callback(f.rawChecks.complete(unavailable, 'cancelled'));
    for (const run of others) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.drain();
    const id = f.entries[0].state.id;
    const groups = [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
    assert(groups.length > 0);
    assert.equal(
      groups.some(group => group.members.some(member => member.submissionId === id)),
      !enabled,
    );
    assert(active(f).some(run => run.request.candidateId === f.entries[0].candidate.id) || !enabled);
  });
}
