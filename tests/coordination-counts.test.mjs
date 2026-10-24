import { activityFields } from '../dist/work-hosted-index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { dispatchCoordination } from '../dist/coordination-client.js';
import { sessionDeclaration, detectHarness } from '../dist/coordination-identity.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));

function fixture(t) {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = state([]);
  f.tables.hostedProjects.set('project', { _id: 'project', owner: 'owner', visibility: 'private' });
  f.tables.projectContributors.set('grant', { _id: 'grant', projectId: 'project', contributor: 'other' });
  const publish = (sessionId, extra = {}, operationId = randomUUID()) =>
    coordination.publish._handler(f.ctx, {
      projectId: 'project',
      operationId,
      command: {
        kind: 'activity',
        sessionId,
        sequence: 1,
        name: 'Synthetic agent',
        environment: 'test',
        status: 'working',
        summary: 'Working',
        context: {},
        ...extra,
      },
    });
  const query = (name, args = {}) => coordination[name]._handler(f.ctx, { projectId: 'project', ...args });
  const row = sessionId =>
    [...f.tables.projectCoordinationSessions.values()].find(row => row.sessionId === sessionId);
  const identity = (actor, credentialId) => {
    f.ctx.auth.getUserIdentity = async () =>
      actor ? { subject: actor, ...(credentialId ? { forgeCredential: credentialId } : {}) } : null;
    if (credentialId)
      f.tables.cliCredentials.set(credentialId, {
        _id: credentialId,
        credentialId,
        owner: actor,
        scope: 'coordination',
        expiresAt: now + 60_000,
      });
  };
  return { ...f, now, publish, query, row, identity };
}
const empty = {
  activeAgents: 0,
  activeSubagents: 0,
  activePeople: 0,
  activeLanes: 0,
  unannouncedActiveLanes: 0,
};

test('counts distinguish legacy agents, subagents and people; completed and stale sessions do not count', async t => {
  const f = fixture(t);
  const parent = randomUUID(),
    child = randomUUID(),
    grandchild = randomUUID(),
    person = randomUUID();
  await f.publish(parent, { harness: 'claude-code', harnessVersion: '1.2.3' });
  await f.publish(child, { parentSessionId: parent, sessionKind: 'subagent' });
  await f.publish(grandchild, { parentSessionId: child });
  await f.publish(person, { sessionKind: 'person' });
  const stale = randomUUID(),
    completed = randomUUID(),
    legacy = randomUUID();
  await f.publish(stale);
  f.row(stale).lastSeen = f.now - 900_001;
  f.row(stale).lastActivity = f.row(stale).lastSeen;
  await f.publish(completed, { status: 'completed' });
  await f.publish(legacy);
  delete f.row(legacy).kind;
  delete f.row(legacy).harness;
  assert.deepEqual(await f.query('counts'), {
    ...empty,
    activeAgents: 2,
    activeSubagents: 2,
    activePeople: 1,
  });
  const sessions = await f.query('sessions', { paginationOpts: { cursor: null, numItems: 1 } });
  let cursor = sessions.continueCursor,
    roots = [...sessions.page],
    done = sessions.isDone;
  while (!done) {
    const page = await f.query('sessions', { paginationOpts: { cursor, numItems: 1 } });
    roots.push(...page.page);
    cursor = page.continueCursor;
    done = page.isDone;
  }
  assert.equal(roots.length, 5); // Children are nested, never repeated as roots on another page.
  const tree = roots.find(row => row.sessionId === parent);
  assert.equal(tree.kind, 'agent');
  assert.equal(tree.harness, 'claude-code');
  assert.deepEqual(tree.subagents, []);
  const children = await f.query('sessions', {
    parentSessionId: parent,
    paginationOpts: { cursor: null, numItems: 1 },
  });
  assert.equal(children.page[0].sessionId, child);
  const grandchildren = await f.query('sessions', {
    parentSessionId: child,
    paginationOpts: { cursor: null, numItems: 1 },
  });
  assert.equal(grandchildren.page[0].sessionId, grandchild);
  assert.equal(roots.find(row => row.sessionId === legacy).harness, 'other');
  assert.equal(roots.find(row => row.sessionId === stale).stale, true);
  f.row(parent).lastSeen = f.now - 900_001;
  f.row(parent).lastActivity = f.row(parent).lastSeen;
  assert.deepEqual(await f.query('counts'), {
    ...empty,
    activeAgents: 1,
    activeSubagents: 2,
    activePeople: 1,
  });
  // Completion of a child remains possible after the parent goes stale.
  await f.publish(child, { sequence: 2, status: 'completed', parentSessionId: parent });
  assert.equal((await f.query('counts')).activeSubagents, 1);
  f.row(legacy).lastSeen = f.now - 900_000;
  f.row(legacy).lastActivity = f.row(legacy).lastSeen; // Inclusive stale-window boundary.
  assert.equal((await f.query('counts')).activeAgents, 1);
});

