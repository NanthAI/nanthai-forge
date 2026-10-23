import { cleanupOwner } from './owner-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { checkEnvironment } from '../dist/work-run.js';
import { enqueueLanding } from '../dist/landing-batch-store.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { trustAgents } from './autonomy-fixture.mjs';

export async function fixture(
  t,
  { remote = true, delay = 25, failWhen = "exists('bad.txt')", files = { 'same.txt': 'original\n' } } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'forge-batch-'));
  const credentialRoot = mkdtempSync(join(tmpdir(), 'forge-batch-credentials-'));
  const credentialsRef = { kind: 'file', path: join(credentialRoot, 'modal.json') };
  writeFileSync(
    credentialsRef.path,
    JSON.stringify({ tokenId: 'synthetic-project-id', tokenSecret: 'synthetic-project-secret' }),
    { mode: 0o600 },
  );
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    work = agent.work,
    store = work.store;
  const saved = {
    FORGE_MODAL_PYTHON: process.env.FORGE_MODAL_PYTHON,
    FORGE_WORK_LOCK_WAIT_MS: process.env.FORGE_WORK_LOCK_WAIT_MS,
    FORGE_CHECK_QUEUE_DIR: process.env.FORGE_CHECK_QUEUE_DIR,
  };
  // Detached audits and parallel controllers legitimately write the same synthetic owner.
  process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
  process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'fixture-queue');
  const mock = join(store.directory, 'mock-modal.mjs');
  writeFileSync(
    mock,
    `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';
const plan=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const exists=name=>fs.existsSync(path.join(plan.source,name));
setTimeout(()=>console.log(JSON.stringify({kind:'result',pin:plan.pin,head:plan.head,definition:plan.definition,exitCode:(${failWhen})?1:0,estimatedCostUsd:0})),${delay});\n`,
  );
  chmodSync(mock, 0o700);
  process.env.FORGE_MODAL_PYTHON = mock;
  const check = (
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: [
        '-e',
        `const exists=name=>require('fs').existsSync(name);setTimeout(()=>process.exit((${failWhen})?1:0),${delay})`,
      ],
    })
  ).result;
  await agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: remote ? 'modal' : 'local', credentialsRef },
  });
  t.after(async () => {
    // All remote calls, including detached audits, use the synthetic client above.
    process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
    process.env.FORGE_MODAL_PYTHON = mock;
    process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'fixture-queue');
    await drainPostAccept(store);
    await cleanupOwner(root);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(credentialRoot, { recursive: true, force: true });
  });
  const pending = [];
  async function candidate(path, text = `${path}\n`, enqueue = true, intentId) {
    const lane = (
      await agent.dispatch({
        action: 'start',
        outcome: `Synthetic ${path}`,
        ...(intentId ? { intentId } : {}),
      })
    ).result;
    writeFileSync(join(lane.path, path), text);
    const checkpoint = (
      await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Synthetic candidate' })
    ).result;
    const composed = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        laneId: lane.laneId,
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: checkpoint.head }],
        dependencies: [],
      })
    ).result;
    const view = store.select('views', composed.viewId);
    const definition = store.load().checks[0];
    const command = {
      action: 'finish',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: checkpoint.head,
      message: 'Synthetic landing',
      checkId: definition.id,
      expectedDefinition: definition.definition,
      expectedEnvironment: checkEnvironment().fingerprint,
      dependencies: [],
      accept: { channel: 'main', expectedPrevious: null },
      keepOpen: false,
    };
    if (enqueue) await enqueueLanding(work, command, view);
    pending.push(command.operationId);
    return { lane, checkpoint, view, command };
  }
  const main = () =>
    store
      .load()
      .channelMoves.filter(move => move.channel === 'main')
      .at(-1);
  const content = path => {
    const source = new NativeSource(root),
      file = source.state(main().head).files.find(file => file.path === path);
    return file && source.object(file.blob).toString();
  };
  return { root, agent, work, store, check, candidate, main, content, pending };
}
