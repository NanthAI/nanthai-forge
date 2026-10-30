// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { setup } from './hosted-planning-fixture.mjs';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { NativeSource } from '../dist/native-source.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { localBrief } from '../dist/agent-brief-local.js';
import { fixture } from './helpers.mjs';
import { initNative } from '../dist/native-work.js';
import { coordinationChoicesSchema } from '../dist/coordination-types.js';
import { dispatchCoordination } from '../dist/coordination-dispatch.js';
import { getFunctionName } from 'convex/server';
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const actorNames = await import(moduleUrl('../convex/projectActorNames.ts'));
const people = await import(moduleUrl('../convex/projectPeopleActions.ts'));
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const reads = await import(moduleUrl('../convex/projectCoordinationReads.ts'));
const readPage = (s, collection) =>
  index.records._handler(s.ctx, {
    projectId: s.projectId,
    collection,
    paginationOpts: { cursor: null, numItems: 100 },
  });

test('native hosted summaries track actual ancestry when main moves without reading source or scanning history', async t => {
  let pins;
  const s = await setup(t, true, (root, local) => {
    const data = local.store.load(),
      source = new NativeSource(root),
      a = data.nativeHead;
    const files = source.state(a).files;
    const b = source.writeState(files, [a], 'B', 'now'),
      c = source.writeState(files, [a], 'C', 'now'),
      d = source.writeState(files, [b, c], 'D', 'now');
    const intentId = randomUUID();
    data.intents.push({
      id: intentId,
      outcome: 'Ancestry',
      constraints: '',
      base: a,
      notes: [],
      status: 'active',
      createdAt: 'now',
    });
    const views = [a, b, c, d].map(head => ({
      id: randomUUID(),
      intentId,
      base: a,
      head,
      inputs: [],
      status: 'clean',
      details: '',
      at: 'now',
    }));
    data.views.push(...views);
    data.lanes.push(
      ...[a, b, c, d].map(head => ({
        id: randomUUID(),
        intentId,
        name: head.slice(0, 8),
        base: a,
        head,
        state: 'active',
        assignment: '',
        target: '',
        checkpoints: [],
      })),
    );
    data.channelMoves.push(
      ...views.slice(0, 2).map((view, i) => ({
        id: randomUUID(),
        channel: 'main',
        viewId: view.id,
        head: view.head,
        previous: i ? a : null,
        at: 'now',
        status: 'accepted',
        provenance: 'user-declared-local',
      })),
    );
    const check = {
      id: randomUUID(),
      name: 'verify',
      executable: 'node',
      args: [],
      environmentLabel: '',
      definition: a,
      at: 'now',
    };
    data.runs.push({
      id: randomUUID(),
      viewId: views[3].id,
      head: c,
      base: a,
      inputs: [],
      dependencies: [],
      check,
      environment: {
        platform: 'fixture',
        arch: 'fixture',
        os: 'fixture',
        node: '24',
        env: {},
        fingerprint: a,
      },
      runner: { pid: 1, host: 'synthetic' },
      status: 'passed',
      details: '',
      startedAt: 'now',
    });
    data.revision++;
    local.store.save(data);
    pins = { a, b, c, d, views, moves: data.channelMoves };
  });
  await indexActions.ensure._handler(s.ctx, { rebuild: true, projectId: s.projectId });
  let summaries = (await readPage(s, 'views')).page.map(row => JSON.parse(row.value));
  assert.deepEqual(
    summaries.map(v => v.main),
    [false, true, false, true].map(included => ({ head: pins.b, included })),
  );
  assert.deepEqual(
    (await readPage(s, 'lanes')).page.map(row => JSON.parse(row.value).main.included),
    [true, true, false, false],
    'Lane heads already in main are done; a descendant containing main is still open',
  );
  // Seed the historical display projection directly: the owner acceptance
  // publication RPC is retired; these assertions exercise summary reads.
  const generation = [...s.tables.projectWorkGenerations.values()].find(row => row.status === 'ready');
  const select = async move => {
    const old = [...s.tables.projectWorkRecords.values()].find(
      row => row.collection === 'hostedChannels' && row.key === 'main',
    );
    const row = {
      projectId: s.projectId,
      generationId: generation.recordsGenerationId ?? generation._id,
      collection: 'hostedChannels',
      key: 'main',
      parent: '',
      position: 0,
      value: JSON.stringify({ ...move, actor: 'owner' }),
    };
    if (old) await s.ctx.db.patch(old._id, row);
    else await s.ctx.db.insert('projectWorkRecords', row);
  };
  // First select A, then advance the display projection to B.
  await select(pins.moves[0]);
  assert.deepEqual(
    (await readPage(s, 'views')).page.map(row => JSON.parse(row.value).main.included),
    [true, true, true, true],
  );
  assert.deepEqual(
    (await readPage(s, 'lanes')).page.map(row => JSON.parse(row.value).main.included),
    [true, false, false, false],
    'Lane membership is recomputed against the newly selected main',
  );
  await select(pins.moves[1]);
  s.ctx.storage.getUrl = s.ctx.storage.get = async () => assert.fail('summary reads never fetch source');
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    assert.notEqual(table, 'projectWorkEvents');
    return query(table);
  };
  summaries = (await readPage(s, 'views')).page.map(row => JSON.parse(row.value));
  assert.deepEqual(
    summaries.map(v => v.main.included),
    [false, true, false, true],
  );
  assert.equal(
    JSON.parse((await readPage(s, 'runs')).page[0].value).main.included,
    false,
    'run compares its exact head',
  );
  const detail = await index.detail._handler(s.ctx, {
    projectId: s.projectId,
    collection: 'views',
    id: pins.views[3].id,
  });
  assert.equal(JSON.parse(detail.value).main.included, true);
  s.tables.projectActorNames.set('label', {
    _id: 'label',
    projectId: s.projectId,
    actor: 'owner',
    displayName: 'Maya',
  });
  assert.equal(JSON.parse((await readPage(s, 'hostedChannels')).page[0].value).actorDisplayName, 'Maya');
  const beforeQuery = s.ctx.db.query;
  s.ctx.db.query = table => {
    assert.notEqual(table, 'projectActorNames', 'denied readers never look up identities');
    return beforeQuery(table);
  };
  s.caller('outsider');
  await assert.rejects(readPage(s, 'hostedChannels'), /unavailable/);
  await assert.rejects(
    index.detail._handler(s.ctx, { projectId: s.projectId, collection: 'hostedChannels', id: 'main' }),
    /unavailable/,
  );
});

