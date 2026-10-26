// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpTestEnvironment, requestOptions, callTool } from './mcp-runtime.mjs';
import { fixture } from './landing-batch-fixture.mjs';
import { until } from './landing-worker-fixture.mjs';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { processAlive, processIdentity } from '../dist/local-process.js';
import { landingWorkerStates, saveLandingWorkerState } from '../dist/landing-worker-status.js';
import { runCheckController } from '../dist/check-controller.js';
const read = path => JSON.parse(readFileSync(path));
const moduleUrl = name => new URL('../dist/' + name + '.js', import.meta.url).href;

export async function readOnlyMcpLifetime(t) {
  const f = await fixture(t, { remote: false, stopChecks: true });
  const input = await f.candidate('mcp-pending.txt');
  const client = new Client({ name: 'lifetime-replay', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../dist/cli.js', import.meta.url).pathname, 'mcp', f.root, '--agent'],
    env: mcpTestEnvironment(t),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport, requestOptions('connect'));
    await client.listTools(undefined, requestOptions('listTools'));
    await callTool(client, {
      name: 'forge_work_overview',
      arguments: { action: 'status', laneId: input.lane.laneId },
    });
    assert.deepEqual(landingWorkerStates(f.store), []);
    assert.equal(f.store.select('landingEntries', input.command.operationId).status, 'queued');
    assert.equal(f.store.load().runs.length, 0);
  } finally {
    await client.close();
  }
  assert.deepEqual(landingWorkerStates(f.store), []);
}

