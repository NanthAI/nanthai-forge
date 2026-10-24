// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { trustAgents } from './autonomy-fixture.mjs';

async function until(condition, details = () => '', timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < end, `fixture barrier timed out: ${details()}`);
    await delay(20);
  }
}

test('eight saved CLI finishes admit during an active landing check despite unrelated composition races', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-finish-stale-'));
  writeFileSync(join(root, 'base.txt'), 'base\n');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store,
    children = [];
  const release = join(store.directory, 'release'),
    ready = join(store.directory, 'ready');
  t.after(async () => {
    writeFileSync(release, 'release');
    for (const child of children) if (!child.closed) child.proc.kill('SIGKILL');
    await Promise.allSettled(children.map(child => child.done));
    await drainPostAccept(store);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},20);`,
    ],
  });
  await agent.dispatch({ action: 'set-policy', operationId: randomUUID(), checks: { runner: 'local' } });
  // Retained history, saved Lanes, and a running batch distinguish this from the
  // empty-owner fixture where all finishes start behind the same writer lock.
  store.locked(() => {
    const data = store.load();
    for (let i = 0; i < 100; i++)
      data.intents.push({
        id: randomUUID(),
        outcome: `Retained synthetic intent ${i}`,
        constraints: '',
        createdAt: new Date().toISOString(),
        base: data.nativeHead,
        status: 'completed',
        notes: [],
        dependencies: [],
      });
    data.revision++;
    store.save(data);
  });
  const commands = [];
  for (let i = 0; i < 8; i++) {
    const lane = (await agent.dispatch({ action: 'start', outcome: `Synthetic finish ${i}` })).result;
    writeFileSync(join(lane.path, `lane-${i}.txt`), `${i}\n`);
    const saved = (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Saved' }))
      .result;
    commands.push({
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: saved.head,
      message: 'Concurrent finish',
      accept: true,
      // Match the existing concurrent-checkpoint fixture's admission patience.
      // The injected writer invalidates every old compose attempt regardless of
      // patience; an artificially short lock timeout would test a different case.
      lockWaitMs: 60000,
    });
  }
  const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href;
  function launch(command, race) {
    const body = `
      import {agentCli} from ${JSON.stringify(moduleUrl('agent-cli'))};
      import {NativeSource} from ${JSON.stringify(moduleUrl('native-source'))};
      import {WorkStore} from ${JSON.stringify(moduleUrl('work-store'))};
      const root=process.argv[1], command=JSON.parse(process.argv[2]), peer=new WorkStore(root);
      const compose=NativeSource.prototype.compose;
      if(process.argv[3]==='race') NativeSource.prototype.compose=function(...args){
        const result=compose.apply(this,args);
        if(args[2]==='Native review composition') peer.locked(()=>{
          const tx=peer.records();
          tx.patchFields('lanes',command.laneId,{concurrentExtension:'retained'});
          peer.commitRecords(tx);
        });
        return result;
      };
      try {
        let reply;
        do { reply=await agentCli([root,'finish',JSON.stringify(command)]); Object.assign(command,reply.result.resolved); }
        while(!reply.result.terminal);
        const replay=await agentCli([root,'finish',JSON.stringify({operationId:command.operationId})]);
        if(replay.result.acceptance.acceptanceId!==reply.result.acceptance.acceptanceId) throw Error('CLI retry changed the acceptance');
        console.log(JSON.stringify(reply));
      } catch(error) { console.error(error.code,error.stack); process.exitCode=1; }
    `;
    const proc = spawn(
      process.execPath,
      ['--input-type=module', '-e', body, root, JSON.stringify(command), race ? 'race' : 'plain'],
      {
        env: { ...process.env, FORGE_CHECK_QUEUE_DIR: join(store.directory, 'check-queue') },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const child = { proc, stdout: '', stderr: '', closed: false };
    proc.stdout.on('data', bytes => (child.stdout += bytes));
    proc.stderr.on('data', bytes => (child.stderr += bytes));
    child.done = new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', code => {
        child.closed = true;
        resolve({ code, child });
      });
    });
    children.push(child);
    return child;
  }
  launch(commands[0], false);
  await until(
    () => existsSync(ready),
    () => children[0].stderr,
  );
  assert.ok(store.load().landingBatches.some(batch => batch.status === 'checking'));
  for (const command of commands.slice(1)) {
    launch(command, true);
    await delay(60);
  }
  await until(
    () => {
      if (children.slice(1).some(child => child.closed)) return true;
      try {
        return store.load().landingEntries.length === 8;
      } catch (error) {
        if (error.code === 'SOURCE_CHANGED') return false;
        throw error;
      }
    },
    () => children.map(child => child.stderr).join('\n'),
    // A waiter may use its full 60s lock patience before publication. The
    // barrier must not impose a shorter deadline on that permitted wait.
    120000,
  );
  writeFileSync(release, 'release');
  const replies = await Promise.all(children.map(child => child.done));
  for (const { code, child } of replies) {
    assert.equal(code, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).result.status, 'accepted', child.stdout);
  }
  const data = store.load(),
    source = new NativeSource(root);
  assert.equal(data.landingEntries.length, 8);
  assert.ok(data.landingEntries.every(entry => entry.status === 'accepted'));
  const main = data.channelMoves.at(-1).head,
    files = source.state(main).files;
  for (let i = 0; i < 8; i++) {
    assert.equal(source.object(files.find(file => file.path === `lane-${i}.txt`).blob).toString(), `${i}\n`);
    if (i) assert.equal(store.select('lanes', commands[i].laneId).concurrentExtension, 'retained');
    assert.equal(
      store.select('lanes', commands[i].laneId).checkpoints.length,
      2,
      'one save and one unchanged finish checkpoint',
    );
  }
});
