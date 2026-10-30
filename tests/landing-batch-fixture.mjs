import { actionsRunnerFixture } from './actions-runner-fixture.mjs';
import { cleanupOwner } from './owner-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { checkEnvironment } from '../dist/work-run.js';
import { withDetachedChecks } from '../dist/check-execution-context.js';
import { enqueueLanding } from '../dist/landing-batch-store.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { trustAgents } from './autonomy-fixture.mjs';

export async function fixture(
  t,
  {
    remote = true,
    delay = 25,
    failWhen = "exists('bad.txt')",
    files = { 'same.txt': 'original\n' },
    stopChecks = false,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'forge-batch-'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    work = agent.work,
    store = work.store;
  // Match CLI execution ownership: a passed receipt can precede provider cleanup.
  // Detached controllers remain joinable by cleanupOwner until that cleanup ends.
  const dispatch = agent.dispatch.bind(agent);
  agent.dispatch = (...args) => withDetachedChecks(() => dispatch(...args));
  const saved = {
    PATH: process.env.PATH,
    FORGE_WORK_LOCK_WAIT_MS: process.env.FORGE_WORK_LOCK_WAIT_MS,
    FORGE_CHECK_QUEUE_DIR: process.env.FORGE_CHECK_QUEUE_DIR,
  };
  // Detached audits and parallel controllers legitimately write the same synthetic owner.
  process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
  process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'fixture-queue');
  const provider = actionsRunnerFixture(store.directory, { delay, failWhen });
  process.env.PATH = `${provider.bin}:${saved.PATH}`;
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
    checks: { runner: remote ? 'github-actions' : 'local', repo: 'synthetic/checks' },
  });
  t.after(async () => {
    // All remote calls, including detached audits, use the synthetic client above.
    process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
    process.env.PATH = `${provider.bin}:${saved.PATH}`;
    process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'fixture-queue');
    // Diagnostics inspect bounded headers through the status index, never Work histories.
    const records = store.readRecords();
    const interrupted = records
      ? records
          .positions('runs', 'interrupted', 'status')
          .slice(-8)
          .map(position => records.fieldsAt('runs', position).record)
      : [];
    for (const run of interrupted) {
      const summary = join(store.directory, `check-${run.id}`, 'controller-summary.txt');
      t.diagnostic(
        JSON.stringify({
          runId: run.id,
          error: run.error,
          details: run.details,
          controller: existsSync(summary) ? readFileSync(summary, 'utf8') : undefined,
        }),
      );
    }
    await drainPostAccept(store);
    await cleanupOwner(root, undefined, { stopChecks });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const pending = [];
  const soloRuns = new Set();
  // Real full singleton evidence for tests whose subject is combined checking.
  async function checkCandidates(candidates) {
    const views =
      candidates?.map(item => item.view) ??
      store.load().landingEntries.map(entry => store.select('views', entry.viewId));
    for (const view of views) {
      const run = (await agent.dispatch({ action: 'run', viewId: view.id })).result;
      if (run.status !== 'passed')
        throw new Error(
          `Fixture solo check failed: ${run.status}; ${store.select('runs', run.runId)?.details}`,
        );
      soloRuns.add(run.runId);
    }
  }
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
  return {
    root,
    agent,
    work,
    store,
    check,
    provider,
    candidate,
    main,
    content,
    pending,
    checkCandidates,
    soloRuns,
  };
}
