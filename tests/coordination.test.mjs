import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { dispatchCoordination, coordinationClient } from '../dist/coordination-client.js';
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const reads = await import(moduleUrl('../convex/projectCoordinationReads.ts'));
const modules = { projectCoordination: coordination, projectCoordinationReads: reads };
const handler = ref => {
  const [module, name] = getFunctionName(ref).split(':');
  return modules[module][name]._handler;
};
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const sessionA = randomUUID(),
  sessionB = randomUUID();
const activity = (sessionId, sequence = 1, status = 'working') => ({
  kind: 'activity',
  sessionId,
  sequence,
  name: 'Agent',
  environment: 'fixture environment',
  status,
  summary: 'Implement related source',
  context: {
    intentId: 'intent',
    laneId: 'lane',
    head: 'a'.repeat(64),
    paths: ['src/shared.ts'],
    dependsOn: [],
  },
});
function fixture() {
  const f = state([]);
  f.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: 'key',
    name: 'Project',
    revision: 42,
    currentBackup: null,
  });
  const transport = {
    query: (ref, args) => handler(ref)(f.ctx, args),
    mutation: (ref, args) => handler(ref)(f.ctx, args),
  };
  const publish = (command, operationId = randomUUID()) =>
    dispatchCoordination(transport, 'project', { action: 'publish', operationId, command });
  const read = (action, cursor = null, pageSize = 50) =>
    dispatchCoordination(transport, 'project', { action, cursor, pageSize });
  return { ...f, publish, read };
}
test('two environments announce, message, acknowledge and reconnect without source archive or Work revision mutation', async () => {
  const f = fixture();
  await f.publish(activity(sessionA));
  await f.publish(activity(sessionB));
  const first = await f.read('feed', null, 2);
  assert.equal(first.page.length, 2);
  const message = await f.publish({
    kind: 'message',
    sessionId: sessionA,
    recipient: sessionB,
    text: 'Changing shared function; please coordinate',
    context: { laneId: 'lane-a', head: 'b'.repeat(64) },
  });
  const resumed = await f.read('feed', first.continueCursor, 2);
  assert.deepEqual(
    resumed.page.map(x => x.operationId),
    [message.operationId],
  );
  const ack = await f.publish({
    kind: 'ack',
    sessionId: sessionB,
    messageId: message.operationId,
    text: 'Read; adjusting my candidate',
  });
  assert.equal(ack.command.messageId, message.operationId);
  const thread = await dispatchCoordination({ query: (ref, args) => handler(ref)(f.ctx, args) }, 'project', {
    action: 'feed',
    laneId: 'lane-a',
    pageSize: 50,
  });
  assert.deepEqual(
    thread.page.map(event => event.operationId),
    [message.operationId, ack.operationId],
  );
  await f.publish({ ...activity(sessionB, 2, 'waiting'), context: { dependsOn: [sessionA] } });
  const current = await f.read('sessions');
  assert.equal(current.page.length, 2);
  assert.equal(current.page[0].status, 'waiting');
  assert.deepEqual(current.page[0].context.dependsOn, [sessionA]);
  assert.equal(f.tables.hostedProjects.get('project').revision, 42);
  assert.equal(f.reads(), 0);
});
test('unknown response reconciles original operation, changed operation cannot overwrite and delayed status cannot rewind', async () => {
  const f = fixture(),
    original = randomUUID();
  const one = await f.publish(activity(sessionA), original);
  await f.publish(activity(sessionA, 3, 'completed'));
  assert.deepEqual(await f.publish(activity(sessionA), original), one);
  await assert.rejects(f.publish(activity(sessionA, 4), original), /original coordination operation/);
  await assert.rejects(f.publish(activity(sessionA, 2)), /newer session observation/);
  assert.equal((await f.read('sessions')).page[0].status, 'completed');
  assert.equal(f.tables.projectCoordinationEvents.size, 2);
});
test('current owner/contributor authority applies on every call, session ownership and directed ack are enforced', async () => {
  const f = fixture();
  await f.publish(activity(sessionA));
  f.caller('outsider');
  await assert.rejects(f.read('feed'), /unavailable/);
  await assert.rejects(f.publish(activity(sessionB)), /unavailable/);
  f.tables.projectContributors.set('grant', { _id: 'grant', projectId: 'project', contributor: 'other' });
  f.caller('other');
  await f.publish(activity(sessionB));
  await assert.rejects(f.publish(activity(sessionA, 2)), /another principal/);
  const message = await f.publish({
    kind: 'message',
    sessionId: sessionB,
    recipient: sessionA,
    text: 'Question',
    context: {},
  });
  await assert.rejects(
    f.publish({ kind: 'ack', sessionId: sessionB, messageId: message.operationId, text: 'Wrong recipient' }),
    /recipient session/,
  );
  f.caller('owner');
  await f.publish({ kind: 'ack', sessionId: sessionA, messageId: message.operationId, text: 'Read' });
  f.caller('other');
  f.tables.projectContributors.clear();
  await assert.rejects(f.read('sessions'), /unavailable/);
  f.caller(null);
  await assert.rejects(f.read('feed'), /Sign in/);
});
test('messages remain contextual claims; cross-project recipient and acknowledgement IDs do not cross authority', async () => {
  const f = fixture();
  await f.publish(activity(sessionA));
  await assert.rejects(
    f.publish({ kind: 'message', recipient: sessionB, text: 'Missing', context: {} }),
    /Select a session/,
  );
  await assert.rejects(
    f.publish({ kind: 'ack', messageId: randomUUID(), text: 'Missing' }),
    /message or handoff operation/,
  );
  await assert.rejects(f.publish({ ...activity(sessionB), sequence: 0 }), /Use publish/);
});
test('trash prevents new coordination and existing project purge removes retained coordination records', async () => {
  const f = fixture();
  await f.publish(activity(sessionA));
  f.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(f.publish(activity(sessionA, 2)), /Restore/);
  f.tables.hostedProjects.get('project').removal = 'deleting';
  await lifecycle.purge._handler(f.ctx, { projectId: 'project' });
  assert.equal(f.tables.projectCoordinationSessions.size, 0);
  assert.equal(f.tables.projectCoordinationEvents.size, 0);
  await assert.rejects(f.read('sessions'), /unavailable/);
});
test('transport keeps auth in environment path, refuses source-only grants and untrusted URL shapes', () => {
  for (const url of [
    'https://user:secret@example.com',
    'https://example.com/path',
    'http://example.com',
    'https://example.com?token=x',
  ])
    assert.throws(() => coordinationClient(url, 'jwt'), /HTTPS/);
  assert.throws(
    () => coordinationClient('https://example.convex.cloud', 'fga_sourceonly'),
    /Source-read grants/,
  );
  assert.throws(() => coordinationClient('https://example.convex.cloud', undefined), /FORGE_AUTH_TOKEN/);
});

