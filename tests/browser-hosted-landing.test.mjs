// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture, landingApi, code } from './hosted-finish-fixture.mjs';
const { BrowserLanding } = await import(moduleUrl('../web/src/lane/hosted-landing-client.ts'));
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  // The revert fixture drives the signed Modal callback path; Convex is the default.
  FORGE_SOURCE_PROVIDER: 'modal',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
async function browser(t) {
  const f = await finishFixture(t),
    calls = [];
  const client = new BrowserLanding({
    query: async name => {
      calls.push(name);
      if (name === 'projectHostedCompose:candidate') return f.candidate;
      if (name === 'projectHostedChannels:current') return f.currentMain();
      throw new Error(name);
    },
    mutation: async (name, args) => {
      calls.push(name);
      if (name === 'projectHostedLanding:enqueue') return f.enqueue(JSON.parse(args.request));
      if (name === 'projectHostedLanding:cancel')
        return JSON.parse(
          await f.tx('cancelBrowser', landingApi.cancel, { projectId: f.projectId, ...args }),
        );
      throw new Error(name);
    },
    read: async pin => JSON.parse(f.c.objects.get(pin.sha256)),
    upload: async () => assert.fail('accept never uploads source'),
    wait: async () => assert.fail('accept never polls or waits locally'),
  });
  return { f, client, calls };
}
test('browser person accept lands through hosted queue with no owner machine or local service', async t => {
  const { f, client, calls } = await browser(t),
    id = randomUUID();
  const submitted = await client.accept(id, f.candidate.id);
  assert.equal(submitted.request.agent, false);
  assert.equal(submitted.request.finish.reviewedSource.intentId, f.candidate.intentId);
  assert.equal(f.tables.ownerAcceptanceRequests?.size ?? 0, 0);
  await f.drain();
  assert.equal((await f.current(submitted.id)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.deepEqual(await client.accept(id, f.candidate.id), (await f.current(submitted.id)).submission);
  assert.equal(calls.filter(x => x === 'projectHostedCompose:candidate').length, 1);
  assert.equal(f.pending().length, 0);
  const observed = JSON.parse(
    await f.tx('candidateRead', landingApi.candidate, {
      projectId: f.projectId,
      candidateId: f.candidate.id,
    }),
  );
  assert.equal(observed.request.phase, 'landed');
  assert.ok(observed.receipt);
  assert.ok(calls.every(name => !name.includes('ownerAcceptance') && !name.includes('acceptChannel')));
});
test('browser reviewed roots survive main movement before click without following later saves', async t => {
  const { f, client } = await browser(t);
  f.moveMain();
  const submitted = await client.accept(randomUUID(), f.candidate.id);
  await f.drain();
  assert.equal((await f.current(submitted.id)).submission.phase, 'landed');
  assert.equal(f.metrics.sourceJobs, 1);
  const files = JSON.parse(f.c.objects.get(f.currentMain().head)).files;
  assert.ok(files.some(file => file.path === 'accepted.txt'));
  assert.ok(files.some(file => file.path === 'selected.txt'));
});
test('browser cancel reconciles the exact pending submission independently of Lane lifecycle', async t => {
  const { f, client } = await browser(t),
    submitted = await client.accept(randomUUID(), f.candidate.id),
    id = randomUUID();
  await client.cancel(id, submitted);
  await client.cancel(id, submitted);
  await f.drain();
  assert.equal((await f.current(submitted.id)).submission.phase, 'terminal-failed');
  assert.equal((await f.readLane(f.lane.laneId)).state, 'active');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});
test('person finish rejects substituted roots and agent use of reviewed-source selection', async t => {
  const { f, client } = await browser(t),
    submitted = await client.accept(randomUUID(), f.candidate.id);
  const request = structuredClone(submitted.request);
  request.operationId = randomUUID();
  request.finish.reviewedSource.inputs.root.sha256 = '0'.repeat(64);
  await assert.rejects(f.enqueue(request), code('WORK_OPERATION_CHANGED'));
  const agent = structuredClone(submitted.request);
  agent.operationId = randomUUID();
  agent.agent = true;
  await assert.rejects(f.enqueue(agent), code('BAD_ARGUMENT'));
});
test('a lost enqueue response replays the original person request and pins', async () => {
  const calls = [],
    id = randomUUID();
  let lost = true;
  const { buildComposePages } = await import('../dist/hosted-compose.js');
  const pages = buildComposePages([]);
  const candidate = {
    kind: 'candidate',
    id: randomUUID(),
    version: 0,
    at: new Date().toISOString(),
    intentId: randomUUID(),
    base: { head: 'a'.repeat(64), receiptId: 'main' },
    inputs: pages.manifest.root,
    dependencies: pages.manifest.root,
    algorithm: 'forge-native-compose-v1',
    result: { status: 'clean', head: 'b'.repeat(64) },
  };
  const io = {
    query: async name => (name.includes('candidate') ? candidate : { authority: { epoch: 2 } }),
    read: async () => pages.pages[0].value,
    mutation: async (_name, args) => {
      calls.push(args.request);
      if (lost) {
        lost = false;
        throw new Error('lost');
      }
      return { id: 'same' };
    },
  };
  const client = new BrowserLanding(io);
  await assert.rejects(client.accept(id, candidate.id));
  await client.accept(id, candidate.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
});

test('inline browser revert makes reverse source, composes, checks and lands while preserving later work', async t => {
  const { revertFixture, sync, syncJobs } = await import('./hosted-revert-fixture.mjs');
  const { api: composeApi, jobApi: composeJobs } = await import('./hosted-compose-fixture.mjs');
  const { saveBytes } = await import('../dist/hosted-save.js');
  const definitions = await import(moduleUrl('../convex/projectHostedCheckDefinitions.ts'));
  const f = await revertFixture(t),
    receipt = await f.landOriginal();
  f.move([f.c.file('later-browser.txt', 'keep later work\n')]);
  const calls = [],
    call = async (name, api, args) => JSON.parse(await f.tx(name, api, { projectId: f.projectId, ...args }));
  const requests = new Map();
  const client = new BrowserLanding({
    query: async (name, args) => {
      calls.push(name);
      if (name === 'projectHostedChannels:current') return f.currentMain();
      if (name === 'projectHostedSync:progress') return call('browserSyncProgress', sync.progress, args);
      if (name === 'projectHostedCompose:progress')
        return call('browserComposeProgress', composeApi.progress, args);
      if (name === 'projectHostedCheckDefinitions:list')
        return { page: [{ check: { id: f.rawChecks.checkId, name: 'verify' } }], isDone: true };
      if (name === 'projectHostedCheckDefinitions:current')
        return call('browserCheckSettings', definitions.current, args);
      throw new Error(name);
    },
    mutation: async (name, args) => {
      calls.push(name);
      if (name === 'projectHostedSync:prepare') {
        requests.set('sync', JSON.parse(args.request));
        return call('browserSyncPrepare', sync.prepare, args);
      }
      if (name === 'projectHostedSyncJobs:submit') return call('browserSyncSubmit', syncJobs.submit, args);
      if (name === 'projectHostedCompose:prepare') {
        requests.set('compose', JSON.parse(args.request));
        return call('browserComposePrepare', composeApi.prepare, args);
      }
      if (name === 'projectHostedCompose:stage') return call('browserComposeStage', composeApi.stage, args);
      if (name === 'projectHostedComposeJobs:submit')
        return call('browserComposeSubmit', composeJobs.submit, args);
      if (name === 'projectObjectDownloads:describe')
        return args.digests.map(digest => ({ digest, size: f.c.objects.get(digest).length }));
      if (name === 'projectHostedLanding:enqueue') return f.enqueue(JSON.parse(args.request));
      throw new Error(name);
    },
    read: async pin => JSON.parse(f.c.objects.get(pin.sha256)),
    upload: async value => {
      f.c.put(saveBytes(value));
    },
    wait: async (name, args, done) => {
      calls.push(`subscribe:${name}`);
      if (name === 'projectHostedSync:progress') {
        const request = requests.get('sync');
        await f.publishRevert(await f.workRevert(request));
        const result = await call('browserSyncTerminal', sync.progress, args);
        assert.ok(done(result));
        return result;
      }
      // The fixed fake worker consumes the exact staged composition input.
      const progress = await call('browserComposeInput', composeApi.progress, args),
        output = await f.c.compute(progress.input);
      const row = [...f.tables.projectHostedComposes.values()].find(
        row => row.operationId === args.operationId,
      );
      const job = await f.c.activate(row.jobId);
      await f.c.callback(job, { status: 'completed', output: output.output });
      for (const task of f.pending().filter(x => x.args[0].jobId === job.id))
        f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
      await call('browserComposePublish', composeJobs.publish, {
        jobId: job.id,
        result: f.c.objects.get(output.output.sha256).toString(),
      });
      const result = await call('browserComposeTerminal', composeApi.progress, args);
      assert.ok(done(result));
      return result;
    },
  });
  const id = randomUUID(),
    result = await client.revert(id, receipt.id, 'Keep the retry fix; undo the byte path.');
  assert.equal(result.submission.request.revertOf, receipt.id);
  assert.equal(result.submission.request.check.kind, 'request');
  const intent = [...f.tables.projectHostedRecordBodies.values()]
    .map(row => JSON.parse(row.value))
    .find(row => row.kind === 'intent' && row.id !== f.c.intentId);
  assert.equal(intent.constraints, 'Keep the retry fix; undo the byte path.');
  await f.drain();
  await f.passChecks();
  await f.drain();
  const settled = (await f.current(result.submission.id)).submission;
  assert.equal(settled.phase, 'landed');
  assert.equal(f.text(settled.acceptance.head, 'selected.txt'), null);
  assert.equal(f.text(settled.acceptance.head, 'later-browser.txt'), 'keep later work\n');
  const original = await call('browserOriginalDisposition', landingApi.candidate, {
    candidateId: f.candidate.id,
  });
  assert.equal(original.request.phase, 'landed');
  assert.equal(original.reverseCandidateId, result.candidateId);
  assert.deepEqual(await client.revert(id, receipt.id, 'Keep the retry fix; undo the byte path.'), result);
  assert.ok(calls.every(name => !name.includes('ownerAcceptance') && !name.includes('acceptChannel')));
});

test('Candidate landing observation checks current read access before returning source or receipts', async t => {
  const { f, client } = await browser(t);
  await client.accept(randomUUID(), f.candidate.id);
  await assert.rejects(
    f.tx(
      'forbiddenCandidateRead',
      landingApi.candidate,
      { projectId: f.projectId, candidateId: f.candidate.id },
      'stranger',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('Try again creates a new landing operation and check for the same Candidate, including revert provenance', async () => {
  const calls = [];
  const client = new BrowserLanding({
    mutation: async (name, args) => {
      calls.push([name, JSON.parse(args.request)]);
      return {};
    },
  });
  const submission = {
    request: {
      operationId: randomUUID(),
      candidateId: randomUUID(),
      finish: { composeOperationId: randomUUID(), after: null },
      revertOf: randomUUID(),
      check: { kind: 'run', runId: randomUUID() },
    },
  };
  const check = {
    checkId: randomUUID(),
    definition: 'a'.repeat(64),
    configuration: 'b'.repeat(64),
    environment: 'c'.repeat(64),
  };
  const operationId = randomUUID();
  await client.retry(operationId, submission, check);
  await client.retry(operationId, submission, check);
  assert.equal(calls[0][0], 'projectHostedLanding:enqueue');
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0][1].candidateId, submission.request.candidateId);
  assert.equal(calls[0][1].revertOf, submission.request.revertOf);
  assert.equal(calls[0][1].check.kind, 'request');
  assert.equal(calls[0][1].operationId, operationId);
});
test('unconfirmed hosted runner start is a stale observation and reads schedule no work', async t => {
  const f = await finishFixture(t),
    state = await f.enqueue(f.request({ agent: false }));
  await f.drain();
  const row = [...f.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  f.patch('projectHostedCheckRuns', row._id, {
    status: 'unknown',
    value: JSON.stringify({ ...run, status: 'unknown' }),
  });
  const before = f.pending().length;
  const observed = JSON.parse(
    await f.tx('readRunnerWait', landingApi.candidate, {
      projectId: f.projectId,
      candidateId: f.candidate.id,
    }),
  );
  assert.equal(observed.request.id, state.id);
  assert.equal(observed.request.observation.pendingReason, 'pending-infra');
  assert.equal(f.pending().length, before);
});
test('decision failure excerpts verify exact output and never download artifacts', async t => {
  const { landingFailureExcerpt } = await import(moduleUrl('../web/src/lane/landing-output.ts'));
  const { digest } = await import('../dist/portable-hash.js');
  const bytes = new TextEncoder().encode(
    '✖ browser ranges\nnot ok 2 - upload retries\nAssertionError: expected 206\n',
  );
  const calls = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const io = {
    query: async () => ({
      page: [
        { streamId: 'out', stream: { stream: 'stdout' }, chunks: 1, maxSequence: 0 },
        { streamId: 'binary', stream: { stream: 'artifact' }, chunks: 1, maxSequence: 0 },
      ],
      isDone: true,
    }),
    mutation: async (name, args) => {
      assert.equal(name, 'projectHostedOutputRead:downloads');
      calls.push(...args.entries.map(entry => entry.streamId));
      return args.entries.map(() => ({
        url: 'https://output.invalid/chunk',
        object: { sha256: digest(bytes), size: bytes.length },
      }));
    },
  };
  const result = await landingFailureExcerpt(io, 'run');
  assert.deepEqual(result.failures, ['browser ranges', 'upload retries']);
  assert.deepEqual(calls, ['out']);
  t.mock.method(globalThis, 'fetch', async () => new Response('corrupt'));
  await assert.rejects(landingFailureExcerpt(io, 'run'), code('R2_OBJECT_CHECKSUM_MISMATCH'));
});

test('ready review finds exact hosted check evidence without a landing request or owner receipt', async t => {
  const f = await finishFixture(t);
  const checks = await import(moduleUrl('../convex/projectHostedChecks.ts'));
  const r = f.request({ agent: false }).check;
  const run = JSON.parse(
    await f.tx('readyHostedCheck', checks.enqueue, {
      projectId: f.projectId,
      request: JSON.stringify({
        operationId: randomUUID(),
        authorityEpoch: 1,
        candidateId: f.candidate.id,
        expectedHead: f.candidate.result.head,
        checkId: r.checkId,
        expectedDefinition: r.expectedDefinition,
        expectedConfiguration: r.expectedConfiguration,
        expectedEnvironment: r.expectedEnvironment,
      }),
    }),
  );
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  const ready = JSON.parse(
    await f.tx('readReadyHostedCheck', landingApi.candidate, {
      projectId: f.projectId,
      candidateId: f.candidate.id,
    }),
  );
  assert.equal(ready.request, null);
  assert.equal(ready.run.id, run.id);
  assert.equal(ready.run.status, 'passed');
  assert.equal(f.tables.projectHostedLandingRequests.size, 0);
});