test('parent links require a live same-project, same-actor, same-credential session and cannot cycle', async t => {
  const f = fixture(t),
    parent = randomUUID();
  f.identity('owner', 'device-a');
  await f.publish(parent);
  const child = randomUUID(),
    operationId = randomUUID();
  await f.publish(child, { parentSessionId: parent }, operationId);
  f.row(parent).lastSeen = f.now - 900_001;
  f.row(parent).lastActivity = f.row(parent).lastSeen;
  // A replay reconciles even when its formerly live parent is stale.
  assert.equal((await f.publish(child, { parentSessionId: parent }, operationId)).operationId, operationId);
  await assert.rejects(f.publish(randomUUID(), { parentSessionId: parent }), /active parent/);
  f.row(parent).lastSeen = f.now;
  f.row(parent).lastActivity = f.now;
  f.identity('other', 'device-other');
  await assert.rejects(f.publish(randomUUID(), { parentSessionId: parent }), /same actor and credential/);
  f.identity('owner', 'device-b');
  await assert.rejects(f.publish(randomUUID(), { parentSessionId: parent }), /same actor and credential/);
  f.identity('owner', 'device-a');
  await assert.rejects(
    f.publish(parent, { sequence: 2, sessionKind: 'subagent', parentSessionId: child }),
    /cycle/,
  );
  await assert.rejects(
    f.publish(parent, { sequence: 2, sessionKind: 'subagent', parentSessionId: parent }),
    /cycle/,
  );
  const person = randomUUID();
  await assert.rejects(
    f.publish(person, { sessionKind: 'person', parentSessionId: parent }),
    /kind subagent/,
  );
  const foreign = randomUUID();
  await f.publish(foreign);
  f.row(foreign).projectId = 'foreign';
  await assert.rejects(f.publish(randomUUID(), { parentSessionId: foreign }), /active parent/);
  const legacy = randomUUID();
  f.identity('owner');
  await f.publish(legacy);
  delete f.row(legacy).kind;
  delete f.row(legacy).harness;
  f.identity('owner', 'device-a');
  await f.publish(legacy, { sequence: 2 });
  await f.publish(randomUUID(), { parentSessionId: legacy });
  await f.publish(parent, { sequence: 2, status: 'completed' });
  await assert.rejects(f.publish(randomUUID(), { parentSessionId: parent }), /active parent/);
  const sessions = await f.query('sessions', { paginationOpts: { cursor: null, numItems: 50 } });
  assert.ok(!JSON.stringify(sessions).includes('device-a'));
  assert.ok(!JSON.stringify(sessions).includes('credentialId'));
});

function seedIndex(f) {
  f.tables.hostedProjects.get('project').work = {
    backupId: 'backup',
    revision: 1,
    generationId: 'generation',
  };
  f.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    projectId: 'project',
    backupId: 'backup',
    revision: 1,
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    recordsGenerationId: 'partition',
  });
  const add = (collection, key, value) =>
    f.tables.projectWorkRecords.set(`${collection}:${key}`, {
      _id: `${collection}:${key}`,
      projectId: 'project',
      generationId: 'partition',
      collection,
      key,
      position: 0,
      ...activityFields(collection, value),
      value: JSON.stringify(value),
    });
  return add;
}
test('active Lanes include saves, imported checks and claims without announcements; identities never enter public counts', async t => {
  const f = fixture(t),
    add = seedIndex(f);
  const iso = age => new Date(f.now - age).toISOString();
  add('lanes', 'saved', { id: 'saved', lastCheckpointAt: iso(60_000) });
  add('lanes', 'old', { id: 'old', lastCheckpointAt: iso(900_001) });
  add('lanes', 'boundary', { id: 'boundary', lastCheckpointAt: iso(900_000) });
  add('lanes', 'no-save', { id: 'no-save' });
  add('views', 'view', { inputs: [{ laneId: 'checked' }, { laneId: 'saved' }] });
  add('runs', 'run', { viewId: 'view', startedAt: iso(1_000_000), endedAt: iso(30_000) });
  add('runs', 'old-run', { viewId: 'view', startedAt: iso(1_000_000) });
  add('views', 'local-view', { inputs: [{ laneId: 'local-checked' }] });
  f.tables.projectCheckRequests.set('request', {
    projectId: 'project',
    viewId: 'local-view',
    updatedAt: f.now,
    report: { startedAt: iso(5000) },
  });
  const sessionId = randomUUID();
  await f.publish(sessionId, { context: { laneId: 'saved' } });
  // A 30-minute-old claim still attributes a recently checked Lane to a live session.
  f.tables.projectCoordinationClaims.set('old-claim', {
    projectId: 'project',
    laneId: 'checked',
    sessionId,
    at: f.now - 1_800_000,
    expiresAt: f.now + 60_000,
  });
  await coordination.publish._handler(f.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    command: { kind: 'claim', paths: ['synthetic.ts'], laneId: 'claimed', ttlSeconds: 60 },
  });
  f.tables.projectCoordinationEvents.set('return', {
    projectId: 'project',
    at: f.now,
    command: { kind: 'change', source: 'return', laneId: 'returned' },
  });
  f.tables.projectCoordinationEvents.set('note', {
    projectId: 'project',
    at: f.now,
    command: { kind: 'change', source: 'work', action: 'note', laneId: 'only-a-note' },
  });
  const expected = { ...empty, activeAgents: 1, activeLanes: 6, unannouncedActiveLanes: 4 };
  assert.deepEqual(await f.query('counts'), expected);
  // CLI/MCP dispatch exposes the same counts action.
  assert.deepEqual(
    await dispatchCoordination(
      { query: (_ref, args) => coordination.counts._handler(f.ctx, args) },
      'project',
      { action: 'counts' },
    ),
    expected,
  );
  await assert.rejects(f.query('publicCounts'), /public project is unavailable/);
  f.tables.hostedProjects.get('project').visibility = 'public';
  f.identity(null);
  const aggregate = await f.query('publicCounts');
  assert.deepEqual(aggregate, expected);
  assert.deepEqual(Object.keys(aggregate).sort(), Object.keys(empty).sort());
  assert.ok(Object.values(aggregate).every(value => typeof value === 'number'));
  await assert.rejects(f.query('sessions', { paginationOpts: { cursor: null, numItems: 50 } }), /Sign in/);
  await assert.rejects(f.query('counts'), /Sign in/);
  f.tables.hostedProjects.get('project').visibility = 'private';
  f.identity('outsider');
  await assert.rejects(f.query('counts'), /unavailable/);
  f.tables.hostedProjects.get('project').visibility = 'public';
  f.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(f.query('publicCounts'), /unavailable/);
  f.tables.hostedProjects.delete('project');
  await assert.rejects(f.query('publicCounts'), /unavailable/);
});