test('real CLI and MCP processes coordinate separate sessions over authenticated HTTP and preserve denied authority', async t => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { resolve } = await import('node:path');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const f = fixture(),
    received = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer synthetic-test-jwt');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      received.push(body.path);
      const [module, name] = body.path.split(':');
      assert.ok(modules[module]);
      const value = await modules[module][name]._handler(f.ctx, body.args[0]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ status: 'success', value, logLines: ['Private backend log must remain hidden'] }),
      );
    } catch (error) {
      res.writeHead(560, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'error',
          errorMessage: 'Coordination failed',
          errorData: error.data ?? { code: 'FIXTURE' },
        }),
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`,
    env = { ...process.env, FORGE_AUTH_TOKEN: 'synthetic-test-jwt' };
  const cli = async input =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [resolve('dist/cli.js'), 'coordination', endpoint, 'project', JSON.stringify(input)],
          { env },
        )
      ).stdout,
    );
  const started = await cli({ action: 'publish', operationId: randomUUID(), command: activity(sessionA) });
  assert.equal(started.command.sessionId, sessionA);
  delete env.FORGE_PARENT_SESSION;
  const client = new Client({ name: 'codex', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp-coordination', endpoint, 'project'],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', c => (stderr += c));
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), [
    'forge_ack',
    'forge_announce',
    'forge_claim',
    'forge_coordinate',
    'forge_coordination_read',
    'forge_coordination_watch',
    'forge_handoff',
    'forge_hosted_work',
    'forge_inbox',
    'forge_message',
    'forge_release',
  ]);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, body: JSON.parse(result.content[0].text) };
  };
  await call('forge_coordinate', { operationId: randomUUID(), command: activity(sessionB) });
  const page = await call('forge_coordination_read', { action: 'feed', cursor: null, pageSize: 2 });
  assert.equal(page.body.page.length, 2);
  const operationId = randomUUID(),
    command = {
      kind: 'message',
      sessionId: sessionA,
      recipient: sessionB,
      text: 'Coordinate shared path',
      context: { paths: ['src/shared.ts'] },
    };
  await cli({ action: 'publish', operationId, command });
  await cli({ action: 'publish', operationId, command });
  const resumed = await call('forge_coordination_read', {
    action: 'feed',
    cursor: page.body.continueCursor,
    pageSize: 2,
  });
  assert.equal(resumed.body.page.length, 1);
  const ack = await call('forge_coordinate', {
    operationId: randomUUID(),
    command: { kind: 'ack', sessionId: sessionB, messageId: operationId, text: 'Acknowledged' },
  });
  assert.equal(ack.body.command.messageId, operationId);
  const announced = await call('forge_announce', { summary: 'Editing shared path', laneId: 'lane-b' });
  assert.equal(announced.body.heartbeat, true);
  assert.equal(announced.body.harness, 'codex');
  assert.equal(announced.body.harnessVersion, '1');
  assert.deepEqual(announced.body.childEnvironment, { FORGE_PARENT_SESSION: announced.body.sessionId });
  // A separately spawned MCP connection gets its own session, linked via the returned environment.
  const child = new Client({ name: 'claude-code', version: '2' });
  t.after(() => child.close());
  await child.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp-coordination', endpoint, 'project'],
      env: { ...env, ...announced.body.childEnvironment },
      stderr: 'pipe',
    }),
  );
  const childReply = await child.callTool({ name: 'forge_announce', arguments: { summary: 'Child work' } });
  assert.ok(!childReply.isError);
  const childSession = JSON.parse(childReply.content[0].text);
  assert.notEqual(childSession.sessionId, announced.body.sessionId);
  assert.equal(childSession.parentSessionId, announced.body.sessionId);
  assert.equal(childSession.sessionKind, 'subagent');
  assert.equal(childSession.harness, 'claude-code');
  const grouped = await call('forge_coordination_read', { action: 'sessions' });
  const parent = grouped.body.page.find(row => row.sessionId === announced.body.sessionId);
  assert.deepEqual(parent.subagents, []);
  const children = await call('forge_coordination_read', {
    action: 'sessions',
    parentSessionId: parent.sessionId,
  });
  assert.equal(children.body.page[0].sessionId, childSession.sessionId);
  const counts = await call('forge_coordination_read', { action: 'counts' });
  assert.equal(
    counts.body.activeAgents,
    2,
    'CLI and MCP announcements with the same name and Lane count once',
  );
  assert.equal(counts.body.activeSubagents, 1);
  await child.close();
  const claim = await call('forge_claim', { paths: ['src/shared.ts'] });
  assert.equal(claim.body.overlaps.length, 0);
  const sent = await cli({ action: 'message', to: 'owner', text: 'Please review' });
  const inbox = await call('forge_inbox', {});
  assert.deepEqual(
    inbox.body.items.map(item => item.id),
    [sent.operationId],
  );
  await call('forge_ack', { messageId: sent.operationId });
  assert.equal((await call('forge_inbox', {})).body.items.length, 0);
  const related = await call('forge_coordination_read', { action: 'related' });
  assert.equal(related.isError, undefined);
  f.caller('revoked');
  assert.equal(
    (await call('forge_coordination_read', { action: 'feed', cursor: null, pageSize: 2 })).isError,
    true,
  );
  await client.close();
  assert.equal(stderr, '');
  assert.ok(received.includes('projectCoordination:publish'));
  assert.equal(f.tables.hostedProjects.get('project').revision, 42);
});

test('durable feed cursor retains EOF and equal-time ID boundaries, replays opaque predecessors and rejects cross-project cursors', async () => {
  const f = fixture(),
    empty = await f.read('feed');
  assert.equal(empty.page.length, 0);
  const first = await f.publish({ kind: 'message', text: 'After empty EOF', context: {} });
  const after = await f.read('feed', empty.continueCursor);
  assert.deepEqual(
    after.page.map(x => x.operationId),
    [first.operationId],
  );
  for (let i = 0; i < 5; i++) await f.publish({ kind: 'message', text: `Tie ${i}`, context: {} });
  for (const row of f.tables.projectCoordinationEvents.values()) row._creationTime = 100;
  let cursor = null,
    all = [];
  do {
    const page = await f.read('feed', cursor, 2);
    all.push(...page.page.map(x => x._id));
    cursor = page.continueCursor;
    if (page.isDone) break;
  } while (true);
  assert.equal(all.length, 6);
  assert.equal(new Set(all).size, 6);
  assert.deepEqual(all, [...all].sort());
  const resumed = await f.read('feed', cursor);
  assert.equal(resumed.page.length, 0);
  await f.publish({ kind: 'message', text: 'After populated EOF', context: {} });
  assert.equal((await f.read('feed', resumed.continueCursor)).page.length, 1);
  const legacy = await f.read('feed', 'old-opaque-exhausted-cursor', 2);
  assert.equal(legacy.cursorReset, true);
  assert.equal(legacy.page.length, 2);
  const foreign = 'forge-coordination-v1:' + JSON.stringify({ projectId: 'foreign', key: ['foreign'] });
  await assert.rejects(f.read('feed', foreign), /cursor from this project/);
});

test('original operation reconciles after backend JSON object key ordering changes', async () => {
  const f = fixture(),
    operationId = randomUUID(),
    command = activity(sessionA),
    original = await f.publish(command, operationId);
  function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map(key => [key, ordered(value[key])]),
      );
    return value;
  }
  const row = [...f.tables.projectCoordinationEvents.values()][0];
  row.command = ordered(row.command);
  const replay = await f.publish(command, operationId);
  assert.equal(replay._id, original._id);
  assert.equal(f.tables.projectCoordinationEvents.size, 1);
});
