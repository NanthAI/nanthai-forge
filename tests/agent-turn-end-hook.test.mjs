// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { turnEndDecision, turnEndMessage } from '../dist/agent-stop-hook.js';
import {
  readTurnLedger,
  recordTurnWait,
  recordTurnWork,
  turnLedgerDirectory,
} from '../dist/agent-turn-work.js';
import { resolveTurnWait } from '../dist/agent-turn-wait.js';
import { AGENT_WAIT_SECONDS, operationWait, parseWaitBudget } from '../dist/agent-operation-wait.js';
import { installEditHooks, migrateEditHookRunner } from '../dist/agent-install-hooks.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { agentCli } from '../dist/agent-cli.js';
import { ForgeError } from '../dist/errors.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

const hookRunner = fileURLToPath(new URL('../dist/agent-stop-hook.js', import.meta.url));
const deadPid = 2 ** 22 + 12345; // beyond the default pid range: never alive

/** Private state directory and agent session for one test; no real user state. */
function session(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-turn-end-'));
  const previous = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  };
  const id = `synthetic-session-${randomUUID()}`;
  process.env.XDG_STATE_HOME = join(directory, 'state');
  process.env.CLAUDE_CODE_SESSION_ID = id;
  delete process.env.CODEX_THREAD_ID;
  t.after(() => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, id, root: join(directory, 'lane') };
}
const landing = (root, id = randomUUID(), pid = process.pid, observedAt) => ({
  id,
  kind: 'landing',
  root,
  input: { operationIds: [id], until: 'acceptance' },
  pid,
  ...(observedAt === undefined ? {} : { observedAt }),
});
function countingProbe(answer = 'running') {
  const calls = [];
  const probe = async work => {
    calls.push(work.id);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, probe };
}
const approxTokens = text => Math.ceil(text.length / 3); // conservative for id-heavy text

test('the hook blocks the first stop while owned work runs and always allows the second', async t => {
  const s = session(t),
    work = landing(s.root);
  recordTurnWork(work);
  const { calls, probe } = countingProbe();
  const first = await turnEndDecision({ session_id: s.id, hook_event_name: 'Stop' }, { probe });
  assert.equal(first.decision, 'block');
  assert.equal(
    first.reason,
    `Your landing ${work.id.slice(0, 8)} is still running. Run: nforge wait ${work.id}. To stop anyway, stop again.`,
  );
  assert(approxTokens(first.reason) < 60, `${approxTokens(first.reason)} tokens`);
  const second = await turnEndDecision(
    { session_id: s.id, hook_event_name: 'Stop', stop_hook_active: true },
    { probe },
  );
  assert.deepEqual(second, {}, 'a second consecutive stop attempt is always allowed');
  assert.deepEqual(calls, [], 'a live observer needs no hosted query');
  // After real progress (a Forge wait in this session) the next stop is a first attempt again.
  recordTurnWork(work);
  assert.equal((await turnEndDecision({ session_id: s.id }, { probe })).decision, 'block');
  assert.deepEqual(await turnEndDecision({ session_id: s.id }, { probe }), {});
});

test('the installed hook process blocks once, then allows, with tiny JSON output', t => {
  const s = session(t),
    work = landing(s.root, randomUUID(), process.pid);
  recordTurnWork(work);
  const env = {
    PATH: process.env.PATH,
    HOME: s.directory,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: join(s.directory, 'config'),
  };
  const stop = () =>
    spawnSync(process.execPath, [hookRunner, '--forge-turn-end'], {
      env,
      input: JSON.stringify({ session_id: s.id, hook_event_name: 'Stop', stop_hook_active: false }),
      encoding: 'utf8',
      timeout: 10_000,
    });
  const first = stop();
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(first.stdout);
  assert.equal(output.decision, 'block');
  assert.equal(output.reason, turnEndMessage(work));
  assert.equal(first.stdout.trim().split('\n').length, 1);
  const second = stop();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), {});
  // Malformed input and unknown sessions always allow.
  const malformed = spawnSync(process.execPath, [hookRunner, '--forge-turn-end'], {
    env,
    input: 'not json',
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(malformed.stdout), {});
});

