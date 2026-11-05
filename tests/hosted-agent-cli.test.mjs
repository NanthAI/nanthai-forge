// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostedAgentAddress, hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { canonicalRoot } from '../dist/root-paths.js';
import { ForgeError } from '../dist/errors.js';
import { agentCli } from '../dist/agent-cli.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
const errorCode = expected => error => error.code === expected;
function http(t, s) {
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-test-credential';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert(String(url).startsWith(s.address.url), 'No real HTTP calls');
    const body = JSON.parse(init.body),
      args = body.args[0];
    const name = body.path;
    const { makeFunctionReference } = await import('convex/server');
    const ref = makeFunctionReference(name);
    const value = await (String(url).endsWith('/api/query')
      ? s.exchange.client.query(ref, args)
      : s.exchange.client.mutation(ref, args));
    return new Response(JSON.stringify({ status: 'success', value }), {
      headers: { 'content-type': 'application/json' },
    });
  });
}
test('the actual agent CLI routes explicit hosted addressing before native owner construction and retains the address', async t => {
  const s = agentFixture(t);
  http(t, s);
  const first = await agentCli([s.root, 'start', JSON.stringify({ ...s.address, outcome: 'CLI synthetic' })]);
  assert.equal(first.transport, 'hosted');
  assert.equal(first.action, 'start');
  assert(!existsSync(s.root));
  const next = await agentCli([s.root, 'start', JSON.stringify({ outcome: 'CLI synthetic' })]);
  assert.equal(next.operationId, first.operationId);
  assert.deepEqual(next.result, first.result);
  const file = join(s.root, '..', 'command.json');
  writeFileSync(file, JSON.stringify({ laneId: s.lane.laneId }));
  assert.equal((await agentCli([s.root, 'status', '--command-file', file])).result.head, s.lane.head);
  const submissionId = randomUUID();
  const cancelled = await agentCli([s.root, 'cancel', JSON.stringify({ submissionId })]);
  assert.equal(cancelled.action, 'cancel');
  assert.equal(cancelled.result.id, submissionId);
  assert.equal(cancelled.result.error.code, 'LANDING_CANCELLED');
  await assert.rejects(agentCli([s.root, 'clean', '{}']), errorCode('HOSTED_ACTION_UNSUPPORTED'));
});
test('incomplete hosted CLI addressing fails without auth, network or a native owner', async t => {
  const s = agentFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network for incomplete addressing'));
  await assert.rejects(
    agentCli([s.root, 'start', JSON.stringify({ projectId: s.address.projectId, outcome: 'Synthetic' })]),
    errorCode('BAD_ARGUMENT'),
  );
  assert(!existsSync(s.root));
});

test('native symlink roots and read-only address detection preserve native routing without creating directories', t => {
  const s = agentFixture(t),
    real = join(s.root, '..', 'native'),
    alias = join(s.root, '..', 'alias');
  mkdirSync(real);
  symlinkSync(real, alias);
  assert.equal(hostedAgentAddress(alias, {}), null);
  const absent = join(s.root, 'missing', 'nested');
  assert.equal(hostedAgentAddress(absent, {}), null);
  assert(!existsSync(s.root));
});

test('hosted CLI forwards urgent finish and retained queued Candidate reprioritisation', async t => {
  const s = agentFixture(t);
  http(t, s);
  const finished = await agentCli([
    s.root,
    'finish',
    JSON.stringify({
      ...s.address,
      candidateId: s.candidate.id,
      composeOperationId: '11111111-1111-4111-8111-111111111111',
      priority: 'urgent',
    }),
  ]);
  assert.equal(finished.result.submission.request.priority, 'urgent');
  assert.equal(finished.result.queuePosition, 1);
  const operationId = randomUUID(),
    command = { submissionId: finished.result.submission.id, priority: 'normal', operationId };
  const changed = await agentCli([s.root, 'prioritize', JSON.stringify(command)]);
  assert.equal(changed.result.priority, 'normal');
  const first = s.calls.find(c => c.name === 'projectHostedLandingPriority:prioritize');
  assert.equal(first.args.expectedVersion, 0);
  assert.equal(
    (await agentCli([s.root, 'prioritize', JSON.stringify(command)])).operationId,
    changed.operationId,
  );
  assert.deepEqual(s.calls.filter(c => c.name === first.name).at(-1).args, first.args);
});

