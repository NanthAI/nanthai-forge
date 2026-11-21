// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { cliReplyLines } from '../dist/cli-reply-lines.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { slimReceipt } from '../dist/receipt-slim.js';
import { moduleUrl } from './convex-module.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { finishFixture, code } from './hosted-finish-fixture.mjs';
import { batchesFixture, batchStore, synthetic } from './hosted-landing-batches-fixture.mjs';

const api = await import(moduleUrl('../convex/projectHostedLandingAttemptHistory.ts'));
const { splitLandingBatch } = await import(moduleUrl('../convex/projectHostedLandingBatchSplit.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const read = (f, selection, actor) =>
  f.tx('landing-selection', api.read, { projectId: f.projectId, ...selection }, actor).then(JSON.parse);

test('incident replay c329d191: CLI and MCP read an exact Candidate selection and the retained origin batch phase', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await f.drain();
  const [mine, peer] = f.entries;
  const submissionId = mine.state.id;
  const prior = await read(f, { submissionId });
  const batchId = prior.batchId;
  assert(batchId, 'attempt history lets the reader find the batch ID');
  const history = await read(f, { submissionId, attemptId: mine.state.firstAttemptId });
  assert.deepEqual(history.main, mine.selection.request.expectedMain);
  assert.deepEqual(history.candidate, {
    id: mine.candidate.id,
    head: mine.candidate.result.head,
    inputs: mine.selection.request.inputs.root,
    dependencies: mine.selection.request.dependencies.root,
  });
  assert.deepEqual(history.selection, {
    inputCount: 1,
    dependencyCount: 0,
    lanes: [{ laneId: mine.lane.laneId, head: mine.lane.head }],
    nextAfterLaneId: null,
  });
  const shared = await read(f, { submissionId, attemptId: prior.currentAttemptId });
  assert.notEqual(shared.candidate.id, mine.candidate.id);
  assert.deepEqual(shared.selection, {
    inputCount: 0,
    dependencyCount: 2,
    lanes: [],
    nextAfterLaneId: null,
  });

  await f.transaction(
    'split-origin',
    {
      _handler: async ctx => {
        const key = { projectId: f.projectId, batchId };
        const { batch } = await batchStore.loadBatch(ctx, key);
        await splitLandingBatch(ctx, key, batch);
      },
    },
    {},
  );
  const { batchOriginId } = await read(f, { submissionId });
  assert(batchOriginId, 'released members keep their recorded origin batch ID');
  const cli = agentFixture(t);
  const transport = cli.transport();
  const queries = [];
  transport.query = async (name, input) => {
    queries.push(name);
    return read(f, input);
  };
  const result = slimReceipt(await hostedAgentCli(cli.root, 'queue', { batchId }, cli.address, transport));
  assert.equal(result.result.batch.phase, 'split');
  assert.deepEqual(
    result.result.batch.members,
    [mine, peer].map(entry => ({
      submissionId: entry.state.id,
      candidateId: entry.candidate.id,
      head: entry.candidate.result.head,
    })),
  );
  assert.match(cliReplyLines(['agent', cli.root, 'queue'], result)[0], /Batch .* · split/);
  assert(Buffer.byteLength(JSON.stringify(result)) < 64_000);
  const cost = f.counts.findLast(row => row.name === 'landing-selection');
  assert.equal(cost.readDocumentsByTable.projectHostedLandingBatches, 1);
  assert.equal(cost.writes, 0);
  t.diagnostic(`Batch: ${cost.documents} DB documents, ${cost.readBytes} DB bytes`);

  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      { registerTool: (name, config, call) => tools.set(name, { ...config, call }) },
      transport,
    ),
  );
  const review = tools.get('forge_review');
  const input = z.object(review.inputSchema).parse({
    command: { action: 'queue', submissionId, attemptId: mine.state.firstAttemptId },
  });
  const response = await review.call(input);
  assert(!response.isError, response.content[0].text);
  assert.deepEqual(JSON.parse(response.content[0].text), history);
  assert.deepEqual(queries, [
    'projectHostedLandingAttemptHistory:read',
    'projectHostedLandingAttemptHistory:read',
  ]);
  await assert.rejects(read(f, { batchId }, 'outsider'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(read(f, { batchId: randomUUID() }), code('NOT_FOUND'));
  await assert.rejects(
    read(f, { submissionId: peer.state.id, attemptId: mine.state.firstAttemptId }),
    code('NOT_FOUND'),
  );
  await assert.rejects(
    read(f, { submissionId, attemptId: mine.state.firstAttemptId }, 'outsider'),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('an exact attempt pages immutable Lane pins and distinguishes missing retained selection from an empty set', async t => {
  const f = await finishFixture(t, { inputCount: 35 });
  const state = await f.enqueue(f.request());
  const args = { submissionId: state.id, attemptId: state.firstAttemptId };
  const original = [...f.tables.projectHostedComposes.values()].find(
    row => row.candidateId === f.candidate.id,
  );
  const indexed = [...f.tables.projectHostedComposeSelections.values()]
    .filter(row => row.operationId === original.operationId && row.kind === 'inputs')
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  f.patch('projectHostedComposeSelections', indexed[0]._id, { head: undefined });
  const initial = await read(f, args);
  const cost = f.counts.findLast(row => row.name === 'landing-selection');
  assert.equal(cost.readDocumentsByTable.projectHostedComposeSelections, 33);
  assert.equal(cost.writes, 0);
  const bytes = Buffer.byteLength(JSON.stringify(initial));
  assert(bytes < 64_000);
  t.diagnostic(
    `35-input Candidate: ${cost.documents} DB documents, ${cost.readBytes} DB bytes, ${bytes} reply bytes`,
  );
  assert.equal(initial.selection.inputCount, 35);
  assert.deepEqual(
    initial.selection.lanes,
    indexed.slice(0, 32).map((row, i) => ({
      laneId: row.key,
      head: i === 0 ? null : row.head,
    })),
  );
  const continuation = await read(f, { ...args, afterLaneId: initial.selection.nextAfterLaneId });
  assert.deepEqual(
    continuation.selection.lanes,
    indexed.slice(32).map(row => ({ laneId: row.key, head: row.head })),
  );
  assert.equal(continuation.selection.nextAfterLaneId, null);

  for (const row of indexed) f.tables.projectHostedComposeSelections.delete(row._id);
  assert.deepEqual((await read(f, args)).selection, {
    inputCount: 35,
    dependencyCount: 0,
    lanes: null,
    nextAfterLaneId: null,
  });
  f.tables.projectHostedComposes.delete(original._id);
  const unavailable = await read(f, args);
  assert.equal(unavailable.selection, null);
  assert.deepEqual(unavailable.candidate, initial.candidate);
});

test('a recomposed Candidate reads the original indexed Lane pins even after the Lane changes', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request({ agent: false }));
  await f.drain();
  const earlier = await read(f, { submissionId: state.id, attemptId: state.firstAttemptId });
  const main = f.moveMain();
  const lane = await f.readLane(f.lane.laneId);
  await f.changeLane(lane.id, { head: main.head, sourceVersion: lane.sourceVersion + 1 });
  await f.passChecks();
  await f.drain();
  const { currentAttemptId } = await read(f, { submissionId: state.id });
  assert.notEqual(currentAttemptId, state.firstAttemptId);
  const recomposed = await read(f, { submissionId: state.id, attemptId: currentAttemptId });
  assert.notEqual(recomposed.candidate.id, earlier.candidate.id);
  assert.deepEqual(recomposed.main, { head: main.head, receiptId: main.receipt.id });
  assert.deepEqual(recomposed.selection, earlier.selection);
  assert.deepEqual(recomposed.selection.lanes, [{ laneId: f.lane.laneId, head: f.lane.head }]);
});

test('a retained batch conflict Candidate reads the member’s original selection with matching roots', async t => {
  const f = await batchesFixture(t, { conflict: true });
  await f.drain();
  await f.passChecks();
  await f.drain();
  const failed = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.phase === 'terminal-failed',
  );
  const entry = f.entries.find(entry => entry.state.id === failed.submissionId);
  const original = await read(f, {
    submissionId: failed.submissionId,
    attemptId: entry.state.firstAttemptId,
  });
  const conflict = await read(f, { submissionId: failed.submissionId, attemptId: failed.attemptId });
  assert.notEqual(conflict.candidate.id, original.candidate.id);
  assert.equal(conflict.candidate.head, null);
  assert.deepEqual(conflict.candidate.inputs, original.candidate.inputs);
  assert.deepEqual(conflict.candidate.dependencies, original.candidate.dependencies);
  assert.deepEqual(conflict.selection, original.selection);
  assert.deepEqual(conflict.selection.lanes, [{ laneId: entry.lane.laneId, head: entry.lane.head }]);
});