export async function replayActionsLifetime(t, drive) {
  const sockets = new Set();
  let released = false;
  const release = () => {
    released = true;
    for (const socket of sockets) socket.end();
  };
  // Release the gate before the fixture's controller cleanup, even if an earlier
  // assertion fails. The fake publisher cannot observe cancellation while gated.
  t.after(release);
  const f = await fixture(t, { remote: false, stopChecks: true });
  const input = await f.candidate('lifetime.txt');
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'github-actions', repo: 'synthetic/checks' },
  });
  const batch = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, batch);
  const prefix = f.store.select('landingBatches', batch.id).prefixes[0];
  // Model an already-running owner receiving command wakes. The check's real
  // detached controller is exercised below; no provider account is available.
  const owner = {
    schema: 1,
    id: randomUUID(),
    worker: processIdentity(),
    status: 'idle',
    observedAt: new Date().toISOString(),
    endpoint: join(f.root, 'owner-wake.sock'),
  };
  saveLandingWorkerState(f.store, owner);
  const endpoint = join(f.root, 'gate');
  const gate = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (released) socket.end();
  });
  const listening = once(gate, 'listening');
  gate.listen(endpoint);
  await listening;
  t.after(async () => {
    release();
    await new Promise(resolve => gate.close(resolve));
  });
  const controller = join(f.store.directory, 'fake-actions-controller.mjs');
  writeFileSync(
    controller,
    `import fs from 'node:fs'; import net from 'node:net';
import { WorkStore } from ${JSON.stringify(moduleUrl('work-store'))};
import { runCheckController } from ${JSON.stringify(moduleUrl('check-controller'))};
import { launchGithubActionsRun } from ${JSON.stringify(moduleUrl('work-github-actions-run'))};
const keep=setInterval(()=>{},60000); const commit='a'.repeat(40); const id=process.argv[3];
const job={id:20,name:'forge-static',status:'completed',conclusion:'success',run_attempt:1,started_at:'2026-10-01T12:00:00Z',completed_at:'2026-10-01T12:01:00Z'};
const api={async request(endpoint){if(endpoint.endsWith('/dispatches')){fs.appendFileSync(${JSON.stringify(join(f.store.directory, 'fake-dispatches'))},'dispatch\\n');return {};}
if(endpoint.endsWith('/timing'))return {billable:{}};if(endpoint.includes('/branches/'))return {commit:{sha:commit}};return {id:10,head_sha:commit,status:'completed',conclusion:'success',run_attempt:1};},
async pages(endpoint){if(endpoint.includes('/runs?'))return [{id:10,head_sha:commit,display_title:'forge-check/'+id}];if(endpoint.includes('/jobs'))return [job];return [];},async log(){return 'synthetic passed\\n';},async sleep(){}};
try {await runCheckController(new WorkStore(process.argv[2]), id, (store,run)=>launchGithubActionsRun(store,run,api,async(plan,journal,save)=>{
journal.commit=commit;journal.pushOutcome='not-sent';save();
await new Promise((resolve,reject)=>{const s=net.createConnection(${JSON.stringify(endpoint)});s.on('error',reject);s.on('end',resolve);s.resume();});
journal.pushed=true;journal.pushOutcome='accepted';save();},async()=>{}));} finally {clearInterval(keep);}
`,
  );
  const submitter = join(f.store.directory, 'short-lived-cli.mjs');
  writeFileSync(
    submitter,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';
const spawn=cp.spawn;cp.spawn=(executable,args,options)=>spawn(executable,args[0]?.endsWith('/check-controller-worker.js')?[${JSON.stringify(controller)},...args.slice(1)]:args,options);syncBuiltinESMExports();
fs.writeFileSync(${JSON.stringify(join(f.store.directory, 'submitter-pid'))},String(process.pid));
`,
  );
  const request = {
    operationId: prefix.runId,
    viewId: prefix.viewId,
    expectedHead: prefix.head,
    checkId: f.check.checkId,
    expectedDefinition: f.check.definition,
    expectedEnvironment: batch.environment.fingerprint,
    wait: false,
  };
  const reply = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      submitter,
      new URL('../dist/cli.js', import.meta.url).pathname,
      'agent',
      f.root,
      'run',
      JSON.stringify(request),
    ],
    {
      timeout: 20_000,
    },
  );
  assert.equal(JSON.parse(reply.stdout).result.operationId, prefix.runId);
  const submitterPid = Number(readFileSync(join(f.store.directory, 'submitter-pid'), 'utf8'));
  await until(f, () => sockets.size > 0, 'Actions export reached the not-sent gate');
  const run = f.store.select('runs', prefix.runId),
    path = join(f.store.directory, `check-${prefix.runId}`);
  assert.equal(processAlive({ pid: submitterPid }), false);
  assert.notEqual(run.runner.pid, submitterPid);
  assert.equal(processAlive(run.runner), true);
  assert.equal(run.status, 'running');
  assert.equal(read(join(path, 'github-actions.json')).pushOutcome, 'not-sent');
  assert.match(readFileSync(join(path, 'controller-summary.txt'), 'utf8'), /Pinned/);
  assert.deepEqual(
    landingWorkerStates(f.store).map(state => state.id),
    [owner.id],
  );
  const peerClaim = await runCheckController(f.store, prefix.runId, async () =>
    assert.fail('a second wake must not execute the leased check'),
  );
  assert.ok('waiting' in peerClaim);
  // An unrelated finite read neither takes ownership nor creates another worker.
  await promisify(execFile)(
    process.execPath,
    [
      new URL('../dist/cli.js', import.meta.url).pathname,
      'agent',
      f.root,
      'status',
      JSON.stringify({ laneId: input.lane.laneId }),
    ],
    { timeout: 20_000 },
  );
  assert.equal(f.store.select('runs', prefix.runId).runner.pid, run.runner.pid);
  assert.deepEqual(
    landingWorkerStates(f.store).map(state => state.id),
    [owner.id],
  );
  release();
  await until(
    f,
    () => f.store.select('runs', prefix.runId)?.status === 'passed',
    'same Actions run completes after submitter exit',
  );
  assert.equal(readFileSync(join(f.store.directory, 'fake-dispatches'), 'utf8'), 'dispatch\n');
  await f.agent.dispatch({ action: 'set-policy', operationId: randomUUID(), checks: { runner: 'local' } });
  saveLandingWorkerState(f.store, { ...owner, status: 'stopped', observedAt: new Date().toISOString() });
  await drive(f, async () => {
    await until(
      f,
      () => f.store.select('landingEntries', input.command.operationId)?.status === 'accepted',
      'original queued landing settles',
    );
    assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
    assert.equal(f.content('lifetime.txt'), 'lifetime.txt\n');
  });
}
