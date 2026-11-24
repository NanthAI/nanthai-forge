// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 3f76a3df: every HOSTED_ACTION_FAILED names its cause and one next command that works, and a
// save that completed never reports failed. One test per phase: save, wait, preflight, tests read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { hostedActionError, hostedFailureCause, hostedFailureCauses } from '../dist/hosted-action-error.js';
import {
  dropKeptStatic,
  keepPassedStatic,
  keptPassedStatic,
  staticScopeKey,
} from '../dist/preflight-kept-static.js';
import { hostedFailureReply } from '../dist/hosted-failure-reply.js';
import { waitFailure } from '../dist/wait-failure.js';
import { ForgeError, localFailureOf, withLocalFailure } from '../dist/errors.js';

const failed = error => error.code === 'HOSTED_ACTION_FAILED';
const serverError = () => new Error('[Request ID: 5e7a1f] Server Error\nUncaught Error: synthetic');
/** Throw a server error on the next `times` calls of `name`, then answer normally. */
function failCalls(s, name, times) {
  const left = { times };
  for (const kind of ['query', 'mutation']) {
    const original = s.exchange.client[kind];
    s.exchange.client[kind] = (ref, args) => {
      if (getFunctionName(ref) === name && left.times > 0) {
        left.times--;
        throw serverError();
      }
      return original(ref, args);
    };
  }
  return left;
}
const quiet = t => t.mock.method(process.stderr, 'write', () => true);

test('no hosted failure is reported with cause unknown: each class names where it happened', () => {
  const errno = (code, syscall = 'open') => Object.assign(new Error(`${code}: synthetic`), { code, syscall });
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const cases = [
    [errno('ENOENT'), 'local-file'],
    [errno('EACCES'), 'local-permission'],
    [errno('ENOSPC', 'write'), 'local-disk'],
    [errno('EMFILE', 'spawn'), 'local-process'],
    [errno('ECONNRESET', 'read'), 'connection'],
    [abort, 'cancelled'],
    [new Error('surprising'), 'local-exception'],
    [serverError(), 'server-exception'],
  ];
  for (const [error, cause] of cases) assert.equal(hostedFailureCause(error), cause);
  // The server's own wrap of an unexpected exception keeps its request id and gets a cause too.
  const wrapped = new ConvexError({
    code: 'HOSTED_ACTION_FAILED',
    message: 'The hosted request failed before its outcome was known.',
  });
  wrapped.message = `[Request ID: 0a1b2c] Server Error\n${wrapped.message}`;
  const safe = hostedActionError(wrapped, 'agent save');
  assert.match(safe.message, /\(cause: server-exception; Convex request ID: 0a1b2c\)/);
  const local = hostedActionError(errno('ENOENT'), 'agent preflight');
  assert.match(local.message, /^Local step of agent preflight failed \(cause: local-file; ENOENT\)/);
  for (const [error] of cases)
    assert(hostedFailureCauses.includes(hostedFailureCause(error)), 'a cause from the fixed vocabulary');
});

test('save: a failure that persists names its cause and a wait that resumes the same operation', async t => {
  quiet(t);
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  failCalls(s, 'projectHostedSaves:prepare', 2);
  const operationId = randomUUID();
  const error = await s
    .transport()
    .dispatch('save', { message: 'Clean save', operationId })
    .then(
      () => assert.fail('two failed attempts report the failure'),
      caught => caught,
    );
  assert(failed(error));
  assert.equal(error.recovery.cause, 'server-exception');
  assert.equal(error.recovery.retryable, true);
  assert.match(
    error.message,
    /Hosted agent save failed \(cause: server-exception; Convex request ID: 5e7a1f\)/,
  );
  assert.doesNotMatch(error.message, /unknown/);
  assert.match(error.recovery.command, new RegExp(`wait '\\{"operationIds":\\["${operationId}"\\]\\}'$`));
  // The next command works: the wait replays the retained save and returns its completed receipt.
  const resumed = await hostedAgentCli(
    s.root,
    'wait',
    { operationIds: [operationId] },
    s.address,
    s.transport(),
  );
  assert.equal(resumed.result.outcome.status, 'completed');
});

