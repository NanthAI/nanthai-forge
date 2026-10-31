// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/hash.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { submitHostedLand, relayFile } from '../dist/hosted-land-cli.js';
import { landWaitCommand, landAnnouncement } from '../dist/hosted-land-wait.js';
import { hostedOverlapNotice, overlapBannerOnce } from '../dist/hosted-overlap-notice.js';
import { hostedShowCli } from '../dist/hosted-show-cli.js';
import { showHostedSource } from '../dist/mcp-hosted-source.js';
import {
  beginLaneCommand,
  endLaneCommand,
  laneLiveness,
  readLaneEntry,
  recordLane,
  withLaneCommand,
} from '../dist/lane-registry.js';

function stateHome(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-feedback-')),
    saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = directory;
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function captureStderr(t) {
  const lines = [],
    write = process.stderr.write;
  process.stderr.write = chunk => {
    lines.push(String(chunk));
    return true;
  };
  t.after(() => (process.stderr.write = write));
  return lines;
}
const state = (files, message) =>
  Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message,
      at: '2026-01-01T00:00:00.000Z',
    }),
  );
const noticeFor = (root, laneId) =>
  hostedOverlapNotice(root, laneId, {
    unacknowledgedOverlaps: {
      count: 1,
      coverage: 'hosted',
      items: [
        {
          noticeId: 'n'.repeat(64),
          file: 'src/a.ts',
          lanes: [laneId, 'peer'],
          text: 'x',
          participants: [
            { lane: laneId, actor: 'me', intent: 'mine' },
            { lane: 'efa2859d', actor: 'other', intent: 'Landed work' },
          ],
        },
      ],
    },
  });

test('finish prints operation id, replay and wait commands, and the overlap banner at once, before the save wait ends', async t => {
  const lines = captureStderr(t);
  const root = '/tmp/lane-root';
  const operationId = randomUUID();
  const laneId = randomUUID();
  const notice = noticeFor(root, laneId);
  const replies = [{ phase: 'finish', submission: { phase: 'queued', observation: { state: 'pending' } } }];
  const transport = {
    dispatch: async action => ({
      schema: 1,
      transport: 'hosted',
      action,
      operationId,
      result: replies.shift(),
      overlapNotice: notice,
    }),
  };
  // The first receipt already announces, before any waiting.
  const response = await submitHostedLand(
    root,
    { laneId, message: 'm' },
    { url: 'https://x.invalid', projectId: 'p' },
    transport,
    0,
  );
  assert.equal(response.result.phase, 'finish');
  const text = lines.join('');
  assert.match(text, new RegExp(`land: operationId ${operationId}`));
  assert.match(text, /finish '\{"laneId":"[0-9a-f-]+","operationId":"[0-9a-f-]+"\}'/);
  assert.match(
    text,
    /to keep waiting, run: nforge agent '\/tmp\/lane-root' wait '\{"operationIds":\["[0-9a-f-]+"\],"timeoutSeconds":3600\}'/,
  );
  assert.match(text, /OVERLAP NOTICE: ACTION REQUIRED/);
  assert.match(text, /efa2859d/);
  // Printed once: the exit-time banner for the same notice is empty.
  assert.equal(overlapBannerOnce(notice), '');
});

