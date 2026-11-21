// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { cliTeachContext } from '../dist/error-teaching.js';
import { describeFailure } from '../dist/system-errors.js';
import { limitRefusal } from '../dist/exchange-retry.js';
import { ForgeError } from '../dist/errors.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { testDeploymentOrigin } from './trusted-origin.mjs';

/** Issue 93907d28: hitting a limit returns its reset time and the exact retry command, never a bare error. */
test('a RATE_LIMITED refusal reaches the agent with its reset time and the exact retry command', async t => {
  const s = agentFixture(t);
  const retryAt = Date.now() + 90_000;
  const inner = s.exchange.client.mutation;
  s.exchange.client.mutation = (ref, args) =>
    getFunctionName(ref) === 'projectCoordination:publish'
      ? Promise.reject(
          new ConvexError({
            code: 'RATE_LIMITED',
            message: 'Retry after 90 s.',
            retryAt,
          }),
        )
      : inner(ref, args);
  const command = {
    to: '@owner',
    text: 'Which name?',
    choices: ['A', 'B'],
    laneId: s.lane.laneId,
    operationId: randomUUID(),
  };
  const error = await s
    .transport()
    .dispatch('ask', command)
    .then(
      () => assert.fail('the post is refused'),
      error => error,
    );
  const argv = ['agent', s.root, 'ask', JSON.stringify(command)];
  const failure = describeFailure(error, cliTeachContext(argv));
  const iso = new Date(retryAt).toISOString();
  assert.equal(failure.code, 'RATE_LIMITED');
  assert.equal(failure.recovery.outcome, 'refused');
  assert.equal(failure.recovery.retryable, true);
  assert.equal(failure.recovery.retryAt, iso);
  assert.match(failure.message, new RegExp(`Retry the same command after ${iso}`));
  assert.equal(failure.next, `nforge agent ${s.root} ask '${JSON.stringify(command)}'`);
  assert.equal(failure.learn, `nforge agent ${s.root} help limits`);
});

test('only a limit with a reset gets retry wording; a storage quota has no time-based reset', () => {
  const once = limitRefusal(new ForgeError('RATE_LIMITED', 'limit', Date.now() + 1_000));
  assert.equal(limitRefusal(once), null, 'an already-converted refusal is not wrapped twice');
  assert.equal(limitRefusal(new ForgeError('QUOTA_EXCEEDED', 'full')), null);
  assert.equal(limitRefusal(new ForgeError('RATE_LIMITED', 'no reset named')), null);
  assert.equal(limitRefusal(new ForgeError('WORK_BUSY', 'busy', Date.now() + 1)), null);
});

test('MCP ask reports the exact tool call on a timed refusal', async t => {
  const s = agentFixture(t);
  const transport = s.transport();
  const server = new McpServer({ name: 'forge-test', version: '1.0.0' });
  const unregister = registerHostedAgentWorkflow(server, transport);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const [clientLink, serverLink] = InMemoryTransport.createLinkedPair();
  await server.connect(serverLink);
  await client.connect(clientLink);
  t.after(async () => {
    unregister();
    await client.close();
    await server.close();
  });
  const resetAt = '2026-12-01T00:00:00.000Z';
  const request = {
    name: 'forge_task',
    arguments: {
      command: {
        action: 'ask',
        to: '@owner',
        text: 'Which name?',
        choices: ['A', 'B'],
        laneId: s.lane.laneId,
        operationId: randomUUID(),
      },
    },
  };
  const posts = [];
  t.mock.method(s.exchange.client, 'mutation', async (ref, input) => {
    assert.equal(getFunctionName(ref), 'projectCoordination:publish');
    posts.push(input);
    if (posts.length === 2)
      throw new ConvexError({
        code: 'RATE_LIMITED',
        message: 'Request limit.',
        retryAt: Date.parse(resetAt),
      });
    return { operationId: input.operationId, actor: 'owner', at: 1, command: input.command };
  });
  const success = await client.callTool({
    ...request,
    arguments: { command: { ...request.arguments.command, operationId: randomUUID() } },
  });
  assert.equal(success.isError, undefined);

  const refusal = await client.callTool(request);
  assert.equal(refusal.isError, true);
  const { error } = JSON.parse(refusal.content[0].text);
  assert.equal(error.code, 'RATE_LIMITED');
  assert.equal(error.recovery.retryAt, resetAt);
  assert.match(error.next, /^forge_task /);
  const retryArguments = JSON.parse(error.next.slice('forge_task '.length));
  assert.deepEqual(retryArguments, request.arguments);
  assert.equal((await client.callTool({ ...request, arguments: retryArguments })).isError, undefined);
  const { next, ...withoutNext } = error;
  const retryBytes =
    Buffer.byteLength(JSON.stringify(error)) - Buffer.byteLength(JSON.stringify(withoutNext));
  t.diagnostic(`MCP retry command delta: ${retryBytes} bytes`);
  assert.equal(posts.length, 3);
  assert.notEqual(posts[0].operationId, posts[1].operationId);
  assert.deepEqual(posts[2], posts[1]);
});

test('detached land reports the caller’s entire retry command and reset after a timed refusal', async t => {
  const resetAt = '2026-12-01T00:00:00.000Z';
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(560, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'error',
          errorMessage: 'Rate limited',
          errorData: { code: 'RATE_LIMITED', message: 'Daily member limit.', retryAt: Date.parse(resetAt) },
        }),
      );
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = testDeploymentOrigin(`http://127.0.0.1:${server.address().port}`);
  const s = agentFixture(t);
  const command = JSON.stringify({
    url,
    projectId: s.address.projectId,
    laneId: s.lane.laneId,
    operationId: randomUUID(),
    message: 'A long landing message. '.repeat(30).trimEnd(),
  });
  const args = ['agent', s.root, 'land', '--save', command];
  const cli = fileURLToPath(new URL('../dist/cli-entry.js', import.meta.url));
  const run = (...rest) => promisify(execFile)(process.execPath, [cli, ...rest]);
  const checkRefusal = inspect => error => {
    assert.equal(error.code, 1, error.stderr);
    const replies = error.stderr.split('\n').filter(line => line.startsWith('{"error":'));
    assert.equal(replies.length, 1, error.stderr);
    const { error: failure } = JSON.parse(replies[0]);
    assert.equal(failure.code, 'RATE_LIMITED', error.stderr);
    assert.equal(failure.recovery.retryAt, resetAt);
    inspect(failure.next, error.stderr);
    return true;
  };
  await assert.rejects(
    run(...args),
    checkRefusal(next => {
      assert.equal(next, `nforge agent ${s.root} land --save '${command}'`);
      t.diagnostic(`CLI retry command bytes: ${Buffer.byteLength(next)}`);
    }),
  );

  const fromStdin = run(...args.slice(0, -1), '--command-file', '-');
  fromStdin.child.stdin.end(command);
  await assert.rejects(
    fromStdin,
    checkRefusal((next, stderr) => {
      const prefix = `nforge agent ${s.root} land --save --command-file `;
      assert(next.startsWith(prefix), next);
      const path = next.slice(prefix.length);
      assert(path.startsWith(join(tmpdir(), 'forge-limit-retry-')), path);
      assert.equal(dirname(dirname(path)), tmpdir());
      t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(readFileSync(path, 'utf8'), command);
      assert(!stderr.includes('A long landing message.'));
    }),
  );
});
