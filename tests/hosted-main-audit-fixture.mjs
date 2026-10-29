// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { hostedCheckRunSchema, checkPin } from '../dist/hosted-check.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
export const state = await import(moduleUrl('../convex/projectHostedMainAuditState.ts'));
export const audit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const checkStore = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
export async function auditFixture() {
  const f = await checksFixture();
  const template = await f.enqueue(f.selection());
  const project = f.tables.hostedProjects.get(f.projectId);
  f.tables._scheduled_functions = new Map();
  f.decorateContext(ctx => {
    ctx.db.system = { get: ctx.db.get };
    ctx.scheduler = {
      runAfter: (delay, ref, args) =>
        ctx.db.insert('_scheduled_functions', {
          name: getFunctionName(ref),
          args: [args],
          scheduledTime: Date.now() + delay,
          state: { kind: 'pending' },
        }),
      cancel: async id => {
        const task = await ctx.db.get(id);
        if (task?.state.kind === 'pending') await ctx.db.patch(id, { state: { kind: 'canceled' } });
      },
    };
  });
  await f.bindRepository(f.projectId, { repository: 'synthetic/audit', repoId: 77 });
  const runner = {
    provider: 'github-actions',
    repository: 'synthetic/audit',
    runsOn: 'ubuntu-latest',
    runtime: 'c'.repeat(64),
    environmentFingerprint: 'd'.repeat(64),
  };
  const configuration = await f.configure({ kind: 'runner', configuration: runner }, f.configuration.digest);
  const call = (name, fn, args = {}, actor = 'owner') => f.transaction(name, fn, args, actor);
  const run = (name, fn, args = {}) => call(name, { _handler: fn }, args);
  let previousHead = f.state.sha256;
  let revision = 0;
  async function land(mode = 'contract', options = {}) {
    const sequence = ++revision;
    const head = options.head ?? checkPin({ fixture: 'main', sequence });
    const candidate = {
      ...f.candidate,
      id: randomUUID(),
      at: new Date().toISOString(),
      base: { head: previousHead, receiptId: `main-${sequence - 1}` },
      result: { status: 'clean', head },
    };
    await run('auditSeedCandidate', records.writeHostedRecord, {
      ...f.auth,
      record: candidate,
      expectedVersion: null,
    });
    const body = [...f.tables.projectHostedRecords.values()].find(row => row.key === candidate.id);
    const selected = hostedCheckRunSchema.parse({
      ...template,
      id: randomUUID(),
      request: {
        ...template.request,
        candidateId: candidate.id,
        expectedHead: head,
        expectedConfiguration: configuration.digest,
      },
      candidate: { ...template.candidate, digest: body.digest, base: candidate.base },
      configuration: runner,
      status: 'passed',
      terminalDigest: 'e'.repeat(64),
      planDigest: 'f'.repeat(64),
      executionId: 'synthetic-execution',
      exitCode: 0,
      plan: {
        head,
        definition: f.definition.digest,
        runtime: runner.runtime,
        environmentFingerprint: runner.environmentFingerprint,
        lockfile: 'f'.repeat(64),
        selection: f.put('synthetic-selection'),
        manifest: f.put('synthetic-manifest'),
        shardCount: 1,
      },
      counts: { completed: 1, passed: 1, failed: 0 },
      endedAt: new Date().toISOString(),
      gate: {
        mode: mode === 'docs' ? 'contract' : mode,
        effective: mode === 'docs' ? 'docs' : mode === 'full' ? 'full' : 'contract',
      },
    });
    const id = randomUUID();
    const receipt = hostedAcceptanceSchema.parse({
      schema: 1,
      id,
      projectId: f.projectId,
      channel: 'main',
      submissionId: randomUUID(),
      operationId: randomUUID(),
      attemptId: randomUUID(),
      at: options.at ?? new Date().toISOString(),
      authorityEpoch: 1,
      previous: candidate.base,
      candidate: {
        id: candidate.id,
        digest: body.digest,
        head,
        inputs: candidate.inputs,
        dependencies: candidate.dependencies,
        algorithm: candidate.algorithm,
      },
      actor: { id: 'owner', kind: options.actorKind ?? 'agent' },
      policyDigest: 'a'.repeat(64),
      check: {
        runId: selected.id,
        checkId: f.checkId,
        definition: f.definition.digest,
        configuration: configuration.digest,
        environment: runner.environmentFingerprint,
        terminalDigest: 'e'.repeat(64),
        planDigest: 'f'.repeat(64),
        executionId: 'synthetic-execution',
      },
      snapshot: { id, previousId: `main-${sequence - 1}`, revision: sequence },
      completion: { root: 'a'.repeat(64), pages: 0, lanes: 0, enabled: false },
      automatic: true,
      undo: { kind: 'revert', receiptId: id },
    });
    await run('auditLanding', async ctx => {
      await ctx.db.insert('projectHostedAcceptances', {
        projectId: f.projectId,
        receiptId: id,
        submissionId: receipt.submissionId,
        attemptId: receipt.attemptId,
        sequence,
        value: canonicalPayload(receipt),
      });
      await state.noteMainLanding(ctx, { project, receipt, run: selected });
    });
    previousHead = head;
    return { receipt, run: selected };
  }
  const row = () => [...f.tables.projectHostedMainAudits.values()][0];
  const pending = (name = 'projectHostedMainAudit:start') =>
    [...f.tables._scheduled_functions.values()].filter(
      task => task.name === name && task.state.kind === 'pending',
    );
  const start = async (args = {}) => {
    const prior = process.env.FORGE_HOSTED_CHECK_KEY_ID;
    process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
    try {
      return await call('auditStart', audit.start, { projectId: f.projectId, ...args });
    } finally {
      if (prior === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
      else process.env.FORGE_HOSTED_CHECK_KEY_ID = prior;
    }
  };
  const tick = async task => {
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    const clock = Date.now;
    Date.now = () => Math.max(clock(), task.scheduledTime);
    try {
      await start(task.args[0]);
    } finally {
      Date.now = clock;
    }
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  };
  const currentRun = () => {
    const selected = [...f.tables.projectHostedCheckRuns.values()].find(
      item => item.runId === row()?.audit?.runId,
    );
    return selected ? hostedCheckRunSchema.parse(JSON.parse(selected.value)) : null;
  };
  const terminal = async (status = 'passed', selected = currentRun()) => {
    const finished = hostedCheckRunSchema.parse({
      ...selected,
      status,
      endedAt: new Date().toISOString(),
      terminalDigest: checkPin({ run: selected.id, status }),
      exitCode: status === 'passed' ? 0 : 1,
    });
    await run('auditTerminal', async ctx => {
      await checkStore.completeHostedCheck(ctx, finished);
      const stored = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === selected.id);
      await checkStore.writeHostedCheck(ctx, stored._id, finished);
    });
    return finished;
  };
  return {
    ...f,
    call,
    run,
    land,
    row,
    pending,
    start,
    tick,
    currentRun,
    terminal,
    setRevision: value => {
      revision = value;
    },
    project,
  };
}