test('budget: idle and finished sessions cost zero queries and zero writes; cold cache costs one query', async t => {
  const s = session(t);
  const none = countingProbe();
  assert.deepEqual(await turnEndDecision({ session_id: s.id }, { probe: none.probe }), {});
  assert.deepEqual(none.calls, []);
  assert(!existsSync(turnLedgerDirectory()), 'an idle stop writes nothing');
  // Warm: recently observed by a Forge wait return; no live pid.
  const warm = landing(s.root, randomUUID(), null);
  recordTurnWork(warm);
  const warmProbe = countingProbe();
  assert.equal((await turnEndDecision({ session_id: s.id }, { probe: warmProbe.probe })).decision, 'block');
  assert.deepEqual(warmProbe.calls, []);
  await turnEndDecision({ session_id: s.id }, { probe: warmProbe.probe });
  // Cold and finished elsewhere: one query, then allowed and forgotten.
  const cold = landing(s.root, randomUUID(), deadPid, Date.now() - 60_000);
  recordTurnWork({ ...warm, observedAt: Date.now() - 60_000 });
  recordTurnWork(cold);
  const finished = countingProbe('terminal');
  assert.deepEqual(await turnEndDecision({ session_id: s.id }, { probe: finished.probe }), {});
  assert.deepEqual(finished.calls, [cold.id], 'exactly one hosted query, for the newest entry');
  assert(!readTurnLedger(s.id).work.some(work => work.id === cold.id));
  // Cold and still running, or unreachable: one query, block once.
  for (const answer of ['running', new ForgeError('EXCHANGE_REQUEST_FAILED', 'synthetic outage')]) {
    const probe = countingProbe(answer);
    const decision = await turnEndDecision({ session_id: s.id }, { probe: probe.probe });
    assert.equal(decision.decision, 'block');
    assert.equal(probe.calls.length, 1);
    assert.deepEqual(await turnEndDecision({ session_id: s.id }, { probe: probe.probe }), {});
    assert.equal(probe.calls.length, 1, 'the allowed second stop makes no query');
  }
});

test('other sessions, other events and disabled state never block', async t => {
  const s = session(t);
  recordTurnWork(landing(s.root));
  assert.deepEqual(await turnEndDecision({ session_id: 'another-agent' }), {});
  assert.deepEqual(await turnEndDecision({ session_id: s.id, hook_event_name: 'PreToolUse' }), {});
  assert.deepEqual(await turnEndDecision({}), {});
  // Session ids never appear on disk.
  const names = readdirSync(turnLedgerDirectory());
  assert(
    names.every(name => /^[0-9a-f]{32}\.json$/.test(name)),
    names.join(),
  );
  assert(!readFileSync(join(turnLedgerDirectory(), names[0]), 'utf8').includes(s.id));
});