test('brief machine/config observations stay local to the Lane host and live MCP is evidence', async t => {
  const root = join(fixture(t), 'native');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'source');
  initNative(root);
  const agent = new AgentWorkflow(root),
    lane = (await agent.dispatch({ action: 'start', outcome: 'Setup', actor: 'codex-8', tool: 'codex' }))
      .result;
  assert.deepEqual(lane.startedBy, { kind: 'agent', name: 'codex-8', tool: 'codex' });
  const input = { situation: 'continue-lane', laneId: lane.laneId };
  assert.equal(localBrief(agent.work.store, input).setup.machine, process.env.FORGE_MACHINE ?? hostname());
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { forge: { command: process.execPath, args: ['cli', 'mcp', '/another-owner', '--agent'] } },
    }),
  );
  const unknown = localBrief(agent.work.store, input).setup.mcpConfigured;
  assert.equal(localBrief(agent.work.store, input, true).setup.mcpConfigured, true);
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { forge: { command: process.execPath, args: ['cli', 'mcp', root, '--agent'] } },
    }),
  );
  assert.equal(localBrief(agent.work.store, input).setup.mcpConfigured, true);
  assert.equal(unknown, false);
});

test('choice answers imply ack, reconcile retries, enforce recipient and reach sender inbox/feed', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    key: randomUUID(),
    name: 'Project',
    revision: 1,
    currentBackup: null,
  });
  s.tables.projectContributors.set('grant', { _id: 'grant', projectId: 'project', contributor: 'recipient' });
  const transport = Object.fromEntries(
    ['query', 'mutation'].map(kind => [
      kind,
      (ref, args) => {
        const [module, method] = getFunctionName(ref).split(':');
        return { projectCoordination: coordination, projectCoordinationReads: reads }[module][
          method
        ]._handler(s.ctx, args);
      },
    ]),
  );
  const send = input => dispatchCoordination(transport, 'project', input);
  const choices = ['Yes, rename it', 'Keep lastSeen'];
  const message = await send({ action: 'message', to: 'recipient', text: 'Rename?', choices });
  s.caller('recipient');
  const inbox = await send({ action: 'inbox' });
  assert.deepEqual(inbox.items[0].choices, choices);
  await assert.rejects(
    send({ action: 'ack', messageId: message.operationId, choice: 'Something else' }),
    /exact choices/,
  );
  const input = {
    action: 'ack',
    operationId: randomUUID(),
    messageId: message.operationId,
    choice: choices[0],
  };
  const answer = await send(input);
  assert.deepEqual(await send(input), answer);
  assert.equal((await send({ action: 'unacked' })).items.length, 0);
  assert.equal([...s.tables.projectCoordinationReceipts.values()][0].choice, choices[0]);
  await assert.rejects(
    send({ ...input, operationId: randomUUID(), choice: choices[1] }),
    /already has your chosen answer/,
  );
  s.caller('owner');
  await assert.rejects(send({ ...input, operationId: randomUUID() }), /recipient session/);
  const sender = await send({ action: 'inbox' });
  assert.equal(sender.items[0].choice, choices[0]);
  assert.equal((await send({ action: 'feed' })).page.at(-1).command.choice, choices[0]);
  for (const invalid of [
    [],
    ['one'],
    ['a', 'b', 'c', 'd'],
    ['x'.repeat(121), 'b'],
    ['same', 'same'],
    [' ', 'b'],
  ])
    assert.equal(coordinationChoicesSchema.safeParse(invalid).success, false);
  assert.equal(coordinationChoicesSchema.safeParse(['a', 'b', 'c']).success, true);
});

