// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { assertLandingProgress } from './landing-progress-invariant.mjs';
import { compose } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const landings = await import(moduleUrl('../convex/projectHostedLanding.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
async function drainActive(f) {
  for (let n = 0; ; n++) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:'));
    if (!task) return;
    assert(n < 1000, 'bounded event-driven source and queue progress');
    await f.execute(task);
  }
}
async function orderedPrefix(t, { concurrency = 6, landingMode = 'strict', contents, baselineFiles } = {}) {
  const f = await batchesFixture(t, {
    baselineFiles,
    count: 2,
    fileCount: 2,
    admissionCheck: 'full',
    batchMaxSize: null,
    concurrency,
    landingMode,
    memberPaths: ['build.rs', 'src/shared.ts', 'src/shared.ts'],
    memberContents: contents ?? ['root build', 'first addition', 'distinct addition'],
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  await drainActive(f);
  const rootRow = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === f.entries[0].state.id,
  );
  const rootRun = f.runs().find(run => run.id === rootRow.admission.runId);
  if (landingMode === 'fast') {
    // Fast admissions stay independent. Let accepted global-risk work require the
    // second entry's ordinary exact recheck; that recheck now holds queue order.
    await f.rawChecks.pass(await f.rawChecks.activate(rootRun.id));
    await drainActive(f);
    const pending = [...f.tables.projectHostedLandingRequests.values()].find(
      row => row.submissionId === f.entries[1].state.id,
    );
    if (pending.admitting) {
      await f.rawChecks.pass(await f.rawChecks.activate(pending.admission.runId));
      await drainActive(f);
    }
  }
  const row = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === f.entries[1].state.id,
  );
  assert.equal(row.orderLive, true, 'the predecessor already holds queue order, unlike an admission');
  const predecessorRun = f.runs().find(run => run.id === row.runId);
  assert(predecessorRun && !predecessorRun.cancelRequested);
  return { f, rootRun, predecessorRun, checks: f.runs().length, rootSettled: landingMode === 'fast' };
}

for (const failed of [false, true])
  for (const concurrency of [2, 6])
    for (const landingMode of ['strict', 'fast'])
      test(`C1 wasted checks: overlapping admission composes before spending a check, predecessor fails=${failed}, width=${concurrency}, mode=${landingMode}`, async t => {
        const { f, rootRun, predecessorRun, checks, rootSettled } = await orderedPrefix(t, {
          concurrency,
          landingMode,
        });
        await f.add(2);
        assert.equal(f.runs().length, checks, 'the follower spends no independent admission check');
        await drainActive(f);
        if (!rootSettled) await f.rawChecks.pass(await f.rawChecks.activate(rootRun.id));
        await drainActive(f);
        const follower = await f.current(f.entries[2].state.id);
        assert.equal(follower.submission.phase, 'queued');
        assertLandingProgress(f, {
          externalRuns: new Set(
            f
              .runs()
              .filter(run => ['queued', 'running'].includes(run.status))
              .map(run => run.id),
          ),
        });
        assert.equal(follower.wouldConflict.code, 'COMPOSITION_CONFLICT');
        assert.equal(follower.wouldConflict.predecessor.submissionId, f.entries[1].state.id);
        if (failed) await f.fail(predecessorRun.id);
        else await f.rawChecks.pass(await f.rawChecks.activate(predecessorRun.id));
        await drainActive(f);
        if (failed) {
          for (let n = 0; states(f)[2].observation.state === 'pending'; n++) {
            assert(n < 12, 'failed predecessor releases bounded successor recovery');
            for (const run of f.runs().filter(run => run.status === 'queued' && !run.cancelRequested)) {
              const tree = JSON.parse(f.c.objects.get(run.request.expectedHead));
              const file = tree.files.find(file => file.path === 'src/shared.ts');
              const text = file && f.c.objects.get(file.blob).toString();
              if (text === 'first addition') await f.fail(run.id);
              else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
            }
            await drainActive(f);
          }
          assert.equal(
            states(f)[2].phase,
            'landed',
            'failed predecessor never denies original follower source',
          );
        } else {
          assert.equal(states(f)[2].phase, 'terminal-failed');
          assert.equal(states(f)[2].error.code, 'COMPOSITION_CONFLICT');
          assert.equal(f.runs().length, checks, 'conflicting follower spends zero checks');
        }
      });

test('C1 overlap cost: mergeable same-file edits keep both changes with bounded checks and no idle work', async t => {
  const base = 'export const left = 0;\n\n// middle\n\nexport const right = 0;\n';
  const f = await batchesFixture(t, {
    count: 2,
    fileCount: 2,
    admissionCheck: 'full',
    batchMaxSize: null,
    baselineFiles: [['src/shared.ts', base]],
    memberPaths: ['src/shared.ts', 'src/shared.ts'],
    memberContents: [base.replace('left = 0', 'left = 1'), base.replace('right = 0', 'right = 1')],
  });
  await drainActive(f);
  for (let n = 0; states(f).some(s => s.phase !== 'landed'); n++) {
    assert(n < 8, 'source and check completion make bounded progress');
    for (const run of f.runs().filter(r => r.status === 'queued' && !r.cancelRequested))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drainActive(f);
  }
  const main = JSON.parse(f.c.objects.get(f.currentMain().head));
  const file = main.files.find(file => file.path === 'src/shared.ts');
  const text = f.c.objects.get(file.blob).toString('utf8');
  assert.match(text, /left = 1/);
  assert.match(text, /right = 1/);
  assert.equal(f.pending().length, 0, 'settled work has zero calls or timers');
  const budget = {
    calls: f.counts.length,
    reads: f.counts.reduce((n, c) => n + c.documents, 0),
    writes: f.counts.reduce((n, c) => n + c.writes, 0),
    readBytes: f.counts.reduce((n, c) => n + c.readBytes, 0),
    writeBytes: f.counts.reduce((n, c) => n + c.writeBytes, 0),
    runs: f.runs().length,
  };
  t.diagnostic(JSON.stringify(budget));
  assert.equal(budget.runs, 3, 'independent admissions retain their own checks and exact combined recheck');
});

for (const conflict of [false, true])
  test(`C1 accepted-ahead: main moving during source preparation is composed before admission, conflict=${conflict}`, async t => {
    const f = await batchesFixture(t, { count: 0, admissionCheck: 'full' });
    const files = JSON.parse(f.c.objects.get(f.c.baseline.sha256)).files;
    const changed = f.c.file('a.txt', 'ours\nb\nc\n');
    const head = f.c.state(
      files.map(file => (file.path === 'a.txt' ? changed : file)),
      [f.c.baseline.sha256],
    );
    const lane = await f.c.lane(head);
    for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
      for (const row of f.tables[table].values())
        if (row.kind === 'lane' && row.key === lane.laneId) f.patch(table, row._id, { ownerOnly: true });
    const selection = f.c.selection([lane]);
    const old = f.currentMain();
    selection.request.expectedMain = { head: old.head, receiptId: old.receipt.id };
    const candidate = await compose(f.c, selection);
    const request = f.request({
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      expectedMain: selection.request.expectedMain,
      governanceVersion: 1,
      finish: { composeOperationId: selection.request.operationId, after: null },
    });
    f.moveMain({ overlap: conflict });
    const state = await f.transaction(
      'source-completed-on-old-main',
      {
        _handler: ctx =>
          landings.enqueueHostedLanding(
            ctx,
            { projectId: f.projectId },
            request,
            { kind: 'agent', id: 'owner' },
            { submissionId: randomUUID(), attemptId: randomUUID() },
          ),
      },
      {},
    );
    assert.equal(f.runs().length, 0, 'already-accepted work is considered before spending admission');
    await drainActive(f);
    if (conflict) {
      const result = (await f.current(state.id)).submission;
      assert.equal(result.phase, 'terminal-failed');
      assert.equal(result.error.code, 'COMPOSITION_CONFLICT');
      assert.equal(f.runs().length, 0, 'a known-main conflict spends zero checks');
    } else {
      assert.equal(f.runs().length, 1);
      const run = f.runs()[0];
      const tree = JSON.parse(f.c.objects.get(run.request.expectedHead));
      assert(
        tree.files.some(file => file.path === 'accepted.txt'),
        'the checked tree includes accepted work',
      );
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      await drainActive(f);
      assert.equal((await f.current(state.id)).submission.phase, 'landed');
    }
  });

for (const landingMode of ['strict', 'fast'])
  test(`C1 ordered overlap cost: exact combined source preserves both edits with no discarded follower admission, mode=${landingMode}`, async t => {
    const base = 'export const left = 0;\n\n// middle\n\nexport const right = 0;\n';
    const { f } = await orderedPrefix(t, {
      landingMode,
      baselineFiles: [['src/shared.ts', base]],
      contents: ['root build', base.replace('left = 0', 'left = 1'), base.replace('right = 0', 'right = 1')],
    });
    await f.add(2);
    await drainActive(f);
    for (let n = 0; states(f).some(s => s.phase !== 'landed'); n++) {
      assert(n < 10, 'ordered source and exact checks make bounded progress');
      for (const run of f.runs().filter(run => run.status === 'queued' && !run.cancelRequested))
        await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      await drainActive(f);
    }
    const tree = JSON.parse(f.c.objects.get(f.currentMain().head));
    const text = f.c.objects.get(tree.files.find(file => file.path === 'src/shared.ts').blob).toString();
    assert.match(text, /left = 1/);
    assert.match(text, /right = 1/);
    assert.equal(f.pending().length, 0);
    const budget = {
      mode: landingMode,
      passedChecks: f.runs().filter(run => run.status === 'passed').length,
      calls: f.counts.length,
      reads: f.counts.reduce((n, c) => n + c.documents, 0),
      writes: f.counts.reduce((n, c) => n + c.writes, 0),
      readBytes: f.counts.reduce((n, c) => n + c.readBytes, 0),
      writeBytes: f.counts.reduce((n, c) => n + c.writeBytes, 0),
      runs: f.runs().length,
    };
    t.diagnostic(JSON.stringify(budget));
    assert.equal(
      budget.runs,
      landingMode === 'fast' ? 4 : 3,
      'ordered overlap removes the discarded solo-admission check',
    );
    assert.equal(
      f.runs().filter(run => run.status === 'passed').length,
      3,
      'both modes execute three passing checks; Fast retains its cancelled prefix admission',
    );
  });
