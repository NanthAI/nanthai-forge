// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { consumeProjectFeed, FEED_OVERLAP_MS, FEED_RETENTION_MS } from '../dist/feed-client.js';
import { feedEventId, feedEventView } from '../dist/feed-event.js';
import { encodeFeedPosition } from '../dist/feed-position.js';
import { shellQuote } from '../dist/shell-quote.js';
import { watchHooks } from '../dist/watch-hooks.js';

const projectId = 'synthetic-project';
const laneId = randomUUID();
const operationId = randomUUID();
const landing = (at, kind = 'landing.landed') => {
  const event = { projectId, laneId, operationId, kind, submissionId: randomUUID() };
  return feedEventView({ ...event, at, id: feedEventId(event) });
};
const page = (events, cursor = null) => ({ events, more: cursor !== null, cursor });
const arrived = (events, after, scanned = events.length, cursor = null) => ({
  ...page(events, cursor),
  arrival: { after, scanned },
});
const turn = () => new Promise(resolve => setImmediate(resolve));

test('a feed crosses empty history pages, delivers late commits and resumes from the saved commit', async t => {
  const first = 100_000;
  const later = landing(first + 50_000);
  const late = landing(first - FEED_OVERLAP_MS);
  const fence = encodeFeedPosition(100n, null);
  const last = encodeFeedPosition(101n, late.id);
  const received = [],
    requests = [];
  let listener,
    cursor = { since: first, seen: [] };
  let closed = 0;
  const launch = signal =>
    consumeProjectFeed({
      selection: { projectId, lanes: [laneId] },
      cursor,
      signal,
      replay: true,
      subscribe: () => ({
        onUpdate(reference, args, update) {
          assert.equal(getFunctionName(reference), 'projectFeed:page');
          requests.push(args);
          assert.equal(listener, undefined, 'only one live query is open');
          listener = update;
          return () => {
            listener = undefined;
          };
        },
        async close() {
          closed++;
        },
      }),
      read: async args => {
        requests.push(args);
        return args.cursor === 'empty-first-page' ? page([], 'empty-second-page') : page([later]);
      },
      event: event => {
        received.push(event.id);
      },
      checkpoint: next => {
        cursor = next;
      },
    });
  const stop = new AbortController();
  t.after(() => stop.abort());
  const watching = launch(stop.signal);
  listener(arrived([], fence, 0, 'empty-first-page'));
  await turn();
  assert.deepEqual(received, [later.id]);
  assert.deepEqual(
    requests.map(args => [args.since, args.cursor]),
    [
      [first, undefined],
      [first, 'empty-first-page'],
      [first, 'empty-second-page'],
      [later.at - FEED_OVERLAP_MS, undefined],
    ],
  );
  assert.equal(requests[3].arrival.after, fence);
  listener(arrived([late], last));
  await turn();
  assert.deepEqual(received, [later.id, late.id]);
  listener(arrived([late], last));
  await turn();
  assert.equal(requests.length, 4, 'quiet watch makes zero further calls');
  stop.abort();
  await watching;

  const restart = new AbortController();
  t.after(() => restart.abort());
  const resumed = launch(restart.signal);
  assert.equal(requests[4].arrival.after, last);
  listener(arrived([], last));
  await turn();
  assert.deepEqual(received, [later.id, late.id]);
  restart.abort();
  await resumed;
  assert.equal(closed, 2);
  assert.equal(listener, undefined);
});

test('a crash during history replay keeps the first fence for later commits with older timestamps', async t => {
  const fence = encodeFeedPosition(100n, null);
  const prior = landing(100_100);
  const late = landing(2);
  const afterLate = encodeFeedPosition(101n, late.id);
  let cursor = { since: 100_000, seen: [] },
    listener,
    input;
  const received = [];
  const watch = signal =>
    consumeProjectFeed({
      selection: { projectId, lanes: [laneId] },
      cursor,
      replay: true,
      signal,
      subscribe: () => ({
        onUpdate(_ref, args, next) {
          input = args;
          listener = next;
          return () => {};
        },
        async close() {},
      }),
      read: () =>
        new Promise(resolve => {
          signal.addEventListener('abort', () => resolve(page([])), { once: true });
        }),
      event: event => {
        received.push(event.id);
      },
      checkpoint: next => {
        cursor = next;
      },
    });
  const killed = new AbortController();
  t.after(() => killed.abort());
  const first = watch(killed.signal);
  listener(arrived([prior], fence, 0, 'history-2'));
  await turn();
  assert.equal(cursor.after, undefined);
  assert.equal(cursor.historyFence, fence);
  killed.abort();
  await first;
  const stopped = new AbortController();
  t.after(() => stopped.abort());
  const replay = watch(stopped.signal);
  assert.deepEqual(input.arrival, { after: fence, replay: true });
  listener(arrived([prior], fence, 0));
  await turn();
  assert.deepEqual(input.arrival, { after: fence });
  listener(arrived([late], afterLate));
  await turn();
  assert.deepEqual(received, [prior.id, late.id]);
  stopped.abort();
  await replay;
});