test('relayed child stderr appears while the child still runs, not at its exit', async t => {
  const lines = captureStderr(t);
  const directory = mkdtempSync(join(tmpdir(), 'forge-relay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'child.err');
  writeFileSync(file, '');
  const relay = relayFile(file);
  appendFileSync(file, 'land: operationId early\n');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(lines, ['land: operationId early\n'], 'delivered before stop()');
  appendFileSync(file, 'tail\n');
  relay.stop();
  assert.equal(lines.join(''), 'land: operationId early\ntail\n');
});

test('the receipt carries one wait command while a landing or check is pending, and none once final', () => {
  const operationId = randomUUID(),
    runId = randomUUID(),
    root = "/tmp/it's";
  const wait = (result, id = operationId) => landWaitCommand(root, { operationId: id, result });
  const queued = wait({ phase: 'finish', submission: { phase: 'queued' } });
  assert.equal(
    queued,
    `nforge agent '/tmp/it'\\''s' wait '{"operationIds":["${operationId}"],"timeoutSeconds":3600}'`,
  );
  assert.equal(wait({ phase: 'finish', submission: { phase: 'landed' } }), undefined);
  assert.equal(wait({ phase: 'finish', submission: { phase: 'terminal-failed' } }), undefined);
  assert.match(wait({ phase: 'check', run: { id: runId, status: 'running' } }), new RegExp(runId));
  assert.equal(wait({ phase: 'check', run: { id: runId, status: 'passed' } }), undefined);
  assert.equal(wait({ phase: 'conflict' }), undefined);
  assert.deepEqual(landAnnouncement(root, {}, { operationId: null, result: {} }), []);
});

test('hosted show reads a main file by channel:main, never an empty stdout on failure', async t => {
  const s = agentFixture(t);
  const lane = Buffer.from('lane version\n'),
    main = Buffer.from('main version\n');
  for (const bytes of [lane, main]) s.objects.set(digest(bytes), bytes);
  const laneState = state([{ path: 'a.ts', blob: digest(lane), mode: 'file' }], 'lane'),
    mainState = state([{ path: 'a.ts', blob: digest(main), mode: 'file' }], 'main');
  s.lane.head = digest(laneState);
  s.main.head = digest(mainState);
  s.objects.set(s.lane.head, laneState);
  s.objects.set(s.main.head, mainState);
  const written = [];
  const show = (command, transport = s.transport()) =>
    hostedShowCli(s.root, command, s.address, transport, bytes => written.push(bytes));
  await show({ channel: 'main', path: 'a.ts' });
  assert.equal(Buffer.concat(written).toString(), 'main version\n');
  written.length = 0;
  await show({ laneId: s.lane.laneId, path: 'a.ts' });
  assert.equal(Buffer.concat(written).toString(), 'lane version\n');
  const shown = await showHostedSource(s.transport(), { action: 'show', channel: 'main', path: 'a.ts' });
  assert.equal(shown.result.channel, 'main');
  assert.equal(shown.result.state, s.main.head);
  assert.equal(shown.result.size, main.length);
  // Failures are structured errors with nothing written.
  written.length = 0;
  for (const [command, expected] of [
    [{ channel: 'main', path: 'missing.ts' }, 'NOT_FOUND'],
    [{ channel: 'main', laneId: s.lane.laneId, path: 'a.ts' }, 'BAD_ARGUMENT'],
    [{ state: s.main.head, path: 'a.ts' }, 'BAD_ARGUMENT'],
    [{ channel: 'dev', path: 'a.ts' }, 'BAD_ARGUMENT'],
  ])
    await assert.rejects(show(command), error => error.code === expected, JSON.stringify(command));
  assert.equal(written.length, 0, 'a failed read writes no bytes');
  s.allow(false);
  await assert.rejects(
    show({ channel: 'main', path: 'a.ts' }),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
});

test('liveness: a running command shows with its pid, clears on exit or error, and a dead pid is not running', async t => {
  stateHome(t);
  const laneId = randomUUID();
  recordLane({ laneId, root: '/tmp/x', url: 'u', projectId: 'p' }, 1_000);
  assert.deepEqual(laneLiveness(laneId), { lastActionAt: new Date(1_000).toISOString(), running: null });
  let during;
  await withLaneCommand(laneId, 'land', async () => {
    during = laneLiveness(laneId);
  });
  assert.equal(during.running.action, 'land');
  assert.equal(during.running.pid, process.pid);
  assert.equal(laneLiveness(laneId).running, null);
  assert(Date.parse(laneLiveness(laneId).lastActionAt) > 1_000, 'the command counts as activity');
  await assert.rejects(
    withLaneCommand(laneId, 'save', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(laneLiveness(laneId).running, null, 'cleared when the command throws');
  // A marker left by a killed process is stale, not running.
  beginLaneCommand(laneId, 'finish');
  recordLane({ laneId, running: { action: 'finish', pid: 2 ** 22 - 1, since: Date.now() } });
  assert.equal(laneLiveness(laneId).running, null);
  // Another process's marker is never cleared by this one.
  recordLane({ laneId, running: { action: 'wait', pid: process.ppid, since: Date.now() } });
  endLaneCommand(laneId);
  assert.equal(readLaneEntry(laneId).running.action, 'wait');
  assert.equal(laneLiveness('00000000-0000-4000-8000-000000000000'), null);
});

test('status of a Lane reports local liveness without an extra server call', async t => {
  stateHome(t);
  const s = agentFixture(t);
  recordLane({ laneId: s.lane.laneId, root: s.root, url: 'u', projectId: 'project' });
  beginLaneCommand(s.lane.laneId, 'finish');
  const before = s.calls.length;
  const status = await s.transport().dispatch('status', { laneId: s.lane.laneId });
  assert.equal(status.result.local.running.action, 'finish');
  assert.equal(status.result.local.running.pid, process.pid);
  assert.equal(
    s.calls.slice(before).filter(call => call.name === 'projectHostedLanes:head').length,
    1,
    'one head read, as before',
  );
  endLaneCommand(s.lane.laneId);
  const idle = await s.transport().dispatch('status', { laneId: s.lane.laneId });
  assert.equal(idle.result.local.running, null);
  assert(idle.result.local.lastActionAt);
});
