// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { composeFixture, api as composeApi, jobApi as composeJobs } from './hosted-compose-fixture.mjs';
import { syncFixture, api as syncApi, jobApi as syncJobs } from './hosted-sync-fixture.mjs';

for (const kind of ['compose', 'sync', 'resolve'])
  test(`${kind} exposes worker failure before parent completion and retains same-operation terminal replay`, async () => {
    const s = await syncFixture();
    let request, operationId, api, jobApi, submit;
    if (kind === 'compose') {
      const lane = await s.lane(s.state([s.file('a.txt', 'chosen\n'), s.hidden], [s.baseline.sha256]));
      const x = s.selection([lane]);
      await s.prepare(x);
      await s.stage(x);
      request = x;
      operationId = x.request.operationId;
      api = composeApi;
      jobApi = composeJobs;
      submit = () => s.submit(x);
    } else {
      let lane;
      if (kind === 'resolve') {
        const { candidate } = await s.conflict();
        const draft = await s.execute(
          s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts }),
        );
        lane = (await s.readLane(draft.terminal.outcome.result.lane.laneId)).entry;
      } else lane = await s.lane(s.baseline);
      request = s.request(kind, {
        laneId: lane.laneId,
        expected: s.pins(lane),
        ...(kind === 'sync'
          ? { target: { kind: 'main', head: s.main.head, receiptId: s.main.receipt.id } }
          : {}),
      });
      operationId = request.operationId;
      await s.prepareSync(request);
      api = syncApi;
      jobApi = syncJobs;
      submit = () => s.submitSync(request);
    }
    const submitted = await submit();
    const job = await s.activate(submitted.jobId);
    await s.callback(job, { status: 'failed', code: 'SOURCE_WORKER_FAILED' });
    const args = { projectId: s.projectId, operationId };
    const progress = () => s.call('failureProgress', api.progress, args).then(JSON.parse);
    const failed = await progress();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'SOURCE_WORKER_FAILED');
    assert.match(failed.failedPhase, /^source-(compose|sync)$/);
    assert.equal(failed.terminal, null, 'failure is visible before the completion action runs');
    assert.equal(
      (await submit()).status,
      'failed',
      'same operation never hides a failed job behind submitted',
    );
    await s.call('failureComplete', jobApi.resultDownload, { projectId: s.projectId, jobId: job.id });
    const terminal = (await progress()).terminal;
    assert.equal(terminal.outcome.status, 'failed');
    assert.equal(terminal.outcome.error.code, 'SOURCE_WORKER_FAILED');
    assert.deepEqual(await submit(), terminal);
    await assert.rejects(
      s.call('deniedProgress', api.progress, args, null),
      e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE',
    );
  });

test('one selected progress read stays constant at dogfood history size and writes nothing', async t => {
  const s = await composeFixture();
  const lane = await s.lane(s.baseline),
    x = s.selection([lane]);
  await s.prepare(x);
  await s.stage(x);
  const submitted = await s.submit(x);
  await s.activate(submitted.jobId);
  const { _id, _creationTime, ...head } = [...s.tables.projectHostedRecordHeads.values()][0];
  void _id;
  void _creationTime;
  // Larger than the retained dogfood Lane + Intent + checkpoint set, unrelated to this job.
  for (let i = 0; i < 4000; i++) s.insert('projectHostedRecordHeads', { ...head, key: randomUUID() });
  const start = performance.now();
  const result = JSON.parse(
    await s.call('scaleProgress', composeApi.progress, {
      projectId: s.projectId,
      operationId: x.request.operationId,
    }),
  );
  const elapsedMs = performance.now() - start;
  assert.equal(result.jobId, submitted.jobId);
  const reads = s.counts.filter(c => c.name === 'scaleProgress');
  assert.equal(reads.length, 1, 'one public function call');
  const c = reads[0];
  assert(c.documents <= 20 && c.ranges <= 12, JSON.stringify(c));
  assert.equal(c.writes, 0);
  assert(c.readBytes < 32768, JSON.stringify(c));
  t.diagnostic(
    JSON.stringify({
      calls: 1,
      documents: c.documents,
      ranges: c.ranges,
      readBytes: c.readBytes,
      writes: c.writes,
      elapsedMs,
      rss: process.memoryUsage().rss,
      peakRss: process.resourceUsage().maxRSS * 1024,
    }),
  );
});