function startWatch(t, root, state, args) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { watchCli } from ${JSON.stringify(new URL('../dist/watch-cli.js', import.meta.url).href)};
      import { HostedAgentTransport } from ${JSON.stringify(new URL('../dist/hosted-agent-transport.js', import.meta.url).href)};
      import { observationWaitHooks } from ${JSON.stringify(new URL('../dist/hosted-agent-observe.js', import.meta.url).href)};
      HostedAgentTransport.prototype.dispatch = async () => ({ result: { actor: 'fixture', features: ['feed', 'feed-commit-order'] } });
      observationWaitHooks.subscribe = () => ({
        onUpdate(_, args, update) {
          process.on('message', update);
          process.send(args);
          return () => process.off('message', update);
        },
        async close() { process.disconnect(); },
      });
      await watchCli(process.argv.slice(1));
    `,
      root,
      ...args,
    ],
    {
      env: {
        ...process.env,
        XDG_STATE_HOME: state,
        FORGE_AUTH_TOKEN: 'synthetic',
        FORGE_DEPLOYMENT_URL: 'https://fixture.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', value => {
    stdout += value;
  });
  child.stderr.on('data', value => {
    stderr += value;
  });
  const exited = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const ready = Promise.race([
    once(child, 'message').then(([args]) => args),
    exited.then(() => {
      throw new Error(stderr || 'watch exited before subscribing');
    }),
  ]);
  return { child, ready, exited, stdout: () => stdout, stderr: () => stderr };
}

test(
  '--on-landing sends the chosen command one terminal event with identity and resumes cleanly on SIGTERM',
  { timeout: 10_000 },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-watch-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const state = join(root, 'private-state');
    const agent = `${root}.forge-client/agent`;
    t.after(() => rmSync(`${root}.forge-client`, { recursive: true, force: true }));
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'address.json'), JSON.stringify({ url: 'https://fixture.invalid', projectId }));
    const hook = join(root, 'hook.jsonl');
    const script = `
    const fs = require('node:fs');
    const event = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.appendFileSync(process.argv[1], JSON.stringify([event.id, event.kind, process.env.FORGE_EVENT_ID, process.env.FORGE_EVENT_KIND]) + '\\n');
    console.log('hook complete');
  `;
    const command = [process.execPath, '-e', script, hook].map(shellQuote).join(' ');
    const watch = startWatch(t, root, state, ['--json', '--on-landing', command]);
    const { since } = await watch.ready;
    const landed = landing(since + 2);
    const saved = feedEventView({
      projectId,
      laneId,
      at: since + 1,
      id: `lane.saved:${laneId}:1`,
      kind: 'lane.saved',
      sourceVersion: 1,
    });
    const hookFinished = once(watch.child.stderr, 'data');
    const fence = encodeFeedPosition(100n, null);
    const anchored = once(watch.child, 'message');
    watch.child.send(arrived([saved, landed], fence, 0));
    await anchored;
    await hookFinished;
    const secondDelivery = once(watch.child.stdout, 'data');
    const failed = landing(since + 3, 'landing.failed');
    watch.child.send(arrived([failed], encodeFeedPosition(101n, failed.id)));
    await secondDelivery;
    while (watch.stderr().split('hook complete').length < 3) {
      await once(watch.child.stderr, 'data');
    }
    watch.child.kill('SIGTERM');
    assert.deepEqual(await watch.exited, [0, null], watch.stderr());
    const records = watch
      .stdout()
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.deepEqual(
      records.map(record => record.id),
      [saved.id, landed.id, failed.id],
    );
    assert.deepEqual(records.at(-1).resume.input.operationIds, [operationId]);
    assert(records.at(-1).command.includes(operationId));
    assert.deepEqual(
      readFileSync(hook, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line)),
      [landed, failed].map(event => [event.id, event.kind, event.id, event.kind]),
    );
    const folder = join(state, 'forge', 'watch');
    const file = join(folder, readdirSync(folder)[0]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const savedState = JSON.parse(readFileSync(file, 'utf8'));
    savedState.updatedAt -= FEED_RETENTION_MS + 1000;
    writeFileSync(file, JSON.stringify(savedState));
    const resumed = startWatch(t, root, state, ['--json']);
    await resumed.ready;
    const gap = once(resumed.child.stdout, 'data');
    resumed.child.send(arrived([], fence, 0));
    await gap;
    resumed.child.kill('SIGTERM');
    assert.deepEqual(await resumed.exited, [0, null], resumed.stderr());
    const notice = JSON.parse(resumed.stdout());
    assert.equal(notice.kind, 'feed.gap');
    assert.equal(notice.resume.action, 'lanes');
  },
);

test('a failed landing hook tries three times after failure and retains the event for the next start', async () => {
  const event = landing(123);
  const calls = [];
  let records;
  const stopped = new AbortController();
  let finish;
  const warned = new Promise(resolve => {
    finish = resolve;
  });
  const failed = watchHooks({
    commands: { landing: 'command' },
    pending: [],
    signal: stopped.signal,
    delays: [0, 0, 0],
    retain: item => {
      records = [structuredClone(item)];
    },
    complete: assert.fail,
    warn: ({ id }, hook) => finish([id, hook]),
    fail: assert.fail,
    run: async (_, next) => {
      calls.push(next.id);
      return false;
    },
  });
  failed.offer(event);
  assert.deepEqual(await warned, [event.id, 'landing']);
  assert.deepEqual(calls, [event.id, event.id, event.id, event.id]);
  assert.deepEqual(records, [{ event, hooks: ['landing'] }]);
  await failed.close();

  let delivered;
  const deliveredEvent = new Promise(resolve => {
    delivered = resolve;
  });
  const resumed = watchHooks({
    commands: { landing: 'command' },
    pending: records,
    signal: stopped.signal,
    retain: assert.fail,
    complete: (id, hook) => delivered([id, hook]),
    warn: assert.fail,
    fail: assert.fail,
    run: async (_, next) => {
      assert.equal(next.id, event.id);
      return true;
    },
  });
  resumed.start();
  assert.deepEqual(await deliveredEvent, [event.id, 'landing']);
  await resumed.close();
});