test('hosted actor labels are project scoped, omit email fallback and recheck access after Clerk lookup', async t => {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    key: randomUUID(),
    name: 'Project',
    revision: 1,
    currentBackup: null,
  });
  const originalFetch = globalThis.fetch,
    secret = process.env.CLERK_SECRET_KEY;
  process.env.CLERK_SECRET_KEY = 'synthetic';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (secret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = secret;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ id: 'owner', email_addresses: [{ email_address: 'private@example.invalid' }] }),
      { status: 200 },
    );
  };
  const request = { projectId: 'project', actors: ['owner'] };
  assert.deepEqual(await people.labels._handler(s.ctx, request), [
    { actor: 'owner', displayName: 'Forge contributor' },
  ]);
  assert.ok(!JSON.stringify([...s.tables.projectActorNames.values()]).includes('@'));
  await assert.rejects(
    people.labels._handler(s.ctx, { ...request, actors: ['unrelated'] }),
    /already visible/,
  );
  s.caller('outsider');
  await assert.rejects(people.labels._handler(s.ctx, request), /unavailable/);
  s.caller(null);
  await assert.rejects(people.labels._handler(s.ctx, request), /Sign in/);
  assert.equal(calls, 1);
  s.tables.projectContributors.set('grant', { _id: 'grant', projectId: 'project', contributor: 'reader' });
  s.caller('reader');
  s.tables.projectContributors.set('hidden', {
    _id: 'hidden',
    projectId: 'project',
    contributor: 'hidden-member',
  });
  await assert.rejects(
    people.labels._handler(s.ctx, { projectId: 'project', actors: ['hidden-member'] }),
    /already visible/,
  );
  s.tables.projectActorNames.set('unrelated-cache', {
    _id: 'unrelated-cache',
    projectId: 'project',
    actor: 'unrelated',
    displayName: 'Private identity',
  });
  assert.equal(
    await actorNames.actorSummary(s.ctx, 'project', JSON.stringify({ actor: 'unrelated' })),
    JSON.stringify({ actor: 'unrelated' }),
    'untrusted source actor declarations cannot disclose cached identities',
  );

  globalThis.fetch = async () => {
    s.tables.projectContributors.clear();
    return new Response(JSON.stringify({ id: 'owner', first_name: 'Private' }), { status: 200 });
  };
  await assert.rejects(people.labels._handler(s.ctx, request), /unavailable/);
  assert.equal([...s.tables.projectActorNames.values()][0].displayName, 'Forge contributor');
});