test('save: a completed save answers completed first, and an immediate wait and preflight do too', async t => {
  quiet(t);
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  // The save commits on the server, but its reply is lost once (friction 81c9b759, 22d80af9).
  s.lose('projectHostedSaves:prepare');
  const operationId = randomUUID();
  const saved = await s.transport().dispatch('save', { message: 'Clean save', operationId });
  assert.equal(saved.result.outcome.status, 'completed');
  const waited = await hostedAgentCli(
    s.root,
    'wait',
    { operationIds: [operationId] },
    s.address,
    s.transport(),
  );
  assert.equal(waited.result.outcome.status, 'completed');
  assert.equal(waited.result.outcome.result.head, saved.result.outcome.result.head);
  const planned = await s.transport().dispatch('preflight', { laneId: s.lane.laneId, run: false });
  assert.equal(planned.result.laneId, s.lane.laneId);
  assert.equal(planned.result.head, saved.result.outcome.result.head);
});

test('wait: a transient failure while it replays a completed save still returns the completed receipt', async t => {
  quiet(t);
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const operationId = randomUUID();
  const saved = await s.transport().dispatch('save', { message: 'Clean save', operationId });
  // The first wait after a save hit a server error (friction 19b59696; it reported the deployment as
  // unavailable or the save as failed): the wait replays once more inside the same command.
  const transport = s.transport();
  failCalls(s, 'projectHostedAgent:capabilities', 1);
  const waited = await hostedAgentCli(s.root, 'wait', { operationIds: [operationId] }, s.address, transport);
  assert.equal(waited.result.outcome.status, 'completed');
  assert.equal(waited.result.outcome.result.head, saved.result.outcome.result.head);
});

test('preflight: a hosted read failure is replayed once; one that persists names the same preflight', async t => {
  quiet(t);
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  // Its other hosted reads are advisory (a failure only narrows the plan); this one it cannot skip.
  const read = 'projectHostedAgent:capabilities';
  failCalls(s, read, 1);
  const replayed = await s.transport().dispatch('preflight', { laneId: s.lane.laneId, run: false });
  assert.equal(replayed.result.laneId, s.lane.laneId);
  failCalls(s, read, 2);
  const error = await s
    .transport()
    .dispatch('preflight', { laneId: s.lane.laneId, run: false })
    .then(
      () => assert.fail('a persistent read failure is reported'),
      caught => caught,
    );
  assert(failed(error));
  assert.equal(error.recovery.cause, 'server-exception');
  assert.match(error.recovery.command, /preflight '\{"laneId":"[^"]+","run":false\}'$/);
  // The named command works once the server answers again.
  const next = await s.transport().dispatch('preflight', { laneId: s.lane.laneId, run: false });
  assert.equal(next.result.laneId, s.lane.laneId);
});

