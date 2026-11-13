// SPDX-License-Identifier: Apache-2.0
// Issue c29d0780: each agent session shows as handle/word-word; a person shows as plain @handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import {
  AGENT_SLUG_ADJECTIVES,
  AGENT_SLUG_NOUNS,
  actorLabel,
  agentActor,
  isAgentSlug,
  splitAgentActor,
} from '../dist/agent-slug.js';
import { agentSlug, sessionAgentSlug } from '../dist/agent-slug-session.js';
import { AGENT_CLIENTS, resolveAgentSession, nearestAgentProcess } from '../dist/agent-session.js';
import {
  boardNoticeLine,
  readBoardServerFeatures,
  rememberBoardServerFeatures,
} from '../dist/board-local.js';
import { hostedOverlapAdvice } from '../dist/hosted-overlap.js';
import { presenceNotice } from '../dist/hosted-presence.js';
import { touchingLine } from '../dist/agent-edit-hosted.js';
import { hostedStartSchema } from '../dist/hosted-lane.js';
import { agentCli } from '../dist/agent-cli.js';
import { moduleUrl } from './convex-module.mjs';
import { board, boardFixture } from './board-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
const { actionPublicPeople } = await import(moduleUrl('../convex/publicPeople.ts'));
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const peerWait = await import(moduleUrl('../convex/projectBoardWait.ts'));

const code = expected => error => (error.data?.code ?? error.code) === expected;
const slug = /^[a-z]{2,10}-[a-z]{2,10}$/;

test('slugs: fixed public word lists, strict validation, labels tell agents from people', () => {
  for (const list of [AGENT_SLUG_ADJECTIVES, AGENT_SLUG_NOUNS]) {
    assert.equal(new Set(list).size, list.length, 'no repeated word');
    assert(list.length >= 150, 'enough words that concurrent sessions rarely share a slug');
    assert(list.every(word => /^[a-z]{2,10}$/.test(word)));
  }
  assert.equal(isAgentSlug('quiet-otter'), true);
  for (const bad of ['quiet-Otter', 'quiet-dino', 'otter-quiet', 'quiet_otter', 'quiet-otter-x', '', 7, null])
    assert.equal(isAgentSlug(bad), false, String(bad));
  assert.equal(agentActor('acct', 'quiet-otter'), 'acct/quiet-otter');
  assert.equal(agentActor('acct'), 'acct');
  assert.equal(agentActor('acct', 'not a slug'), 'acct', 'an unknown value is never shown');
  assert.deepEqual(splitAgentActor('thevarsek/quiet-otter'), { actor: 'thevarsek', agent: 'quiet-otter' });
  for (const other of ['thevarsek', 'src/quiet-otter.ts', 'lane:quiet-otter', '/quiet-otter', 'a/b-c'])
    assert.equal(splitAgentActor(other), null, other);
  assert.equal(actorLabel('thevarsek/quiet-otter'), 'thevarsek/quiet-otter');
  assert.equal(actorLabel('thevarsek'), '@thevarsek');
  assert.equal(actorLabel(undefined), 'a member');
});

test('session slug: stable for one session across calls and restarts, new for a new session, none for a person', () => {
  const claude = { CLAUDE_CODE_SESSION_ID: '6f0c2b9e-1111-4c2d-9a3b-000000000001' };
  const first = sessionAgentSlug(undefined, claude);
  assert.match(first, slug);
  assert(isAgentSlug(first));
  // A restarted CLI process reads the same session id from the agent client: same slug, no state kept.
  assert.equal(sessionAgentSlug(undefined, { ...claude }), first);
  assert.equal(agentSlug(claude.CLAUDE_CODE_SESSION_ID), first);
  const other = sessionAgentSlug(undefined, {
    CLAUDE_CODE_SESSION_ID: '6f0c2b9e-1111-4c2d-9a3b-000000000002',
  });
  assert.notEqual(other, first, 'a new session gets a new slug');
  // Codex threads, MCP sessions and other agent clients name their own session.
  assert.match(sessionAgentSlug(undefined, { CODEX_THREAD_ID: 'thread-1' }), slug);
  assert.equal(sessionAgentSlug('mcp:abc', {}), agentSlug('mcp:abc'));
  assert.equal(sessionAgentSlug(undefined, { FORGE_AGENT_SESSION: 'cursor-1' }), agentSlug('cursor-1'));
  // A person: no session id at all, an explicit human flag, or an explicit "no session".
  assert.equal(sessionAgentSlug(undefined, {}), undefined);
  assert.equal(sessionAgentSlug(undefined, { ...claude, FORGE_HUMAN: '1' }), undefined);
  assert.equal(sessionAgentSlug(null, claude), undefined);
  // The slug never carries the session id, a machine name, a path or an account id.
  assert(!first.includes(claude.CLAUDE_CODE_SESSION_ID.slice(0, 8)));
  // Spread over the word space: 200 sessions give many distinct slugs.
  const many = new Set(Array.from({ length: 200 }, (_, i) => agentSlug(`session-${i}`)));
  assert(many.size >= 195, `distinct slugs ${many.size}`);
});