for (const format of ['sha1', 'sha256'])
  test(`hosted ${format} summaries derive Git ancestry from the stored bundle`, async t => {
    const { workGit } = await import('../dist/work-git.js');
    let heads;
    const s = await setup(t, false, (root, local) => {
      if (format === 'sha256') {
        rmSync(join(root, '.git'), { recursive: true, force: true });
        workGit(root, ['init', '--object-format=sha256', '--template=', '--initial-branch=main']);
        mkdirSync(local.store.directory, { recursive: true });
        workGit(root, ['add', '.']);
        workGit(root, [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'Original',
        ]);
      }
      const base = workGit(root, ['rev-parse', 'HEAD']).trim();
      const commit = (parents, message) =>
        workGit(root, [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit-tree',
          `${base}^{tree}`,
          ...parents.flatMap(p => ['-p', p]),
          '-m',
          message,
        ]).trim();
      const current = commit([base], 'Main'),
        divergent = commit([base], 'Other'),
        merged = commit([current, divergent], 'Merge');
      const data = local.store.load(),
        intentId = randomUUID();
      data.intents.push({
        id: intentId,
        outcome: 'Git ancestry',
        constraints: '',
        base,
        notes: [],
        status: 'active',
        createdAt: 'now',
      });
      const views = [current, divergent, merged].map(head => ({
        id: randomUUID(),
        intentId,
        base,
        head,
        inputs: [],
        status: 'clean',
        details: '',
        at: 'now',
      }));
      data.views.push(...views);
      const move = {
        id: randomUUID(),
        channel: 'main',
        viewId: views[0].id,
        head: current,
        previous: null,
        at: 'now',
        status: 'accepted',
        provenance: 'user-declared-local',
      };
      data.channelMoves.push(move);
      for (const view of views) workGit(root, ['update-ref', `refs/forge/views/${view.id}`, view.head]);
      workGit(root, ['update-ref', `refs/forge/channel-moves/${move.id}`, current]);
      workGit(root, ['update-ref', 'refs/forge/channels/main', current]);
      data.revision++;
      local.store.save(data);
      heads = { current, views };
    });
    await indexActions.ensure._handler(s.ctx, { rebuild: true, projectId: s.projectId });
    const page = (await readPage(s, 'views')).page.map(row => JSON.parse(row.value));
    assert.deepEqual(
      page.map(view => view.main),
      [true, false, true].map(included => ({ head: heads.current, included })),
    );
  });

test('unavailable derived ancestry leaves retained Work readable and cannot bypass current authorization', async t => {
  const s = await setup(t, true, (root, local) => {
    const data = local.store.load(),
      source = new NativeSource(root),
      base = data.nativeHead;
    const head = source.writeState(source.state(base).files, [base], 'View', 'now');
    const intentId = randomUUID(),
      viewId = randomUUID();
    data.intents.push({
      id: intentId,
      outcome: 'Unavailable source',
      constraints: '',
      base,
      notes: [],
      status: 'active',
      createdAt: 'now',
    });
    data.views.push({
      id: viewId,
      intentId,
      base,
      head,
      inputs: [],
      status: 'clean',
      details: '',
      at: 'now',
    });
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId,
      head: base,
      previous: null,
      at: 'now',
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    data.revision++;
    local.store.save(data);
  });
  const { load } = await import(moduleUrl('../convex/projectWorkActions.ts'));
  const { sourceParents } = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
  const { materializeWork } = await import('../dist/work-hosted-index.js');
  const snapshot = await load(s.ctx, s.projectId, 'owner');
  const original = s.ctx.storage.getUrl;
  s.ctx.storage.getUrl = async id => (id === 'source' ? null : original(id));
  const parents = await sourceParents(s.ctx, snapshot.backup, snapshot.manifest, snapshot.data, 'owner');
  assert.equal(parents.size, 0);
  const projection = materializeWork(
    snapshot.data,
    snapshot.manifest,
    snapshot.events,
    snapshot.backup.transport,
    parents,
  );
  assert.equal(
    JSON.parse(projection.entries.find(row => row.collection === 'views').value).main.included,
    null,
  );
  assert.equal(
    JSON.parse(projection.entries.find(row => row.collection === 'intents').value).outcome,
    'Unavailable source',
  );
  s.caller('outsider');
  await assert.rejects(
    sourceParents(s.ctx, snapshot.backup, snapshot.manifest, snapshot.data, 'outsider'),
    /unavailable/,
  );
});