test('replay: the four early stops recorded on Issue 0fe39d02 are each caught once, then released', async t => {
  const s = session(t);
  const incidents = [
    {
      // storage 1323a44c: landing waited in a background task; its observer was gone.
      name: 'storage 1323a44c',
      record: id =>
        recordTurnWait(
          s.root,
          operationWait(s.root, { operationIds: [id], until: 'acceptance' }).next,
          deadPid,
        ),
      age: 120_000,
      queries: 1,
    },
    {
      // pre-queue e7d27937: three background dry runs (check-only runs) still running.
      name: 'pre-queue e7d27937',
      record: id => {
        for (const run of [randomUUID(), randomUUID(), id])
          recordTurnWait(s.root, operationWait(s.root, { runId: run }).next, process.pid);
      },
      kind: 'check run',
      queries: 0,
    },
    {
      // queue 51bbbd00: land --save ran as a background shell; the turn ended on it.
      name: 'queue 51bbbd00',
      record: id =>
        recordTurnWait(
          s.root,
          operationWait(s.root, { operationIds: [id], until: 'acceptance' }).next,
          process.pid,
        ),
      queries: 0,
    },
    {
      // storage operator dc8d591a: a wait returned IN PROGRESS, then a status line and a stop.
      name: 'storage operator dc8d591a',
      record: id =>
        recordTurnWait(s.root, operationWait(s.root, { operationIds: [id], until: 'acceptance' }).next, null),
      queries: 0,
    },
  ];
  for (const incident of incidents) {
    rmSync(turnLedgerDirectory(), { recursive: true, force: true });
    const id = randomUUID();
    incident.record(id);
    if (incident.age)
      for (const work of readTurnLedger(s.id).work)
        recordTurnWork({ ...work, observedAt: Date.now() - incident.age });
    const probe = countingProbe('running');
    const first = await turnEndDecision(
      { session_id: s.id, hook_event_name: 'Stop' },
      { probe: probe.probe },
    );
    assert.equal(first.decision, 'block', incident.name);
    assert.match(
      first.reason,
      new RegExp(`^Your ${incident.kind ?? 'landing'} ${id.slice(0, 8)} is still running`),
    );
    // The named resume command resolves to the canonical wait on the original target.
    const argv = resolveTurnWait([id]);
    assert.equal(argv[0], 'agent');
    assert.equal(argv[1], s.root);
    assert.equal(argv[2], 'wait');
    const input = JSON.parse(argv[3]);
    assert(input.runId === id || input.operationIds?.[0] === id, incident.name);
    assert.equal(input.timeoutSeconds, undefined, 'resume uses the caller budget');
    assert.deepEqual(
      await turnEndDecision(
        { session_id: s.id, hook_event_name: 'Stop', stop_hook_active: true },
        { probe: probe.probe },
      ),
      {},
      `${incident.name}: second stop allowed`,
    );
    assert.equal(probe.calls.length, incident.queries, incident.name);
  }
});

test('nforge wait ID accepts a unique prefix and refuses unknown work or a missing session', async t => {
  const s = session(t),
    work = landing(s.root);
  recordTurnWork(work);
  assert.deepEqual(resolveTurnWait([work.id.slice(0, 8), '--budget', '90']).slice(-2), ['--budget', '90']);
  assert.throws(() => resolveTurnWait([randomUUID()]), { code: 'NOT_FOUND' });
  assert.throws(() => resolveTurnWait(['../etc']), { code: 'BAD_ARGUMENT' });
  assert.throws(() => resolveTurnWait([work.id], ''), { code: 'TURN_WORK_UNAVAILABLE' });
});

test('wait budget: agent mode defaults under 10 minutes; --budget forms parse strictly', () => {
  assert(AGENT_WAIT_SECONDS > 0 && AGENT_WAIT_SECONDS < 600);
  assert.equal(parseWaitBudget('540'), 540);
  assert.equal(parseWaitBudget('90s'), 90);
  assert.equal(parseWaitBudget('9m'), 540);
  assert.equal(parseWaitBudget('1500ms'), 1.5);
  for (const bad of [undefined, '', '-5', 'soon', '1h', '1e9']) assert.equal(parseWaitBudget(bad), undefined);
  const command = operationWait('/synthetic', { operationIds: [randomUUID()], until: 'acceptance' }).command;
  assert(
    !command.includes('timeoutSeconds'),
    'receipts never pin a deadline longer than the caller can wait',
  );
});

test('hosted wait honours its budget, returns one IN_PROGRESS line and records a live observer', async t => {
  const s = session(t),
    f = agentFixture(t),
    operationId = randomUUID(),
    transport = f.transport();
  const query = transport.query.bind(transport);
  let observedDuringWait;
  transport.query = async (name, args) => {
    if (name === 'projectHostedFinishObserve:page') {
      observedDuringWait ??= readTurnLedger(s.id).work[0];
      throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'HTTP 502');
    }
    return query(name, args);
  };
  const oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  const written = [];
  t.mock.method(process.stderr, 'write', text => written.push(String(text)) || true);
  const started = performance.now();
  const response = await hostedAgentCli(
    f.root,
    'wait',
    { operationIds: [operationId], until: 'acceptance', timeoutSeconds: 0.3 },
    f.address,
    transport,
  );
  const elapsed = performance.now() - started;
  assert(elapsed >= 250 && elapsed < 5000, `${elapsed} ms`);
  assert.equal(response.result.status, 'IN_PROGRESS');
  assert.equal(response.result.budgetSeconds, 0.3);
  assert.equal(process.exitCode, 3);
  assert.deepEqual(written, []);
  assert(JSON.stringify(response).split('\n').length === 1);
  assert.equal(observedDuringWait.pid, process.pid, 'a running wait is a live observer');
  const after = readTurnLedger(s.id).work[0];
  assert.equal(after.id, operationId);
  assert.equal(after.pid, null);
  assert.deepEqual(after.input, { operationIds: [operationId], until: 'acceptance' });
});