test('hosted wait CLI reports a persistent observe 502 as IN PROGRESS with an exact resumable command', async t => {
  const s = agentFixture(t),
    operationId = randomUUID(),
    err = [],
    output = [];
  const oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  t.mock.method(process.stderr, 'write', text => {
    err.push(String(text));
    return true;
  });
  const oldOut = process.stdout.write;
  t.mock.method(process.stdout, 'write', function (text, ...args) {
    if (typeof text === 'string' && text.startsWith('{')) {
      output.push(text);
      return true;
    }
    return oldOut.call(this, text, ...args);
  });
  const transport = s.transport();
  const query = transport.query.bind(transport);
  transport.query = async (name, args) => {
    if (name === 'projectHostedFinishObserve:page')
      throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'HTTP 502');
    return query(name, args);
  };
  const command = { operationIds: [operationId], until: 'acceptance', timeoutSeconds: 0.01 };
  const result = await hostedAgentCli(s.root, 'wait', command, s.address, transport);
  assert.equal(result.result.status, 'IN_PROGRESS');
  assert.equal(result.result.reason, 'budget');
  assert.equal(result.result.budgetSeconds, 0.01);
  assert.equal(result.result.inProgress, true);
  assert.equal(result.result.command, result.result.waitCommand);
  assert.equal(result.result.next.action, 'wait');
  assert.deepEqual(result.result.next.operationIds, [operationId]);
  assert.equal(result.result.instruction, undefined);
  assert.equal(result.result.submissions, undefined, 'no status dump on IN_PROGRESS');
  assert.equal(process.exitCode, 3);
  assert.equal(
    result.result.command,
    `nforge agent '${canonicalRoot(s.root)}' wait '${JSON.stringify({ ...command, ...s.address })}'`,
  );
  assert.deepEqual(err, [], 'the one return line is the result; nothing else is printed');
  assert.deepEqual(output, [], 'observation retries stay internal');
});

