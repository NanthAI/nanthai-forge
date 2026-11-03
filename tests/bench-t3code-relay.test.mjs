// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgeArm, readCalls } from '../scripts/bench-t3code/forge-arm.mjs';
import { operationsOf } from '../scripts/bench-t3code/receipts.mjs';
import { prompt, template, WORKFLOW_SLOT } from '../scripts/bench-t3code/prompt.mjs';
import { hostedAgentHelpEntries } from '../dist/hosted-agent-help.js';
import { lowerVerb, parseVerbForm } from '../dist/agent-verbs.js';

function checkPrompt(text) {
  const supported = new Set(hostedAgentHelpEntries.map(entry => entry.action));
  const commands = [...text.matchAll(/`nforge agent \. ([^`]+)`/g)];
  assert.ok(commands.length > 0, 'extract commands from the actual rendered prompt');
  for (const [, command] of commands) {
    const [verb, ...args] = command.split(/\s+/);
    const [form] = parseVerbForm(verb, args);
    // The help export is generated from the enforced hosted schemas, including client actions.
    assert.ok(supported.has(lowerVerb(form, true)), command);
  }
}

test('prompt: every advertised verb is accepted by the hosted CLI action table', () => {
  const task = { prompt: 'Synthetic task' };
  const text = prompt(task, 'forge', { projectName: 'fixture' });
  checkPrompt(text);
  assert.throws(() => checkPrompt(text + " `nforge agent . log '{}'`"), /log/);
  assert.throws(() => checkPrompt(text + ' `nforge agent . land --resume-ready`'), /resume-ready/);
  const github = prompt(task, 'github', { repository: 'fixture/repo', branch: 'agent-1/task' });
  const [before, after] = template(task).split(WORKFLOW_SLOT);
  for (const rendered of [text, github]) {
    assert.ok(rendered.startsWith(before));
    assert.ok(rendered.endsWith(after), 'shared instructions stay identical in both arms');
  }
});

test(
  'relay: stdout/stderr reach the generated shim before CLI exit, with audit and exit status intact',
  { timeout: 15_000 },
  async t => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-relay-live-')));
    const root = join(dir, 'ws');
    mkdirSync(root);
    let release, gateReady;
    const waiting = new Promise(done => {
      gateReady = done;
    });
    const gate = createServer((_req, res) => {
      release = () => res.end();
      gateReady();
    });
    gate.listen(0, '127.0.0.1');
    await once(gate, 'listening');
    const id = '11111111-1111-4111-8111-111111111111';
    const stdout =
      Array.from({ length: 600 }, (_, i) => `progress ${i}: café 🚀\n`).join('') + 'partial stdout';
    const stderr = Array.from({ length: 600 }, (_, i) => `waiting ${i}\n`).join('') + 'partial stderr';
    const cli = join(dir, 'cli.mjs');
    writeFileSync(
      cli,
      `
const gate = fetch('http://127.0.0.1:${gate.address().port}');
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
await (await gate).text();
console.log('\\n' + JSON.stringify({ action: 'finish', operationId: '${id}', result: { phase: 'finish' } }));
console.error('\\n' + JSON.stringify({ error: { code: 'SYNTHETIC_FAILURE', message: 'synthetic stderr failure' } }));
process.exitCode = 7;
`,
    );
    const log = join(dir, 'calls.jsonl');
    const arm = forgeArm({ cli }, { callLog: log, ws: dir });
    let child;
    t.after(() => {
      release?.();
      child?.kill();
      arm.stopBroker();
      gate.closeAllConnections();
      gate.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const bin = join(dir, 'bin');
    await arm.binDir(bin);
    const env = await arm.agentEnv(root, 'synthetic-600', {});
    child = spawn(join(bin, 'nforge'), ['agent', '.', 'land', '{}'], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'close');
    let out = '',
      err = '';
    await new Promise((done, fail) => {
      const progress = () => {
        if (out === stdout && err === stderr) done();
      };
      child.stdout.on('data', d => {
        out += d;
        progress();
      });
      child.stderr.on('data', d => {
        err += d;
        progress();
      });
      child.once('error', fail);
      child.once('exit', () => fail(Error('CLI exited before both streams arrived')));
    });
    assert.equal(child.exitCode, null, 'handshake proves delivery while the CLI is still waiting');
    assert.equal(readCalls(log).length, 0, 'call has not completed yet');
    await waiting;
    release();
    assert.equal((await exited)[0], 7);
    assert.equal(
      out,
      stdout +
        '\n' +
        JSON.stringify({ action: 'finish', operationId: id, result: { phase: 'finish' } }) +
        '\n',
    );
    assert.equal(
      err,
      stderr +
        '\n' +
        JSON.stringify({ error: { code: 'SYNTHETIC_FAILURE', message: 'synthetic stderr failure' } }) +
        '\n',
    );
    const calls = readCalls(log);
    assert.equal(calls.length, 1, '600 progress records per stream still execute one CLI call');
    assert.deepEqual(calls[0].operationIds, [id]);
    assert.deepEqual(calls[0].errorCodes, ['SYNTHETIC_FAILURE']);
    assert.deepEqual(calls[0].error, { code: 'SYNTHETIC_FAILURE', message: 'synthetic stderr failure' });
    assert.deepEqual(calls[0].operations, [{ action: 'finish', operationId: id, receiptId: null }]);
    assert.equal(calls[0].code, 7);
    t.diagnostic(
      `600 records per stream delivered before exit; one CLI spawn, zero added Convex calls; ${Buffer.byteLength(out + err)} output bytes`,
    );
  },
);

test('relay client: fragmented UTF-8 frames, refusal and truncated/error responses', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-relay-wire-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = join(dir, 'client.mjs');
  writeFileSync(client, readFileSync(new URL('../scripts/bench-t3code/relay-client.mjs', import.meta.url)));
  for (const scenario of ['utf8', 'refusal', 'truncated', 'malformed', 'disconnected']) {
    const server = createServer((_req, res) => {
      if (scenario === 'utf8') {
        const bytes = Buffer.from(JSON.stringify({ stdout: 'café 🚀\npartial' }) + '\n');
        const split = bytes.indexOf(Buffer.from('🚀')) + 1;
        res.write(bytes.subarray(0, split));
        setImmediate(() => res.end(Buffer.concat([bytes.subarray(split), Buffer.from('{"code":0}\n')])));
      } else if (scenario === 'refusal')
        res.end(JSON.stringify({ stdout: '', stderr: 'refused\n', code: 2 }));
      else if (scenario === 'truncated') res.end('{"stdout":"early\\n"}\n');
      else if (scenario === 'malformed') res.end('bad json\n{"code":0}\n');
      else {
        res.write('{"stdout":"early\\n"}\n');
        setImmediate(() => res.destroy());
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const child = spawn(process.execPath, [client], {
        env: { ...process.env, BENCH_NFORGE_URL: `http://127.0.0.1:${server.address().port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', d => (stdout += d));
      child.stderr.on('data', d => (stderr += d));
      const [code] = await once(child, 'close');
      assert.equal(code, scenario === 'utf8' ? 0 : scenario === 'refusal' ? 2 : 1, scenario);
      if (scenario === 'utf8') assert.equal(stdout, 'café 🚀\npartial');
      else if (scenario === 'refusal') assert.equal(stderr, 'refused\n');
      else assert.match(stderr, /bench relay:/);
    } finally {
      server.closeAllConnections();
      await new Promise(done => server.close(done));
    }
  }
});