test('agent CLI --budget sets the wait deadline and is refused on other actions', async t => {
  const s = session(t),
    f = agentFixture(t),
    operationId = randomUUID();
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-test-credential';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
  const oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert(String(url).startsWith(f.address.url), 'No real HTTP calls');
    const body = JSON.parse(init.body);
    if (body.path === 'projectHostedFinishObserve:page') return new Response('bad gateway', { status: 502 });
    const { makeFunctionReference } = await import('convex/server');
    const value = await (String(url).endsWith('/api/query')
      ? f.exchange.client.query(makeFunctionReference(body.path), body.args[0])
      : f.exchange.client.mutation(makeFunctionReference(body.path), body.args[0]));
    return new Response(JSON.stringify({ status: 'success', value }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  t.mock.method(process.stderr, 'write', () => true);
  const command = JSON.stringify({ ...f.address, operationIds: [operationId], until: 'acceptance' });
  const started = performance.now();
  const response = await agentCli([f.root, 'wait', command, '--budget', '300ms'], { process: true });
  assert(performance.now() - started < 5000);
  assert.equal(response.result.status, 'IN_PROGRESS');
  assert.equal(response.result.budgetSeconds, 0.3);
  assert(response.result.command.includes('"timeoutSeconds":0.3'), 'resume keeps the caller budget');
  assert.equal(readTurnLedger(s.id).work[0].id, operationId);
  await assert.rejects(agentCli([f.root, 'status', '{}', '--budget', '5']), { code: 'BAD_ARGUMENT' });
  await assert.rejects(agentCli([f.root, 'wait', command, '--budget', 'soon']), { code: 'BAD_ARGUMENT' });
});

test('install adds one Stop guard per client beside first-write hooks; uninstall and migration keep others', t => {
  const s = session(t),
    home = join(s.directory, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const other = { hooks: [{ type: 'command', command: 'other-stop-hook' }] };
  for (const path of ['.claude/settings.json', '.codex/hooks.json'])
    writeFileSync(join(home, path), JSON.stringify({ hooks: { Stop: [other] } }));
  for (let i = 0; i < 2; i++)
    installEditHooks(s.directory, undefined, false, home, false, {
      runner: join(s.directory, 'old-build', 'dist', 'agent-edit-hook.js'),
    });
  for (const path of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(readFileSync(join(home, path), 'utf8'));
    assert.equal(config.hooks.Stop.length, 2);
    assert.deepEqual(config.hooks.Stop[0], other);
    const guard = config.hooks.Stop[1].hooks[0];
    assert.match(guard.command, /agent-stop-hook\.js' '--forge-turn-end'$/);
    assert.equal(guard.timeout, 5);
  }
  const moved = join(s.directory, 'next-build', 'dist', 'agent-edit-hook.js');
  migrateEditHookRunner(moved, home);
  const migrated = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
  assert(
    migrated.hooks.Stop[1].hooks[0].command.includes(
      join(s.directory, 'next-build', 'dist', 'agent-stop-hook.js'),
    ),
  );
  assert(migrated.hooks.PreToolUse[0].hooks[0].command.includes(moved));
  installEditHooks(s.directory, undefined, true, home);
  for (const path of ['.claude/settings.json', '.codex/hooks.json'])
    assert.deepEqual(JSON.parse(readFileSync(join(home, path), 'utf8')), { hooks: { Stop: [other] } });
});
