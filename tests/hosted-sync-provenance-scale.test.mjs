// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { syncFixture } from './hosted-sync-fixture.mjs';

// The original page validation is paid once by compose. Recovery must reuse its
// authenticated aggregate, not fetch all manifests or reconstruct project history.
test('575 selected inputs recover with constant metadata calls and publication reuses their proof', async t => {
  const started = performance.now();
  const s = await syncFixture();
  const inputs = [];
  for (const text of ['left\n', 'right\n']) {
    const lane = await s.lane(s.baseline);
    inputs.push(await s.save(lane, [s.file('a.txt', text), s.hidden]));
  }
  for (let i = inputs.length; i < 575; i++) inputs.push(await s.lane(s.baseline));
  const selected = s.selection(inputs);
  await s.prepare(selected);
  await s.stage(selected);
  await s.submit(selected);
  const candidate = (await s.publish(await s.work(selected))).outcome.result;
  assert.equal(candidate.result.status, 'conflict');
  assert.equal(selected.request.inputs.pages, 6);
  const originalStages = s.counts.filter(c => c.name === 'composeStage');
  assert.equal(originalStages.length, 7, 'six input pages and one empty dependency page');
  // Twice the retained dogfood records, none with readable canonical source.
  for (const [kind, count] of [
    ['intent', 1200],
    ['lane', 1120],
    ['save', 5600],
    ['candidate', 4400],
    ['job', 3000],
  ])
    for (let i = 0; i < count; i++)
      s.insert('projectHostedRecordHeads', {
        projectId: s.projectId,
        kind,
        key: `unselected-${kind}-${i}`,
        version: 0,
        parent: '',
        status: 'unselected',
        recordId: 'unreadable-unselected-record',
      });
  const r = s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts });
  const recoveryStart = performance.now(),
    start = s.counts.length;
  const first = await s.prepareSync(r);
  assert.equal(first.state.ownerInputs, true);
  const preparation = s.counts.slice(start);
  assert.equal(preparation.length, 1, 'one preparation RPC for the retained aggregate');
  await s.submitSync(r);
  const output = await s.workSync(r);
  const beforePublish = s.counts.length;
  const result = await s.publishSync(output);
  const publication = s.counts.slice(beforePublish);
  assert.equal(publication.length, 1);
  for (const call of [...preparation, ...publication]) {
    assert(call.documents <= 100);
    assert(call.readBytes < 128 * 1024);
    assert(
      !call.touched.some(table =>
        [
          'projectHostedComposePages',
          'projectHostedComposeSelections',
          'projectWorkRecords',
          'projectWorkEvents',
          'projectWorkGenerations',
          'projectBackups',
        ].includes(table),
      ),
    );
  }
  const total = s.counts.slice(start);
  assert.equal(
    total.length,
    9,
    'prepare, submit/progress, worker progress/claim/reserve/load/callback, publish',
  );
  const stats = calls => ({
    calls: calls.length,
    documents: calls.reduce((sum, c) => sum + c.documents, 0),
    writes: calls.reduce((sum, c) => sum + c.writes, 0),
    readBytes: calls.reduce((sum, c) => sum + c.readBytes, 0),
  });
  const idleCalls = s.counts.length,
    idleTasks = s.scheduled.length;
  await Promise.resolve();
  assert.equal(s.counts.length, idleCalls);
  assert.equal(s.scheduled.length, idleTasks);
  assert(s.scheduled.every(task => !/poll|interval|watch|cron/i.test(task.name)));
  assert.equal(result.outcome.result.status, 'conflict');
  t.diagnostic(
    JSON.stringify({
      selected: 575,
      selectedPages: 7,
      unrelatedRecords: 15320,
      originalValidation: stats(originalStages),
      preparation: stats(preparation),
      publication: stats(publication),
      recovery: stats(total),
      recoveryMs: performance.now() - recoveryStart,
      fixtureMs: performance.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      idleCalls: 0,
      idleTasks: 0,
    }),
  );
});