test('preflight: static checks a stopped run passed are kept for the same head and scope only', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-kept-static-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.forge-client`, { recursive: true, force: true });
  });
  const laneId = randomUUID(),
    passed = [{ name: 'lint', outcome: 'passed', ms: 40 }],
    scope = staticScopeKey(['src/a.ts']);
  keepPassedStatic(root, laneId, 'head-a', scope, ['lint'], passed);
  assert.deepEqual(keptPassedStatic(root, laneId, 'head-a', scope, ['lint']), passed);
  assert.equal(
    keptPassedStatic(root, laneId, 'head-b', scope, ['lint']),
    undefined,
    'another head reruns them',
  );
  assert.equal(
    keptPassedStatic(root, laneId, 'head-a', scope, ['lint', 'format']),
    undefined,
    'another selection',
  );
  assert.equal(
    keptPassedStatic(root, laneId, 'head-a', staticScopeKey(['src/a.ts', 'src/b.ts']), ['lint']),
    undefined,
    'another changed-path scope reruns them',
  );
  assert.equal(keptPassedStatic(root, laneId, 'head-a', staticScopeKey(undefined), ['lint']), undefined);
  for (const outcome of ['failed', 'timed-out', 'unjudged']) {
    keepPassedStatic(root, laneId, 'head-c', scope, ['lint'], [{ name: 'lint', outcome, ms: 40 }]);
    assert.deepEqual(
      keptPassedStatic(root, laneId, 'head-a', scope, ['lint']),
      passed,
      `${outcome} is never kept`,
    );
  }
  dropKeptStatic(root, laneId);
  assert.equal(keptPassedStatic(root, laneId, 'head-a', scope, ['lint']), undefined);
});

test('a request that failed before it was recorded names the same command under the same id', () => {
  const operationId = randomUUID();
  const safe = hostedActionError(serverError(), 'agent save');
  const reply = hostedFailureReply({
    root: '/repo',
    action: 'save',
    safe,
    error: serverError(),
    operationId,
    retained: false,
    input: { message: 'Clean save' },
  });
  assert.equal(reply.recovery.cause, 'server-exception');
  assert.doesNotMatch(reply.recovery.command, / wait /, 'no wait for an operation nothing recorded');
  assert.match(
    reply.recovery.command,
    new RegExp(`save '\\{"message":"Clean save","operationId":"${operationId}"\\}'$`),
  );
});

test('wait: a cause-only failure keeps its cause and gains the same wait as its next command', () => {
  const waitCommand = `nforge agent /repo wait '{"operationIds":["${randomUUID()}"]}'`;
  const failure = new ForgeError(
    'HOSTED_ACTION_FAILED',
    'Hosted agent wait failed (cause: connection).',
    undefined,
    {
      cause: 'connection',
      retryable: true,
    },
  );
  const resumed = waitFailure(failure, { next: { action: 'wait' }, waitCommand });
  assert.equal(resumed.recovery.cause, 'connection');
  assert.equal(resumed.recovery.retryable, true);
  assert.equal(resumed.recovery.command, waitCommand);
  // A recovery that already names its continuation stands as it is.
  const named = new ForgeError('HOSTED_ACTION_FAILED', 'x', undefined, {
    cause: 'connection',
    command: 'other',
  });
  assert.equal(waitFailure(named, { next: {}, waitCommand }), named);
});

test('tests read: a server failure replays the retained read once; one that persists names its wait', async t => {
  quiet(t);
  const s = agentFixture(t);
  let failures = 1;
  s.exchange.client.action = async (_ref, input) => {
    if (failures-- > 0) throw serverError();
    return JSON.stringify({ contract: null, contractVersion: 0, action: JSON.parse(input.request).action });
  };
  const answered = await s.transport().dispatch('tests', { candidateId: s.candidate.id });
  assert.equal(answered.result.action, 'tests');
  failures = 2;
  const operationId = randomUUID();
  const error = await s
    .transport()
    .dispatch('tests', { candidateId: s.candidate.id, operationId })
    .then(
      () => assert.fail('a persistent failure is reported'),
      caught => caught,
    );
  assert(failed(error));
  assert.equal(error.recovery.cause, 'server-exception');
  assert.match(error.recovery.command, new RegExp(`wait '\\{"operationIds":\\["${operationId}"\\]\\}'$`));
  const resumed = await hostedAgentCli(
    s.root,
    'wait',
    { operationIds: [operationId] },
    s.address,
    s.transport(),
  );
  assert.equal(resumed.result.action, 'tests');
});

test('Item 3f76a3df guard: ForgeError and ConvexError cross bundled/unbundled boundaries and ask never prints INTERNAL_ERROR', async t => {
  // 1. Separate module copies of ForgeError (like dist/cli-entry.js bundle vs dist/hosted-conversation.js)
  // still pass instanceof ForgeError and preserve localFailureOf.
  const other = await import('../dist/errors.js?cross-copy=1');
  assert.notEqual(other.ForgeError, ForgeError);
  const cause = new Error('local boom');
  const fromSibling = other.withLocalFailure(new other.ForgeError('BAD_ARGUMENT', 'Cross-copy error'), cause);
  assert.equal(fromSibling instanceof ForgeError, true);
  assert.equal(localFailureOf(fromSibling), cause);

  // 2. A ConvexError thrown by another ConvexError copy (bundled ConvexHttpClient -> unbundled hosted-conversation)
  // keeps its typed server code instead of being misclassified as HOSTED_ACTION_FAILED (cause: server-exception).
  const crossConvex = Object.assign(
    new Error('[Request ID: 3e05726d2fc93cf5] Server Error\nUncaught ConvexError: synthetic'),
    {
      name: 'ConvexError',
      data: { code: 'BAD_ARGUMENT', message: 'Choose a person who contributes to this project.' },
    },
  );
  const unwrapped = hostedActionError(crossConvex, 'ask');
  assert.equal(unwrapped.code, 'BAD_ARGUMENT');
  assert.equal(unwrapped.message, 'Choose a person who contributes to this project.');

  // 3. Genuine server failure on ask returns HOSTED_ACTION_FAILED with cause, retryable and a replay command.
  const s = agentFixture(t);
  const operationId = randomUUID();
  const transport = s.transport();
  t.mock.method(transport, 'mutation', () => {
    throw new Error('[Request ID: 7c192fd2eec32adc] Server Error\nUncaught Error: synthetic');
  });
  const askError = await hostedAgentCli(
    s.root,
    'ask',
    { laneId: s.lane.laneId, to: 'owner', text: 'Coord?', choices: ['A', 'B'], operationId },
    s.address,
    transport,
  ).then(
    () => assert.fail('ask server failure should reject'),
    caught => caught,
  );
  assert.equal(askError.code, 'HOSTED_ACTION_FAILED');
  assert.doesNotMatch(askError.message, /Push again/i);
  assert.match(askError.message, /Run next: it replays the same operation/);
  assert.equal(askError.recovery.cause, 'server-exception');
  assert.equal(askError.recovery.retryable, true);
  assert.equal(askError.recovery.operationId, operationId);
  assert.match(askError.recovery.command, new RegExp(`ask '.*${operationId}.*'`));

  // 4. End-to-end bundled CLI (dist/cli-entry.js) invoking unbundled dist/hosted-conversation.js:
  // never returns INTERNAL_ERROR on Lane+Item mix, typed ConvexError, or raw server exception.
  let mode = 'not-found';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (mode === 'not-found') {
      res.end(
        JSON.stringify({
          status: 'error',
          errorMessage: '[Request ID: 3e05726d2fc93cf5] Server Error\nUncaught ConvexError',
          errorData: {
            code: 'NOT_FOUND',
            message: 'Agent thevarsek/civic-ox has no open Lane or active session in this project.',
          },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        status: 'error',
        errorMessage: '[Request ID: 7c192fd2eec32adc] Server Error\nUncaught Error: synthetic boom',
      }),
    );
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const laneDir = mkdtempSync(join(tmpdir(), 'forge-ask-cli-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'forge-ask-home-'));
  t.after(() => {
    rmSync(laneDir, { recursive: true, force: true });
    rmSync(`${laneDir}.forge-client`, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });
  const laneId = randomUUID();
  const planningItemId = randomUUID();
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(join(`${laneDir}.forge-client`, 'agent'), { recursive: true });
  writeFileSync(
    join(`${laneDir}.forge-client`, 'agent', 'address.json'),
    JSON.stringify({ url: endpoint, projectId: 'project-1' }),
  );
  const env = {
    ...process.env,
    HOME: homeDir,
    XDG_STATE_HOME: join(homeDir, 'state'),
    FORGE_AUTH_TOKEN: 'synthetic-jwt',
    FORGE_DEPLOYMENT_URL: endpoint,
    FORGE_CLI_SKIP_UPDATE: '1',
    FORGE_DISABLE_FIRST_WRITE_HOOKS: '1',
  };
  const runAsk = async body => {
    try {
      await promisify(execFile)(
        process.execPath,
        [resolve('dist/cli-entry.js'), 'agent', laneDir, 'ask', JSON.stringify(body)],
        { env },
      );
      assert.fail('expected ask to exit non-zero');
    } catch (err) {
      return JSON.parse(err.stderr.trim().split('\n').at(-1));
    }
  };
  const mixed = await runAsk({
    laneId,
    planningItemId,
    to: 'thevarsek/civic-ox',
    text: 'Which one?',
    choices: ['A', 'B'],
  });
  assert.equal(mixed.error.code, 'BAD_ARGUMENT');
  assert.match(mixed.error.message, new RegExp(`${laneId}.*${planningItemId}`));

  mode = 'not-found';
  const refused = await runAsk({
    laneId,
    to: 'thevarsek/civic-ox',
    text: 'Which one?',
    choices: ['A', 'B'],
  });
  assert.equal(refused.error.code, 'NOT_FOUND');
  assert.match(refused.error.message, /thevarsek\/civic-ox/);
  assert.match(refused.error.next, /lanes '\{\}'/);

  mode = 'server-exception';
  const opId = randomUUID();
  const failedAsk = await runAsk({
    laneId,
    operationId: opId,
    to: 'thevarsek/civic-ox',
    text: 'Which one?',
    choices: ['A', 'B'],
  });
  assert.equal(failedAsk.error.code, 'HOSTED_ACTION_FAILED');
  assert.equal(failedAsk.error.recovery.cause, 'server-exception');
  assert.equal(failedAsk.error.recovery.operationId, opId);
  assert.match(failedAsk.error.next, new RegExp(`ask '.*${opId}.*'`));
});