test('harness pin: streaming client changes invalidate the previous content pin', async () => {
  const { harness, differences } = await import('../scripts/bench-t3code/versions.mjs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-relay-pin-')));
  const scripts = join(dir, 'scripts');
  const bench = join(scripts, 'bench-t3code');
  mkdirSync(bench, { recursive: true });
  writeFileSync(join(scripts, 'benchmark-import-monitor.mjs'), '// fixture\n');
  for (const name of ['filesystem-event-health.mjs', 'filesystem-event-health-worker.mjs', 'child-env.mjs'])
    writeFileSync(join(scripts, name), '// fixture\n');
  const client = join(bench, 'relay-client.mjs');
  try {
    writeFileSync(client, '// previous relay\n');
    const before = await harness(bench);
    writeFileSync(client, readFileSync(new URL('../scripts/bench-t3code/relay-client.mjs', import.meta.url)));
    const after = await harness(bench);
    assert.notEqual(before.filesSha256, after.filesSha256);
    assert.ok(
      differences({ harness: before }, { harness: after }, { unpinned: true }).some(change =>
        change.startsWith('harness.filesSha256:'),
      ),
    );
    writeFileSync(join(scripts, 'filesystem-event-health.mjs'), '// changed probe\n');
    assert.notEqual(
      after.filesSha256,
      (await harness(bench)).filesSha256,
      'probe changes invalidate the harness pin',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('typed broker audit excludes suggested ack IDs and landing observer retains stderr errors', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-typed-receipts-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'ws');
  mkdirSync(root);
  const cli = join(dir, 'cli.mjs'),
    log = join(dir, 'calls.jsonl');
  const phantom = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeFileSync(
    cli,
    `
const action = process.argv[4];
if (action === 'observe') {
  console.log(JSON.stringify({ event: 'progress' }));
  console.error(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No retained landing operation' } }));
  process.exitCode = 1;
} else {
  const command = 'nforge agent . ack ' + JSON.stringify({ operationId: '${phantom}' });
  console.log(command);
  console.log(JSON.stringify({ schema: 1, action, operationId: action + '-id', result: {
    next: { action: 'ack', operationId: '${phantom}' }, command,
    ...(action === 'land' ? { submission: { acceptance: { receiptId: 'accepted' } } } : {}),
  } }));
}
`,
  );
  const { startBroker } = await import('../scripts/bench-t3code/broker.mjs');
  const broker = await startBroker(cli, log);
  t.after(() => new Promise(done => broker.server.close(done)));
  const post = (path, body) =>
    fetch(`http://127.0.0.1:${broker.port}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(response => response.text());
  await post('/register', { admin: broker.admin, token: 't', root, task: 'typed' });
  for (const action of ['sync', 'resolve', 'save', 'ack', 'land'])
    await post('/', { token: 't', cwd: root, args: ['agent', '.', action, '{}'] });
  const calls = readCalls(log);
  assert.deepEqual(
    calls.flatMap(call => call.operations),
    ['sync', 'resolve', 'save', 'ack', 'land'].map(action => ({
      action,
      operationId: action + '-id',
      receiptId: action === 'land' ? 'accepted' : null,
    })),
  );
  assert.ok(calls.every(call => !call.operationIds.includes(phantom)));
  assert.ok(
    calls.every(call => call.ids.includes(phantom)),
    'contamination still knows every ID shown',
  );
  const arm = forgeArm({ cli }, { callLog: log, ws: dir });
  assert.deepEqual(arm.taskOps('typed'), ['land-id']);
  const result = await arm.landing('typed', 'lane');
  assert.deepEqual(result.operations, [
    {
      operationId: 'land-id',
      error: {
        code: 'NOT_FOUND',
        message: 'No retained landing operation',
      },
    },
  ]);
});

test('dogfood collector observes only real landings at 575 and 1150 entries with zero backend calls', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-typed-scale-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const count of [575, 1150]) {
    const started = performance.now(),
      heap = process.memoryUsage().heapUsed;
    const records = [];
    for (const [action, size] of [
      ['finish', count],
      ['sync', count],
      ['resolve', count],
      ['ack', 560],
      ['save', 2800],
    ]) {
      for (let i = 0; i < size; i++)
        records.push({
          task: 'scale',
          operations: operationsOf(
            JSON.stringify({
              action,
              operationId: action + i,
              result: { next: { action: 'ack', operationId: 'phantom' + i } },
            }),
          ),
        });
    }
    const log = join(dir, 'calls.jsonl');
    writeFileSync(log, records.map(JSON.stringify).join('\n'));
    const arm = forgeArm({}, { callLog: log, ws: dir });
    let observations = 0;
    arm.observe = async () => {
      observations++;
      return { phase: 'landed', observation: { state: 'complete' } };
    };
    assert.equal(arm.taskOps('scale').length, count);
    const result = await arm.landing('scale', 'lane');
    assert.equal(result.landed, true);
    assert.equal(result.operations.length, count);
    assert.equal(observations, count, 'one existing observation per landing, none for source/advice');
    assert.ok(Buffer.byteLength(JSON.stringify(records)) < records.length * 160, 'compact local handles');
    t.diagnostic(
      `${count} landings / ${records.length} CLI records: ${observations} fake observations, zero Convex calls/documents, ${(performance.now() - started).toFixed(1)} ms, heap delta ${process.memoryUsage().heapUsed - heap} bytes, process peak RSS ${process.resourceUsage().maxRSS * 1024} bytes`,
    );
  }
});