test('board (server): two agent sessions of one account read as different handle/slug; a person as plain @handle', async () => {
  const f = boardFixture();
  f.lanes.D = randomUUID();
  f.lane('D', 'owner', true);
  const [one, two] = ['quiet-otter', 'brave-falcon'];
  await f.post({ to: `lane:${f.lanes.D}`, laneId: f.lanes.B, text: 'B here: taking src/x.ts', agent: one });
  const postReads = f.invoke.reads;
  await f.post({ to: `lane:${f.lanes.B}`, laneId: f.lanes.D, text: 'D here: fine, I skip it', agent: two });
  await f.post({ to: `lane:${f.lanes.B}`, text: 'Owner: please land B first' });
  const forD = await f.read({ laneId: f.lanes.D });
  assert.deepEqual(
    forD.messages.map(m => m.author),
    ['owner-h/quiet-otter'],
  );
  const forB = await f.read({ laneId: f.lanes.B });
  assert.deepEqual(forB.messages.map(m => m.author).sort(), ['owner-h', 'owner-h/brave-falcon']);
  assert.doesNotMatch(JSON.stringify([forB, forD]), /"owner["/]/, 'no account id, with or without a slug');
  const lines = forB.messages.map(m => boardNoticeLine(m, f.lanes.B));
  assert(lines.some(line => line.includes(`from owner-h/brave-falcon (Lane ${f.lanes.D.slice(0, 8)})`)));
  assert(lines.some(line => line.includes('from @owner-h to your Lane')));
  // A contributor sees the slug too; readers and strangers see no person at all.
  const thread = await f.read({ id: forD.messages[0].id }, 'writer');
  assert.equal(thread.message.author, 'owner-h/quiet-otter');
  await assert.rejects(f.read({ id: forD.messages[0].id }, 'reader'), code('PROJECT_UNAVAILABLE'));
  // Only word-list slugs are stored: anything else is refused, not shown.
  for (const agent of ['Quiet-otter', 'dino-laptop', 'quiet-otter/x', 'user_ABCDEFGH12'])
    await assert.rejects(f.post({ to: 'project', text: `bad ${agent}`, agent }), code('BAD_ARGUMENT'));
  const row = [...f.tables.projectBoardMessages.values()].find(m => m.body.startsWith('B here'));
  assert.deepEqual([row.author, row.agent], ['owner', one], 'account and slug are stored apart');
  // Cost: the slug adds no read to a post.
  const plain = await f.post({ to: 'project', text: 'cost probe' });
  assert.equal(plain.status, 'posted');
  assert(f.invoke.reads <= postReads + 1, `post reads ${f.invoke.reads} vs ${postReads}`);
});