test('stale attributed sessions leave active Lanes unannounced; no announcement alone counts as a save', async t => {
  const f = fixture(t),
    sessionId = randomUUID();
  await f.publish(sessionId, { context: { laneId: 'merely-announced' } });
  assert.deepEqual(await f.query('counts'), { ...empty, activeAgents: 1 });
  await coordination.publish._handler(f.ctx, {
    projectId: 'project',
    operationId: randomUUID(),
    command: { kind: 'claim', sessionId, paths: ['file.ts'], laneId: 'claimed', ttlSeconds: 60 },
  });
  assert.deepEqual(await f.query('counts'), { ...empty, activeAgents: 1, activeLanes: 1 });
  f.row(sessionId).lastSeen = f.now - 900_001;
  f.row(sessionId).lastActivity = f.row(sessionId).lastSeen;
  assert.deepEqual(await f.query('counts'), { ...empty, activeLanes: 1, unannouncedActiveLanes: 1 });
  for (const event of f.tables.projectCoordinationEvents.values()) event.at -= 900_001;
  assert.deepEqual(await f.query('counts'), empty);
});

test('MCP detects initialize metadata/environment and inherits parent without merging child session identity', () => {
  assert.deepEqual(detectHarness({}, { name: 'claude-code', version: '2.1' }), {
    harness: 'claude-code',
    harnessVersion: '2.1',
  });
  for (const [name, harness] of [
    ['Codex', 'codex'],
    ['Cursor', 'cursor'],
    ['pi-coding-agent', 'pi'],
  ])
    assert.equal(detectHarness({}, { name, version: '1' }).harness, harness);
  assert.deepEqual(detectHarness({ CODEX_THREAD_ID: 'thread', CODEX_VERSION: '0.8' }), {
    harness: 'codex',
    harnessVersion: '0.8',
  });
  assert.equal(detectHarness({ CLAUDECODE: '1' }).harness, 'claude-code');
  assert.equal(detectHarness({ CURSOR_AGENT: '1' }).harness, 'cursor');
  assert.equal(detectHarness({ PI_CODING_AGENT_DIR: '/synthetic' }).harness, 'pi');
  assert.deepEqual(detectHarness({}), { harness: 'other' });
  const parent = randomUUID(),
    env = { FORGE_PARENT_SESSION: parent };
  const declaration = sessionDeclaration(env, () => ({ name: 'codex', version: '1' }));
  env.FORGE_PARENT_SESSION = randomUUID();
  assert.deepEqual(declaration(), {
    parentSessionId: parent,
    sessionKind: 'subagent',
    harness: 'codex',
    harnessVersion: '1',
  });
  const person = sessionDeclaration({})({ kind: 'person', harness: 'cursor', harnessVersion: '3' });
  assert.equal(person.sessionKind, 'person');
  assert.deepEqual(sessionDeclaration({})({}, person), person);
});

test('quiet activity does not deny a subagent link when its parent still reports heartbeats', async t => {
  const f = fixture(t),
    parent = randomUUID(),
    child = randomUUID();
  await f.publish(parent);
  f.row(parent).lastActivity = f.now - 25 * 60_000;
  assert.equal((await f.query('counts')).activeAgents, 0);
  await f.publish(child, { parentSessionId: parent, sessionKind: 'subagent' });
  assert.equal(f.row(child).parentSessionId, parent);
});