// Issue 75d316dd: check-only operation ids are not landings, so the server's landing page says NOT_FOUND.
async function checkOnlyWait(t, forget = false) {
  const s = agentFixture(t),
    transport = s.transport();
  await transport.dispatch('open', { laneId: s.lane.laneId });
  const submitted = await transport.dispatch('finish', { laneId: s.lane.laneId, accept: false });
  assert.equal(submitted.result.phase, 'check');
  if (forget) {
    // A check-only whose finish never produced a run: only the request was retained.
    const { hostedAgentDirectory } = await import('../dist/hosted-agent-journal.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const file = join(hostedAgentDirectory(s.root), `${submitted.operationId}.json`);
    const journal = JSON.parse(readFileSync(file, 'utf8'));
    delete journal.values['finish-check-run'];
    writeFileSync(file, JSON.stringify(journal));
  }
  const query = transport.query.bind(transport),
    dispatch = transport.dispatch.bind(transport);
  // The generic fixture run is not a full check record; observe it as an already passed one.
  transport.dispatch = async (action, input) =>
    action === 'observe' && input.runId
      ? {
          schema: 1,
          transport: 'hosted',
          action: 'observe',
          operationId: null,
          resolved: null,
          result: { id: input.runId, projectId: s.address.projectId, status: 'passed' },
        }
      : dispatch(action, input);
  let landingReads = 0;
  transport.query = async (name, args) => {
    if (name === 'projectHostedFinishObserve:page') {
      landingReads++;
      throw new ForgeError('NOT_FOUND', 'Select one hosted landing operation.');
    }
    return query(name, args);
  };
  const oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  const wait = () =>
    hostedAgentCli(
      s.root,
      'wait',
      { operationIds: [submitted.operationId], until: 'acceptance', timeoutSeconds: 0 },
      s.address,
      transport,
    );
  return { s, submitted, wait, landingReads: () => landingReads };
}

test('wait on a check-only operation id follows its run instead of failing NOT_FOUND', async t => {
  const { submitted, wait } = await checkOnlyWait(t);
  const result = await wait();
  assert.equal(result.result.status, 'terminal');
  assert.equal(result.result.run.id, submitted.result.run.id);
  assert.equal(result.result.run.status, 'passed');
});

test('wait on a check-only operation that produced no run ends in a clear terminal state', async t => {
  const { wait } = await checkOnlyWait(t, true);
  const result = await wait();
  assert.equal(result.result.status, 'terminal');
  assert.equal(result.result.successful, false);
  assert.equal(result.result.phase, 'check-only');
  assert.match(result.result.reason, /no check run/);
  assert.equal(process.exitCode, 0);
  // Repeating it is the same terminal answer, not a different error.
  assert.equal((await wait()).result.status, 'terminal');
});

test('wait on an operation this client never recorded still reports NOT_FOUND', async t => {
  const s = agentFixture(t),
    transport = s.transport();
  const query = transport.query.bind(transport);
  transport.query = async (name, args) => {
    if (name === 'projectHostedFinishObserve:page')
      throw new ForgeError('NOT_FOUND', 'Select one hosted landing operation.');
    return query(name, args);
  };
  await assert.rejects(
    hostedAgentCli(s.root, 'wait', { operationIds: [randomUUID()], timeoutSeconds: 0 }, s.address, transport),
    error => {
      assert.equal(error.code, 'NOT_FOUND', String(error.message));
      return true;
    },
  );
});

test('hosted wait CLI returns and prints direct conflict recovery without finish', async t => {
  const s = agentFixture(t),
    transport = s.transport();
  const submitted = await transport.dispatch('finish', {
    candidateId: s.candidate.id,
    composeOperationId: randomUUID(),
    accept: true,
  });
  const submission = s.operations.get(submitted.operationId);
  submission.phase = 'terminal-failed';
  submission.observation = { state: 'terminal-failed', pendingReason: null, cause: 'conflict' };
  submission.error = { code: 'COMPOSITION_CONFLICT', message: 'shared.txt conflicts with accepted main' };
  const candidateId = randomUUID();
  const query = transport.query.bind(transport);
  let conflictReads = 0;
  transport.query = async (name, args) => {
    if (name === 'projectHostedLanding:status') {
      conflictReads++;
      return {
        request: submission,
        attempt: { id: submission.attemptId, candidate: { id: candidateId, head: null } },
      };
    }
    return query(name, args);
  };
  const err = [],
    oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  t.mock.method(process.stderr, 'write', chunk => {
    err.push(String(chunk));
    return true;
  });
  const result = await hostedAgentCli(
    s.root,
    'wait',
    { operationIds: [submitted.operationId], until: 'acceptance', timeoutSeconds: 0 },
    s.address,
    transport,
  );
  assert.equal(result.result.recovery.conflict.candidateId, candidateId);
  assert.equal(result.result.submission.phase, 'terminal-failed');
  assert.deepEqual(result.result.submission, result.result.submissions[0].submission);
  assert.equal(result.result.recovery.conflict.next.action, 'sync');
  assert.equal(conflictReads, 1);
  assert(err.join('').includes('Continue recovery: ' + result.result.recovery.conflict.command));
  assert.equal(process.exitCode, 0, 'wait terminal failures retain their documented exit status');
});

// This table exercises public production wrappers, rather than only the pure normalizer.
for (const wrapper of ['cli', 'mcp'])
  for (const outcome of ['pending', 'retryable', 'terminal-submission', 'terminal-source'])
    test(`response-shape guard: ${wrapper} ${outcome} retains an outcome or exact continuation`, async t => {
      const { assertAgentResponseShape } = await import('./agent-response-shape.mjs');
      const { registerHostedAgentWorkflow } = await import('../dist/mcp-hosted-agent.js');
      const { getFunctionName } = await import('convex/server');
      const s = agentFixture(t);
      const command = {
        operationId: randomUUID(),
        inputs: [{ laneId: s.lane.laneId }],
        dependencies: [{ candidateId: s.candidate.id }],
        message: "Original 'selection'",
        accept: outcome !== 'terminal-source',
        keepOpen: true,
      };
      s.pending(outcome !== 'terminal-source');
      const mutation = s.exchange.client.mutation;
      s.exchange.client.mutation = async (ref, args) => {
        const value = await mutation(ref, args);
        if (getFunctionName(ref) !== 'projectHostedComposeJobs:submit') return value;
        if (outcome === 'terminal-source')
          return JSON.stringify({
            attemptId: randomUUID(),
            at: '2026-01-01T00:00:00.000Z',
            outcome: {
              status: 'failed',
              error: { code: 'SYNTHETIC_INVALID_SOURCE', message: 'Invalid source' },
            },
          });
        if (outcome === 'retryable')
          return JSON.stringify({
            status: 'retryable',
            jobId: 'retained',
            error: { code: 'SYNTHETIC_RETRY', message: 'Retry same operation' },
          });
        return value;
      };
      const transport = s.transport();
      let invoke;
      if (wrapper === 'mcp') {
        const tools = new Map();
        t.after(
          registerHostedAgentWorkflow(
            {
              registerTool(name, _config, call) {
                tools.set(name, call);
              },
            },
            transport,
          ),
        );
        invoke = async () => {
          const reply = await tools.get('forge_task')({ command: { action: 'finish', ...command } }, {});
          assert(!reply.isError, reply.content[0].text);
          return JSON.parse(reply.content[0].text);
        };
      } else invoke = () => hostedAgentCli(s.root, 'finish', command, s.address, transport);
      const first = await invoke();
      const firstNext = assertAgentResponseShape(first, s.root);
      if (outcome === 'terminal-submission') {
        const submission = s.operations.get(first.operationId);
        submission.phase = 'terminal-failed';
        submission.observation = { state: 'terminal-failed', cause: 'rejected', pendingReason: null };
        submission.error = { code: 'SYNTHETIC_FAILURE', message: 'Immutable terminal failure' };
        const before = s.calls.length;
        const replay = await invoke();
        const next = assertAgentResponseShape(replay, s.root);
        assert.equal(
          s.calls.length - before,
          2,
          'discovery plus original admission only; no normalization reads',
        );
        const { operationId: _original, ...selection } = first.result.replayParameters;
        void _original;
        assert.deepEqual(next.body, { ...selection, retry: true, reason: 'other' });
        assert.equal(replay.result.next.operationId, undefined);
        assert.deepEqual(replay.result.submission, submission);
        const again = await invoke();
        assert.deepEqual(again.result, replay.result, 'terminal replay remains stable');
        const { landSummary } = await import('../dist/hosted-land-summary.js');
        assert(landSummary(replay).includes('Retry: ' + replay.result.command));
      } else if (outcome === 'terminal-source') {
        assert.equal(first.result.status, 'failed');
        assert.equal(first.result.progress.outcome.error.code, 'SYNTHETIC_INVALID_SOURCE');
        assert.equal(firstNext.body.operationId, undefined);
        assert.equal(firstNext.body.retry, true);
      } else if (outcome === 'retryable') {
        assert.equal(first.result.status, 'retryable');
        assert.equal(firstNext.action, 'finish');
        assert.deepEqual(firstNext.body, {
          action: 'finish',
          ...s.address,
          ...first.result.replayParameters,
        });
        assert.equal(firstNext.body.operationId, command.operationId);
        assert.equal(first.result.waitCommand, undefined);
        assert.equal(first.result.inProgress, undefined);
      } else {
        assert.deepEqual(firstNext.body.operationIds, [command.operationId]);
        assert.equal(firstNext.action, 'wait');
        assert.equal(firstNext.body.until, 'acceptance');
        assert.equal(first.result.command, first.result.waitCommand);
        assert.match(first.result.instruction, /Keep this turn active/);
      }
    });

test('response-shape guard itself rejects dead ends, stale terminal advice and inconsistent commands', async () => {
  const { assertAgentResponseShape } = await import('./agent-response-shape.mjs');
  assert.throws(() => assertAgentResponseShape({ result: { status: 'submitted' } }, '/synthetic'), /neither/);
  assert.throws(
    () =>
      assertAgentResponseShape(
        {
          operationId: 'old',
          result: {
            submission: { phase: 'terminal-failed' },
            status: 'submitted',
            next: { action: 'finish', operationId: 'old' },
          },
        },
        '/synthetic',
      ),
    /pending status/,
  );
  assert.throws(
    () =>
      assertAgentResponseShape(
        {
          result: {
            next: { action: 'finish', retry: true },
            command: `nforge agent /synthetic finish '{"retry":false}'`,
          },
        },
        '/synthetic',
      ),
    /disagree/,
  );
});