test('board post (CLI): the slug goes only to a server that takes it; a rolled-back server gets one plain retry', async t => {
  const { boardHostedSource } = await import('../dist/hosted-board.js');
  const root = join(mkdtempSync(join(tmpdir(), 'forge-slug-board-')), 'client');
  t.after(() => rmSync(dirname(root), { recursive: true, force: true }));
  const calls = [];
  let reject = false;
  const transport = features => ({
    root,
    address: { url: 'https://fixture.invalid', projectId: 'project' },
    advertisedFeatures: features,
    agentSlug: () => 'quiet-otter',
    query: async () => ({}),
    mutation: async (name, args) => {
      calls.push(args);
      if (reject && 'agent' in args)
        throw new Error(
          'ArgumentValidationError: Object contains extra field `agent` that is not in the validator.',
        );
      return { status: 'posted' };
    },
  });
  await boardHostedSource(transport(['agent-board']), 'board-post', { to: 'project', text: 'a' });
  await boardHostedSource(transport(['agent-board', 'agent-slug']), 'board-post', {
    to: 'project',
    text: 'b',
  });
  reject = true;
  await boardHostedSource(transport(['agent-slug']), 'board-post', { to: 'project', text: 'c' });
  assert.deepEqual(
    calls.map(args => [args.text, args.agent]),
    [
      ['a', undefined],
      ['b', 'quiet-otter'],
      ['c', 'quiet-otter'],
      ['c', undefined],
    ],
  );
  assert.equal(calls[2].operationId, calls[3].operationId, 'the retry is the same note');
});

test('public identity (actions): ACCOUNT/slug maps to handle/slug through the one batched lookup', async () => {
  const asked = [];
  const ctx = {
    runQuery: async (_ref, args) => {
      asked.push(...args.values);
      return {
        view: {
          writer: true,
          owner: true,
          values: args.values.map(value => ({
            value,
            person: value === 'acct',
            ...(value === 'acct' ? { handle: 'owner-h' } : {}),
          })),
        },
        subjects: [],
      };
    },
  };
  const result = await actionPublicPeople(ctx, { projectId: 'p' }, { actor: 'acct/quiet-otter', by: 'acct' });
  assert.deepEqual(result, { actor: 'owner-h/quiet-otter', by: 'owner-h' });
  assert.deepEqual([...new Set(asked)], ['acct'], 'one lookup for the account, none for the slug');
});

async function startProject() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  s.insert('forgeAccounts', { owner: 'owner', handle: 'owner-h' });
  const head = 'a'.repeat(64);
  const main = {
    schema: 2,
    projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  await s.call('seed', channels.seed, {
    projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  const input = (intent, extra = {}) => ({
    projectId,
    operationId: randomUUID(),
    authorityEpoch: 1,
    expectedMain: { head, receiptId: 'main-0' },
    intent,
    ...extra,
  });
  const begin = async args => JSON.parse(await s.call('start', start.start, args));
  return { s, projectId, input, begin };
}

test('supported clients: concurrent sessions see each other in presence and keep their own run across Lanes', async () => {
  const clients = [
    n => sessionAgentSlug(undefined, { CLAUDE_CODE_SESSION_ID: `claude-${n}` }),
    n => sessionAgentSlug(undefined, { CODEX_THREAD_ID: `codex-${n}` }),
    n => sessionAgentSlug(`mcp:${n}`, {}),
    n => sessionAgentSlug(undefined, { FORGE_AGENT_SESSION: `task-${n}` }),
  ];
  for (const identify of clients) {
    const { s, projectId, input, begin } = await startProject();
    const [one, two] = [identify(1), identify(2)];
    assert.notEqual(one, two);
    const first = await begin(input({ kind: 'new', outcome: 'Same work' }, { agent: one }));
    const second = await begin(input({ kind: 'existing', intentId: first.intentId }, { agent: two }));
    const another = await begin(
      input({ kind: 'existing', intentId: first.intentId }, { agent: identify(1) }),
    );
    const presence = async laneId =>
      JSON.parse(await s.call('read', overlaps.read, { projectId, laneId, presence: {} })).presence.lanes;
    assert.ok((await presence(first.lane.laneId)).some(lane => lane.laneId === second.lane.laneId));
    assert.ok((await presence(second.lane.laneId)).some(lane => lane.laneId === first.lane.laneId));
    assert.ok(
      !(await presence(first.lane.laneId)).some(lane => lane.laneId === another.lane.laneId),
      'own Lanes stay in the same run',
    );
  }
});

test('all detected clients and explicit editor sessions see parent and sibling peers without reporting their own other Lane', async () => {
  const cases = [
    ...AGENT_CLIENTS.map(client => n => {
      const env = {
        CLAUDE_CODE_SESSION_ID: 'parent-claude',
        CODEX_THREAD_ID: 'parent-codex',
        ...(client.sessionVariable ? { [client.sessionVariable]: `child-${n}` } : {}),
      };
      const ancestor = nearestAgentProcess(
        pid =>
          ({
            30: { ppid: 20 + n, command: '/bin/sh', started: 'shell-start' },
            [20 + n]: {
              ppid: 10,
              command: `/tools/${client.executables[0].replace('*', 'fixture')}`,
              started: 'client-start',
            },
            10: { ppid: 1, command: '/tools/T3', started: 'parent-start' },
          })[pid],
        30,
      );
      return resolveAgentSession(env, ancestor).key;
    }),
    n =>
      resolveAgentSession({
        CLAUDE_CODE_SESSION_ID: 'ambient-parent',
        FORGE_AGENT_SESSION: `lead-proof-${n}`,
      }).key,
    // Cline/Roo/Kilo and editor-owned ACP terminals can share one plugin host:
    // the documented explicit declaration supplies the otherwise missing session signal.
    ...['cline', 'roo', 'kilo', 'zed-acp'].map(
      client => n => resolveAgentSession({ FORGE_AGENT_SESSION: `${client}-${n}` }, null).key,
    ),
  ];
  for (const identify of cases) {
    const { s, projectId, input, begin } = await startProject();
    const parent = await begin(
      input({ kind: 'new', outcome: 'Nested sessions' }, { agent: agentSlug('parent-session') }),
    );
    const intent = { kind: 'existing', intentId: parent.intentId };
    const first = await begin(input(intent, { agent: agentSlug(identify(1)) }));
    const second = await begin(input(intent, { agent: agentSlug(identify(2)) }));
    const own = await begin(input(intent, { agent: agentSlug(identify(1)) }));
    const seen = async lane =>
      JSON.parse(
        await s.call('read', overlaps.read, { projectId, laneId: lane.lane.laneId, presence: {} }),
      ).presence.lanes.map(peer => peer.laneId);
    assert.ok((await seen(first)).includes(parent.lane.laneId), 'child sees its parent');
    assert.ok((await seen(first)).includes(second.lane.laneId), 'child sees its sibling');
    assert.ok((await seen(second)).includes(first.lane.laneId), 'siblings see one another');
    assert.ok(!(await seen(first)).includes(own.lane.laneId), 'same session remains one run across Lanes');
  }
});

test('start (server): the session slug labels its Lane in presence, peer wait and overlap; retries ignore it', async () => {
  const { s, projectId, input, begin } = await startProject();
  const firstInput = input({ kind: 'new', outcome: 'Agent identities' }, { agent: 'quiet-otter' });
  const first = await begin(firstInput);
  const laneOne = first.lane.laneId;
  const second = await begin(
    input({ kind: 'existing', intentId: first.intentId }, { agent: 'brave-falcon' }),
  );
  const laneTwo = second.lane.laneId;
  const third = await begin(input({ kind: 'existing', intentId: first.intentId }));
  const overlapRows = [...s.tables.projectHostedOverlapLanes.values()];
  assert.deepEqual(
    [laneOne, laneTwo, third.lane.laneId].map(id => overlapRows.find(row => row.laneId === id).agent),
    ['quiet-otter', 'brave-falcon', undefined],
  );
  assert.equal(
    [...s.tables.projectHostedPresence.values()].find(row => row.laneId === laneOne).agent,
    'quiet-otter',
  );
  // The same start retried from another session is the same operation (the slug is not payload).
  const replay = await begin({ ...firstInput, agent: 'brave-falcon' });
  assert.equal(replay.lane.laneId, laneOne);
  await assert.rejects(
    begin(input({ kind: 'new', outcome: 'x' }, { agent: 'dino-macbook' })),
    code('BAD_ARGUMENT'),
  );
  // Presence: two sessions of one account on one Issue tell each other apart.
  const read = laneId =>
    s.call('read', overlaps.read, { projectId, laneId, presence: {} }).then(value => JSON.parse(value));
  const seen = (await read(laneTwo)).presence.lanes;
  const one = seen.find(lane => lane.laneId === laneOne);
  assert.equal(one.actor, 'owner-h/quiet-otter');
  assert.equal(one.yours, true);
  assert.match(
    presenceNotice(one, Date.now()),
    /^Another agent on your account \(owner-h\/quiet-otter\) is working/,
  );
  const human = (await read(laneOne)).presence.lanes.find(lane => lane.laneId === third.lane.laneId);
  assert.equal(human.actor, 'owner-h', 'a Lane started without a session slug shows the plain handle');
  // Peer wait names the peer session.
  const peer = JSON.parse(await s.call('peer', peerWait.peer, { projectId, peer: laneOne }));
  assert.equal(peer.peer.actor, 'owner-h/quiet-otter');
  // A later Lane write without a slug (sync, landing, lifecycle) keeps the stored one.
  const row = [...s.tables.projectHostedOverlapLanes.values()].find(r => r.laneId === laneOne);
  assert.equal(row.agent, 'quiet-otter');
});

test('start (server) cost: a slug adds no read and no row to a start', async () => {
  const counts = [];
  for (const extra of [{ agent: 'quiet-otter' }, {}]) {
    const { s, input, begin } = await startProject();
    await begin(input({ kind: 'new', outcome: 'Same shape' }, extra));
    counts.push(s.counts.at(-1));
  }
  assert.equal(counts[0].documents, counts[1].documents);
  assert.equal(counts[0].ranges, counts[1].ranges);
});

test('peer evidence participants and claim lines name each agent session', () => {
  const lane = (laneId, actor, agent, path) => ({
    laneId,
    intentId: randomUUID(),
    intent: `Work ${laneId}`,
    actor,
    ...(agent ? { agent } : {}),
    head: 'h',
    baseHead: 'b',
    baseSequence: 0,
    open: true,
    changes: JSON.stringify([{ path, before: null, after: { blob: laneId, mode: '100644' } }]),
    complete: true,
  });
  const mine = lane(randomUUID(), 'acct', 'quiet-otter', 'a.txt');
  const peer = lane(randomUUID(), 'acct', 'brave-falcon', 'a.txt');
  const person = lane(randomUUID(), 'acct', undefined, 'a.txt');
  const advice = hostedOverlapAdvice(
    mine,
    [peer, person],
    null,
    { head: 'b', sourceRevision: 0 },
    true,
    5,
    'a.txt',
  );
  const actors = advice.overlaps.items.flatMap(item => item.participants.map(p => p.actor));
  assert(
    actors.includes('acct/brave-falcon') && actors.includes('acct') && actors.includes('acct/quiet-otter'),
  );
  assert.match(
    touchingLine('a.txt', { author: 'owner-h/brave-falcon', fromLaneId: peer.laneId, at: Date.now() }),
    /^Claim on a\.txt: owner-h\/brave-falcon \(Lane/,
  );
});

test('CLI start: sends the session slug only to a server that takes it; the receipt names the session', async t => {
  const s = agentFixture(t);
  const state = mkdtempSync(join(tmpdir(), 'forge-slug-state-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  });
  // Older server: no agent-slug feature. The request is unchanged and the receipt has no `as`.
  const old = await s.transport('session-alpha').dispatch('start', { outcome: 'Old server' });
  const oldArgs = s.calls.filter(call => call.name === 'projectHostedStart:start').at(-1).args;
  assert.equal('agent' in oldArgs, false);
  assert.equal('as' in old, false);
  assert.deepEqual(readBoardServerFeatures('project'), []);
  s.caps.features = ['agent-board', 'agent-slug'];
  const response = await s.transport('session-alpha').dispatch('start', { outcome: 'New server' });
  const args = s.calls.filter(call => call.name === 'projectHostedStart:start').at(-1).args;
  assert.equal(args.agent, agentSlug('session-alpha'));
  assert(
    hostedStartSchema.safeParse(Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'projectId')))
      .success,
  );
  assert.equal(response.as, `owner/${agentSlug('session-alpha')}`);
  assert(JSON.stringify(response.as).length < 40, 'compact receipt field');
  // The capability read this start already made tells later board posts (no capability read) too.
  assert.deepEqual(readBoardServerFeatures('project'), ['agent-board', 'agent-slug']);
  // A person (no session id) sends nothing and gets no `as`.
  const human = await s.transport(null).dispatch('start', { outcome: 'Person' });
  assert.equal(
    'agent' in s.calls.filter(call => call.name === 'projectHostedStart:start').at(-1).args,
    false,
  );
  assert.equal('as' in human, false);
  assert.equal(
    s.calls.filter(call => call.name === 'projectHostedAgent:capabilities').length,
    3,
    'no added call: one capability read per command, as before',
  );
});

test('end to end: two agent sessions on one root post to each other through the CLI and see different slugs', async t => {
  const f = boardFixture();
  f.lanes.D = randomUUID();
  f.lane('D', 'owner', true);
  const s = agentFixture(t);
  const state = mkdtempSync(join(tmpdir(), 'forge-slug-e2e-'));
  const saved = Object.fromEntries(
    [
      'XDG_STATE_HOME',
      'FORGE_AUTH_TOKEN',
      'CLAUDE_CODE_SESSION_ID',
      'CODEX_THREAD_ID',
      'FORGE_HUMAN',
      'FORGE_AGENT_SESSION',
    ].map(k => [k, process.env[k]]),
  );
  process.env.XDG_STATE_HOME = state;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-test-credential';
  delete process.env.CODEX_THREAD_ID;
  delete process.env.FORGE_HUMAN;
  const exitCode = process.exitCode;
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    process.exitCode = exitCode;
    rmSync(state, { recursive: true, force: true });
  });
  const traffic = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert(String(url).startsWith(s.address.url), 'No real HTTP calls');
    const body = JSON.parse(init.body);
    traffic.push(body.path);
    const [module, fn] = body.path.split(':');
    const value =
      module === 'projectBoard'
        ? JSON.stringify(await f.invoke(board[fn], body.path, body.args[0], 'owner'))
        : await (String(url).endsWith('/api/query')
            ? s.exchange.client.query(makeFunctionReference(body.path), body.args[0])
            : s.exchange.client.mutation(makeFunctionReference(body.path), body.args[0]));
    return new Response(JSON.stringify({ status: 'success', value }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  // The server advertised agent-slug on an earlier Lane action on this machine.
  rememberBoardServerFeatures('project', ['agent-board', 'agent-slug']);
  const root = join(dirname(s.root), 'clone');
  const address = { url: s.address.url, projectId: s.address.projectId };
  const binary = { process: true, beforeDispatch: async () => true };
  const as = async (session, args) => {
    if (session) {
      process.env.CLAUDE_CODE_SESSION_ID = session;
      process.env.FORGE_AGENT_SESSION = session;
      delete process.env.FORGE_HUMAN;
    } else {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      delete process.env.FORGE_AGENT_SESSION;
      process.env.FORGE_HUMAN = '1';
    }
    return agentCli([root, ...args], binary);
  };
  const one = '0b7d2a51-0000-4000-8000-00000000000a',
    two = '0b7d2a51-0000-4000-8000-00000000000b';
  assert.notEqual(agentSlug(one), agentSlug(two));
  const post = (session, from, to, text) =>
    as(session, ['board-post', JSON.stringify({ ...address, to: `lane:${to}`, laneId: from, text })]);
  assert.equal((await post(one, f.lanes.B, f.lanes.D, 'From session one')).result.status, 'posted');
  assert.equal((await post(two, f.lanes.D, f.lanes.B, 'From session two')).result.status, 'posted');
  assert.equal((await post(undefined, f.lanes.D, f.lanes.B, 'From the owner')).result.status, 'posted');
  const readAs = (session, laneId) =>
    as(session, ['board', JSON.stringify({ ...address, laneId, all: true })]);
  const seenByTwo = (await readAs(two, f.lanes.D)).result.notices;
  const seenByOne = (await readAs(one, f.lanes.B)).result.notices;
  assert.equal(seenByTwo.length, 1);
  assert.match(
    seenByTwo[0],
    new RegExp(`from owner-h/${agentSlug(one)} \\(Lane ${f.lanes.B.slice(0, 8)}\\)`),
  );
  assert.equal(seenByOne.length, 2);
  assert(
    seenByOne.some(line => line.includes(`from owner-h/${agentSlug(two)} (Lane ${f.lanes.D.slice(0, 8)})`)),
  );
  assert(
    seenByOne.some(line => line.includes('from @owner-h (Lane')),
    'a person reads as plain @handle',
  );
  // Budget: one call per board command, no capability read added.
  assert.deepEqual(traffic, [
    'projectBoard:post',
    'projectBoard:post',
    'projectBoard:post',
    'projectBoard:read',
    'projectBoard:read',
  ]);
});
