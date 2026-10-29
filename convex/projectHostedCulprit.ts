// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { beginHostedOperation, finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import { beginCheckOperation, loadHostedCheck } from './projectHostedCheckStore';
import { insertHostedCheckRun } from './projectHostedChecks';
import { hostedWriteProject, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { prepareHostedRevert } from './projectHostedRevert';
import { armAudit, auditSettings } from './projectHostedMainAuditState';
import { auditMetadata, auditDebt, auditDue } from '../src/main-audit';
import { hostedStartMain } from './projectHostedChannels';
import { saveObject } from './projectHostedSaveStore';
import { hostedSyncInput, loadSync, writeSyncState, type SyncState } from './projectHostedSyncStore';
import { hostedComposeInput, loadCompose, type ComposeState } from './projectHostedComposeStore';
import { submitHostedCompose } from './projectHostedComposeJobs';
import { enqueueSourceJob } from './projectSourceJobs';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { enqueueHostedLanding } from './projectHostedLanding';
import { sourceWorkerPlan } from '../src/convex-source-provider';
import { hostedAcceptanceSchema, type HostedAcceptance } from '../src/hosted-acceptance';
import { hostedRecordSchema } from '../src/hosted-records';
import {
  hostedCheckRunSchema,
  checkPin,
  hostedCheckTerminal,
  type HostedCheckRun,
} from '../src/hosted-check';
import { canonicalPayload, hostedPayloadHash, hostedOperationSchema } from '../src/hosted-source-operation';
import { culpritId, culpritFailures, probeVerdict, bisectStep, type NeedsFix } from '../src/culprit-bisect';
import { buildComposePages } from '../src/hosted-compose';
import { savePin } from '../src/hosted-save';
import { hostedLandingRequestSchema } from '../src/hosted-landing';
import { presignPut, r2Config, r2Key } from './r2';
import { verifyArchiveUpload } from './archiveUpload';
import { ForgeError, invariant } from '../src/errors';

type Identity = { projectId: Id<'hostedProjects'>; runId: string };
type Recovery = {
  audit: HostedCheckRun;
  range: { sequence: number; receipt: HostedAcceptance }[];
  failed: NeedsFix['failed'];
  low: number;
  high: number;
  pass: { head: string; runId: string } | null;
  fail: { head: string; runId: string };
  probe: { id: string; index: number; flake: boolean } | null;
  stage: 'classify' | 'sync' | 'compose' | 'landing' | 'done';
  reason: string;
  undo?: string;
  target?: HostedAcceptance;
  intentId?: string;
  syncOperationId?: string;
  composeOperationId?: string;
  landingOperationId?: string;
  uploads?: { value: string; pin: { sha256: string; size: number } }[];
};
const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
const recoveryOperation = (runId: string) => culpritId({ recovery: runId });
async function recoveryRow(ctx: MutationCtx | QueryCtx, input: Identity, owner: string) {
  return hostedOperationRow(ctx, input.projectId, owner, recoveryOperation(input.runId));
}
async function retain(ctx: MutationCtx, row: Doc<'projectHostedOperations'>, state: Recovery) {
  await ctx.db.patch(row._id, { recovery: canonicalPayload(state) });
  if (state.stage === 'done') {
    const operation = hostedOperationSchema.parse(JSON.parse(row.value));
    await finishHostedOperation(ctx, {
      projectId: row.projectId,
      actor: row.actor,
      operationId: row.operationId,
      receipt: {
        attemptId: operation.firstAttempt.id,
        at: state.audit.endedAt!,
        outcome: {
          status: 'completed',
          result: {
            auditRunId: state.audit.id,
            reason: state.reason,
            culprit: state.target?.id ?? null,
            failed: state.failed,
            proof: { passed: state.pass, failed: state.fail },
            undo:
              state.undo ??
              (state.target
                ? report(state, state.target, 'needs-fix').undo
                : state.intentId
                  ? `nforge agent ROOT start '${JSON.stringify({ intentId: state.intentId })}'`
                  : 'No source was changed; no reverse is needed.'),
          },
        },
      },
    });
  }
}
async function wake(ctx: MutationCtx, input: Identity) {
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectHostedCulprit:drive'), input);
}
async function begin(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  operationId: string,
  payload: unknown,
  ids: Record<string, string>,
) {
  const expected = { authorityEpoch: project.sourceAuthority!.epoch };
  return (
    await beginHostedOperation(ctx, {
      projectId: project._id,
      actor: project.owner,
      payload,
      request: {
        schema: 1,
        projectId: project._id,
        actor: project.owner,
        operationId,
        expected,
        payloadHash: hostedPayloadHash(payload, expected),
      },
      firstAttempt: {
        projectId: project._id,
        operationId,
        id: culpritId({ operationId, attempt: 0 }),
        parentAttemptId: null,
        at: new Date().toISOString(),
        expected,
        ids,
      },
    })
  ).operation;
}
/** Called by canonical Intent writers when an owner closes or a fix re-lands. */
export async function clearNeedsFix(ctx: MutationCtx, projectId: Id<'hostedProjects'>, intentId: string) {
  const project = await ctx.db.get(projectId);
  if (!project?.needsFix?.[intentId]) return;
  const remaining = { ...project.needsFix };
  delete remaining[intentId];
  await ctx.db.patch(projectId, { needsFix: Object.keys(remaining).length ? remaining : undefined });
}
async function notice(ctx: MutationCtx, project: Doc<'hostedProjects'>, intentId: string, n: NeedsFix) {
  const row = await readHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    kind: 'intent',
    key: intentId,
  });
  if (!row) return;
  const intent = hostedRecordSchema.options[0].parse(JSON.parse(row.value));
  if (
    intent.needsFix?.auditRunId === n.auditRunId &&
    canonicalPayload(intent.needsFix) === canonicalPayload(n)
  )
    return;
  await writeHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    authorityEpoch: project.sourceAuthority!.epoch,
    expectedVersion: intent.version,
    record: {
      ...intent,
      version: intent.version + 1,
      status: intent.status === 'abandoned' ? 'abandoned' : 'active',
      needsFix: n,
    },
  });
  if (intent.status === 'abandoned') return;
  const current = (await ctx.db.get(project._id))!;
  await ctx.db.patch(project._id, {
    needsFix: {
      ...current.needsFix,
      [intentId]: canonicalPayload({
        state: n.state,
        auditRunId: n.auditRunId,
        ...(n.receiptId ? { receiptId: n.receiptId } : {}),
        head: n.head,
        summary: n.summary.slice(0, 240),
        undo: n.undo,
      }),
    },
  });
}
function report(
  state: Recovery,
  target: HostedAcceptance,
  mode: NeedsFix['state'],
  revertReceiptId?: string,
): NeedsFix {
  return {
    state: mode,
    auditRunId: state.audit.id,
    receiptId: target.id,
    head: target.candidate.head,
    previousHead: target.previous.head,
    sequence: state.range.at(-1)?.sequence ?? target.snapshot.revision,
    failed: state.failed,
    summary: `${mode === 'reverted' ? 'Reverted' : 'Fix needed for'} receipt ${target.id}: ${
      state.failed
        .slice(0, 3)
        .map(f => f.file)
        .join(', ') + (state.failed.length > 3 ? ` (+${state.failed.length - 3} more)` : '') ||
      'static/unknown failure'
    } failed on ${state.fail.head} (run ${state.fail.runId}); ${state.pass ? `passed on ${state.pass.head} (probe ${state.pass.runId})` : 'passing predecessor not established'}. ${state.reason}`,
    undo: revertReceiptId
      ? `nforge agent ROOT revert '${JSON.stringify({ target: { kind: 'receipt', receiptId: revertReceiptId } })}'`
      : `nforge agent ROOT start '{"intentId":"${state.intentId}"}'`,
    ...(revertReceiptId ? { revertReceiptId } : {}),
  };
}
async function candidateIntent(ctx: MutationCtx, project: Doc<'hostedProjects'>, receipt: HostedAcceptance) {
  const row = await readHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    kind: 'candidate',
    key: receipt.candidate.id,
  });
  return row ? hostedRecordSchema.options[3].parse(JSON.parse(row.value)).intentId : null;
}
async function fixForward(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  row: Doc<'projectHostedOperations'>,
  state: Recovery,
  reason: string,
) {
  const intentId = culpritId({ fixMain: state.audit.id });
  state.reason = reason;
  state.intentId = intentId;
  const target = state.target ?? state.range.at(-1)?.receipt;
  const old = await readHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    kind: 'intent',
    key: intentId,
  });
  const constraints = `Full main audit ${state.audit.id} failed on ${state.audit.request.expectedHead}. ${reason} Inspect nforge agent ROOT log '{"operationId":"${state.audit.id}","stream":"stderr"}'. Preserve later accepted work. ${target ? `Candidate receipt ${target.id}.` : 'No complete accepted range retained.'}`;
  if (!old)
    await writeHostedRecord(ctx, {
      projectId: project._id,
      actor: project.owner,
      authorityEpoch: project.sourceAuthority!.epoch,
      expectedVersion: null,
      record: {
        kind: 'intent',
        id: intentId,
        version: 0,
        at: state.audit.endedAt!,
        outcome: 'Fix main after failed audit',
        recoveryRunId: state.audit.id,
        constraints: constraints.slice(0, 4000),
        creatorAccountId: project.owner,
        assigneeAccountIds: [],
        base: { head: state.audit.request.expectedHead, receiptId: target?.id ?? 'unknown-audit-receipt' },
        status: 'active',
      },
    });
  const n: NeedsFix = target
    ? report(state, target, 'needs-fix')
    : {
        state: 'needs-fix',
        auditRunId: state.audit.id,
        head: state.audit.request.expectedHead,
        previousHead: state.audit.request.expectedHead,
        failed: state.failed,
        summary: `Main audit ${state.audit.id} failed. ${reason}`,
        undo: `nforge agent ROOT start '${JSON.stringify({ intentId })}'`,
      };
  await notice(ctx, project, intentId, n);
  if (target) {
    // Several candidates remain candidates; do not falsely name one as the culprit.
    for (const item of state.target ? [state.target] : []) {
      const original = await candidateIntent(ctx, project, item);
      if (original)
        await notice(ctx, project, original, {
          ...n,
          receiptId: item.id,
          head: item.candidate.head,
          previousHead: item.previous.head,
        });
    }
  }
  state.stage = 'done';
  await retain(ctx, row, state);
}
async function probe(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  state: Recovery,
  index: number,
  flake: boolean,
) {
  const receipt = state.range[index - 1]!.receipt,
    tests = state.failed.map(f => f.file);
  const operationId = culpritId({
    projectId: project._id,
    head: receipt.candidate.head,
    tests,
    definition: state.audit.check.definition,
    configuration: state.audit.request.expectedConfiguration,
    environment: state.audit.request.expectedEnvironment,
    epoch: state.audit.request.authorityEpoch,
  });
  const gate = { mode: 'probe' as const, tests, reason: `culprit:${state.audit.id}` };
  const request = {
    ...state.audit.request,
    operationId,
    candidateId: receipt.candidate.id,
    expectedHead: receipt.candidate.head,
    gate,
  };
  const prepared = await beginCheckOperation(ctx, {
    projectId: project._id,
    actor: project.owner,
    operationId,
    expected: { authorityEpoch: request.authorityEpoch, head: request.expectedHead },
    payload: {
      head: request.expectedHead,
      tests,
      definition: request.expectedDefinition,
      configuration: request.expectedConfiguration,
      environment: request.expectedEnvironment,
    },
  });
  const id = prepared.operation.firstAttempt.ids.run!;
  state.probe = { id, index, flake };
  if (prepared.replayed) {
    const prior = (await loadHostedCheck(ctx, { projectId: project._id, runId: id })).run;
    if (hostedCheckTerminal(prior))
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectHostedCulprit:startRedClassification'),
        { projectId: project._id, runId: state.audit.id },
      );
    return prior;
  }
  return insertHostedCheckRun(
    ctx,
    hostedCheckRunSchema.parse({
      schema: 1,
      id,
      projectId: project._id,
      actor: project.owner,
      at: prepared.operation.firstAttempt.at,
      request,
      gate,
      check: state.audit.check,
      configuration: state.audit.configuration,
      keyId: state.audit.keyId,
      ...(state.audit.checkLogs ? { checkLogs: state.audit.checkLogs } : {}),
      candidate: {
        digest: receipt.candidate.digest,
        base: receipt.previous,
        inputs: receipt.candidate.inputs,
        dependencies: receipt.candidate.dependencies,
        algorithm: receipt.candidate.algorithm,
      },
      dispatchKey: checkPin({ projectId: project._id, runId: id, operationId }),
      dispatchStarted: false,
      recoveryUsed: false,
      emptyLookups: [],
      executionId: null,
      fence: 0,
      lease: null,
      plan: null,
      planDigest: null,
      status: 'queued',
      cancelRequested: false,
      counts: { completed: 0, passed: 0, failed: 0 },
      terminalDigest: null,
      endedAt: null,
      exitCode: null,
      output: null,
      cost: { status: 'unknown' },
    }),
  );
}
/** Scheduled after a committed probe/reverse run; never imported by the check store. */
export async function onCulpritRunTerminal(ctx: MutationCtx, run: HostedCheckRun) {
  if (run.gate?.reason?.startsWith('culprit-revert:') && hostedCheckTerminal(run)) {
    if (run.status !== 'passed') {
      const project = await ctx.db.get(run.projectId as Id<'hostedProjects'>);
      if (!project) return;
      const row = await recoveryRow(
        ctx,
        { projectId: project._id, runId: run.gate.reason.slice(15) },
        project.owner,
      );
      if (row?.recovery) {
        const state: Recovery = JSON.parse(row.recovery);
        if (state.stage === 'landing') {
          const audit = await ctx.db
            .query('projectHostedMainAudits')
            .withIndex('by_project', q => q.eq('projectId', project._id))
            .unique();
          if (audit?.red?.runId !== state.audit.id) {
            state.stage = 'done';
            state.reason = 'The red audit was superseded; no automatic reverse was landed.';
            await retain(ctx, row, state);
          } else
            await fixForward(
              ctx,
              project,
              row,
              state,
              'The full-gated reverse did not pass; accepted source was not changed.',
            );
        }
      }
    }
    return;
  }
  if (run.gate?.mode !== 'probe' || !run.gate.reason?.startsWith('culprit:')) return;
  // The scheduler callback loads the committed terminal run.
  const projectId = run.projectId as Id<'hostedProjects'>,
    origin = run.gate.reason.slice(8);
  await classify(ctx, { projectId, runId: origin }, run);
  const current = await ctx.db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  // A content-identical pending probe can be shared by a newer red episode.
  // Its immutable original gate reason must not strand the newer waiter.
  if (current?.red && current.red.runId !== origin)
    await classify(ctx, { projectId, runId: current.red.runId }, run);
}
export const startRedClassification = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    await classify(ctx, input);
    return null;
  },
});
async function classify(ctx: MutationCtx, input: Identity, terminal?: HostedCheckRun) {
  const project = await ctx.db.get(input.projectId);
  if (!project || project.removal || project.sourceAuthority?.mode !== 'server') return;
  let row = await recoveryRow(ctx, input, project.owner);
  let state: Recovery;
  if (row?.recovery) state = JSON.parse(row.recovery);
  else {
    const auditRow = await ctx.db
      .query('projectHostedMainAudits')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .unique();
    if (!auditRow?.red || auditRow.red.runId !== input.runId || auditRow.audit?.runId !== input.runId) return;
    const { run: audit } = await loadHostedCheck(ctx, input);
    if (audit.status !== 'failed' || audit.gate?.mode !== 'audit' || !audit.endedAt || !audit.terminalDigest)
      return;
    await hostedWriteProject(ctx, input.projectId, project.owner, audit.request.authorityEpoch);
    const page = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_sequence', q =>
        q
          .eq('projectId', input.projectId)
          .gt('sequence', auditRow.lastGreen?.sequence ?? 0)
          .lte('sequence', auditRow.audit!.sequence),
      )
      .order('asc')
      .paginate({ cursor: null, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 512 * 1024 });
    const range = page.page.map(r => ({
      sequence: r.sequence,
      receipt: hostedAcceptanceSchema.parse(JSON.parse(r.value)),
    }));
    state = {
      audit,
      range,
      failed: culpritFailures(audit),
      low: 0,
      high: range.length,
      pass: auditRow.lastGreen ? { head: auditRow.lastGreen.head, runId: auditRow.lastGreen.runId } : null,
      fail: { head: audit.request.expectedHead, runId: audit.id },
      probe: null,
      stage: 'classify',
      reason: '',
    };
    await begin(ctx, project, recoveryOperation(input.runId), { kind: 'classify', runId: input.runId }, {});
    row = (await recoveryRow(ctx, input, project.owner))!;
    await retain(ctx, row, state);
    const continuous = range.every(
      (r, i) =>
        r.sequence === (auditRow.lastGreen?.sequence ?? 0) + i + 1 &&
        r.receipt.projectId === project._id &&
        r.receipt.candidate.head === (range[i + 1]?.receipt.previous.head ?? audit.request.expectedHead),
    );
    if (
      !page.isDone ||
      !range.length ||
      !state.pass ||
      !continuous ||
      range[0]!.receipt.previous.head !== state.pass.head ||
      !state.failed.length ||
      (audit.testFiles && audit.testFiles.counts.failed > state.failed.length)
    )
      return fixForward(
        ctx,
        project,
        row,
        state,
        'The failure or accepted range is incomplete; no single culprit is proven.',
      );
    const greenRow = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', state.pass!.runId))
      .unique();
    const green = greenRow ? hostedCheckRunSchema.parse(JSON.parse(greenRow.value)) : null;
    if (
      !green ||
      green.request.expectedHead !== state.pass.head ||
      green.check.definition !== audit.check.definition ||
      green.request.expectedConfiguration !== audit.request.expectedConfiguration ||
      green.request.expectedEnvironment !== audit.request.expectedEnvironment ||
      probeVerdict(
        green,
        state.failed.map(f => f.file),
      ) !== 'pass'
    )
      return fixForward(
        ctx,
        project,
        row,
        state,
        'The passing predecessor does not retain comparable test evidence.',
      );
    if (audit.configuration.provider !== 'github-actions')
      return fixForward(
        ctx,
        project,
        row,
        state,
        'Automatic probes require the configured free Actions runner.',
      );
    await probe(ctx, project, state, range.length, true);
    return retain(ctx, row, state);
  }
  if (state.stage !== 'classify') {
    if (state.uploads?.length) await wake(ctx, input);
    return;
  }
  await hostedWriteProject(ctx, input.projectId, project.owner, state.audit.request.authorityEpoch);
  const currentAudit = await ctx.db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', input.projectId))
    .unique();
  if (currentAudit?.red?.runId !== state.audit.id) {
    state.stage = 'done';
    state.reason = 'The red audit was superseded; no automatic reverse was landed.';
    return retain(ctx, row!, state);
  }
  const pending = state.probe;
  if (!pending) return;
  const run =
    terminal?.id === pending.id
      ? terminal
      : (await loadHostedCheck(ctx, { projectId: input.projectId, runId: pending.id })).run;
  if (!hostedCheckTerminal(run)) return;
  const verdict = probeVerdict(
    run,
    state.failed.map(f => f.file),
  );
  if (verdict === 'unclear')
    return fixForward(ctx, project, row!, state, 'Probe evidence is mixed, missing, static, or unavailable.');
  if (pending.flake && verdict === 'pass') {
    const auditRow = await ctx.db
      .query('projectHostedMainAudits')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .unique();
    await ctx.db.insert('projectHostedMainAuditEvents', {
      projectId: input.projectId,
      kind: 'flake',
      at: run.endedAt!,
      head: state.audit.request.expectedHead,
      runId: state.audit.id,
      sequence: state.range.at(-1)!.sequence,
    });
    // B2.3 consumes this proven-green probe, including debt/held-row bookkeeping.
    if (auditRow?.red?.runId === state.audit.id) {
      // A receipt range can include uncounted docs landings. B2.3 retains the
      // covered counted total in its audit reason and the newer work's clock.
      const covered = state.audit.gate?.reason?.startsWith('Main audit ')
        ? auditMetadata(state.audit).count
        : state.range.length; // Legacy audit runs predate the coverage metadata.
      const count = Math.max(0, (auditRow.unaudited?.count ?? covered) - covered);
      const firstAt = count ? (auditRow.unaudited?.firstAt ?? null) : null;
      const settings = count ? await auditSettings(ctx, input.projectId) : undefined;
      if (!count && auditRow.wake) await ctx.scheduler.cancel(auditRow.wake.taskId);
      await ctx.db.patch(auditRow._id, {
        red: undefined,
        lastGreen: { sequence: state.range.at(-1)!.sequence, head: run.request.expectedHead, runId: run.id },
        unaudited: { count, firstAt },
        debt: count ? auditDebt(count, firstAt, settings) : false,
        ...(!count ? { wake: undefined } : {}),
      });
      if (count) await armAudit(ctx, auditRow, auditDue(count, firstAt, settings));
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectHostedMainAudit:releaseHeld'),
        { projectId: input.projectId },
      );
    }
    state.stage = 'done';
    state.reason =
      'The failed tests passed on the audited head; recorded a flake and cleared this red episode. No source was changed.';
    return retain(ctx, row!, state);
  }
  if (!pending.flake) {
    if (verdict === 'pass') {
      state.low = pending.index;
      state.pass = { head: run.request.expectedHead, runId: run.id };
    } else {
      state.high = pending.index;
      state.fail = { head: run.request.expectedHead, runId: run.id };
    }
  } else state.fail = { head: run.request.expectedHead, runId: run.id };
  const next = bisectStep(state.low, state.high);
  if (next !== null) {
    await probe(ctx, project, state, next, false);
    return retain(ctx, row!, state);
  }
  const boundary = state.range[state.high - 1]!.receipt;
  if (
    !state.pass ||
    state.pass.head === state.fail.head ||
    state.pass.head !== boundary.previous.head ||
    state.fail.head !== boundary.candidate.head
  )
    return fixForward(
      ctx,
      project,
      row!,
      state,
      'Probe evidence does not establish distinct passing and failing adjacent source States.',
    );
  state.target = state.range[state.high - 1]!.receipt;
  const auditRow = await ctx.db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', input.projectId))
    .unique();
  if (auditRow?.red?.runId !== state.audit.id) {
    state.stage = 'done';
    return retain(ctx, row!, state);
  }
  await ctx.db.patch(auditRow._id, { red: { ...auditRow.red, culprit: state.target.id } });
  await ctx.db.insert('projectHostedMainAuditEvents', {
    projectId: input.projectId,
    kind: 'culprit',
    at: run.endedAt!,
    head: state.target.candidate.head,
    runId: state.audit.id,
    sequence: state.range[state.high - 1]!.sequence,
    culprit: state.target.id,
  });
  state.reason = 'A single failing boundary was proven; reverse only this accepted change.';
  await prepareSystemRevert(ctx, project, row!, state);
}
async function prepareSystemRevert(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  row: Doc<'projectHostedOperations'>,
  state: Recovery,
) {
  const target = state.target!;
  const operationId = culpritId({ revert: state.audit.id });
  const intentId = culpritId({ revertIntent: state.audit.id });
  const request = {
    kind: 'revert' as const,
    operationId,
    authorityEpoch: project.sourceAuthority!.epoch,
    target: { kind: 'receipt' as const, receiptId: target.id },
    message: `${state.reason} ${report(state, target, 'needs-fix').summary}`,
  };
  const operation = await begin(ctx, project, operationId, request, {
    intent: intentId,
    lane: culpritId({ revertLane: operationId }),
    job: culpritId({ revertJob: operationId }),
    jobOperation: culpritId({ revertJobOperation: operationId }),
  });
  const prepared = await prepareHostedRevert(
    ctx,
    { projectId: project._id, actor: project.owner, operationId },
    request,
    operation.firstAttempt,
  );
  const reverseIntent = await readHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    kind: 'intent',
    key: intentId,
  });
  const reverse = hostedRecordSchema.options[0].parse(JSON.parse(reverseIntent!.value));
  await writeHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    authorityEpoch: request.authorityEpoch,
    expectedVersion: reverse.version,
    record: { ...reverse, version: reverse.version + 1, recoveryRunId: state.audit.id },
  });
  const sync: SyncState = {
    request,
    ownerInputs: true,
    work: prepared.work,
    intentId,
    base: prepared.base,
    lane: null,
    resolutionLaneId: operation.firstAttempt.ids.lane!,
    jobOperationId: operation.firstAttempt.ids.jobOperation!,
    status: 'ready',
  };
  await ctx.db.insert('projectHostedSyncs', {
    projectId: project._id,
    actor: project.owner,
    operationId,
    jobId: operation.firstAttempt.ids.job!,
    culpritRunId: state.audit.id,
    value: canonicalPayload(sync),
  });
  state.intentId = intentId;
  state.syncOperationId = operationId;
  state.stage = 'sync';
  const value = canonicalPayload(hostedSyncInput(sync, operation.firstAttempt.at));
  state.uploads = [{ value, pin: savePin(JSON.parse(value)) }];
  const original = await candidateIntent(ctx, project, target);
  if (original) await notice(ctx, project, original, report(state, target, 'needs-fix'));
  await retain(ctx, row, state);
  await wake(ctx, { projectId: project._id, runId: state.audit.id });
}
async function prepareSystemCompose(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  row: Doc<'projectHostedOperations'>,
  state: Recovery,
) {
  const sync = await loadSync(
    ctx,
    { projectId: project._id, actor: project.owner, operationId: state.syncOperationId! },
    false,
  );
  const outcome = sync.operation.terminal?.outcome;
  if (!outcome) return;
  if (outcome.status !== 'completed')
    return fixForward(ctx, project, row, state, 'The reverse source job failed.');
  const laneResult = outcome.result as { lane?: { laneId: string } };
  if (!laneResult.lane)
    return fixForward(ctx, project, row, state, 'The reverse source job has no clean saved Lane.');
  const laneRow = await readHostedRecord(ctx, {
    projectId: project._id,
    actor: project.owner,
    kind: 'lane',
    key: laneResult.lane.laneId,
  });
  const lane = hostedRecordSchema.options[1].parse(JSON.parse(laneRow!.value));
  if (lane.resolution?.status === 'pending')
    return fixForward(ctx, project, row, state, 'The reverse change requires conflict resolution.');
  const main = await hostedStartMain(ctx, project._id);
  const inputs = buildComposePages([
    {
      laneId: lane.id,
      head: lane.head,
      version: lane.version,
      sourceVersion: lane.sourceVersion,
      lifecycleVersion: lane.lifecycleVersion,
      state: await saveObject(ctx, project._id, { sha256: lane.head }),
    },
  ]);
  const dependencies = buildComposePages([]);
  const operationId = culpritId({ composeRevert: state.audit.id });
  const request = {
    operationId,
    intentId: state.intentId!,
    authorityEpoch: project.sourceAuthority!.epoch,
    expectedMain: { head: main.head, receiptId: main.receipt.id },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    message: report(state, state.target!, 'needs-fix').summary,
  };
  const operation = await begin(ctx, project, operationId, request, {
    candidate: culpritId({ revertCandidate: operationId }),
    job: culpritId({ composeJob: operationId }),
    jobOperation: culpritId({ composeJobOperation: operationId }),
  });
  const compose: ComposeState = {
    request,
    ownerInputs: true,
    main: await saveObject(ctx, project._id, { sha256: main.head }),
    inputs: { next: null, pages: 1, count: 1 },
    dependencies: { next: null, pages: 1, count: 0 },
    candidateId: operation.firstAttempt.ids.candidate!,
    jobOperationId: operation.firstAttempt.ids.jobOperation!,
    status: 'ready',
  };
  await ctx.db.insert('projectHostedComposes', {
    projectId: project._id,
    actor: project.owner,
    operationId,
    jobId: operation.firstAttempt.ids.job!,
    culpritRunId: state.audit.id,
    value: canonicalPayload(compose),
  });
  await ctx.db.insert('projectHostedComposeSelections', {
    projectId: project._id,
    actor: project.owner,
    operationId,
    kind: 'inputs',
    key: lane.id,
  });
  state.composeOperationId = operationId;
  state.stage = 'compose';
  state.uploads = [...inputs.pages, ...dependencies.pages].map(p => ({
    value: canonicalPayload(p.value),
    pin: p.pin,
  }));
  const value = canonicalPayload(hostedComposeInput(compose, operation.firstAttempt.at));
  state.uploads.push({ value, pin: savePin(JSON.parse(value)) });
  await retain(ctx, row, state);
  await wake(ctx, { projectId: project._id, runId: state.audit.id });
}
async function finishSystemRevert(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  row: Doc<'projectHostedOperations'>,
  state: Recovery,
) {
  const composed = await loadCompose(
    ctx,
    { projectId: project._id, actor: project.owner, operationId: state.composeOperationId! },
    false,
  );
  const outcome = composed.operation.terminal?.outcome;
  if (!outcome) return;
  if (outcome.status !== 'completed')
    return fixForward(ctx, project, row, state, 'The reverse composition failed.');
  const candidate = hostedRecordSchema.options[3].parse(outcome.result);
  if (candidate.result.status !== 'clean')
    return fixForward(ctx, project, row, state, 'The reverse change conflicts with later accepted work.');
  const main = await hostedStartMain(ctx, project._id);
  if (main.head !== candidate.base.head || main.receipt.id !== candidate.base.receiptId)
    return fixForward(
      ctx,
      project,
      row,
      state,
      'Main changed before the reverse finish; preserve its newer accepted work.',
    );
  const gate = { mode: 'full' as const, reason: `culprit-revert:${state.audit.id}` };
  const operationId = culpritId({ fullRevertCheck: state.audit.id });
  const request = {
    ...state.audit.request,
    operationId,
    gate,
    candidateId: candidate.id,
    expectedHead: candidate.result.head,
  };
  const prepared = await beginCheckOperation(ctx, {
    projectId: project._id,
    actor: project.owner,
    operationId,
    expected: {
      authorityEpoch: request.authorityEpoch,
      head: request.expectedHead,
      resourceId: request.candidateId,
    },
    payload: request,
  });
  const id = prepared.operation.firstAttempt.ids.run!;
  if (!prepared.replayed)
    await insertHostedCheckRun(
      ctx,
      hostedCheckRunSchema.parse({
        schema: 1,
        id,
        projectId: project._id,
        actor: project.owner,
        at: prepared.operation.firstAttempt.at,
        request,
        gate,
        candidate: {
          digest: checkPin(candidate),
          base: candidate.base,
          inputs: candidate.inputs,
          dependencies: candidate.dependencies,
          algorithm: candidate.algorithm,
        },
        check: state.audit.check,
        configuration: state.audit.configuration,
        keyId: state.audit.keyId,
        dispatchKey: checkPin({ projectId: project._id, runId: id, operationId }),
        dispatchStarted: false,
        recoveryUsed: false,
        emptyLookups: [],
        executionId: null,
        fence: 0,
        lease: null,
        plan: null,
        planDigest: null,
        status: 'queued',
        cancelRequested: false,
        counts: { completed: 0, passed: 0, failed: 0 },
        terminalDigest: null,
        endedAt: null,
        exitCode: null,
        output: null,
        cost: { status: 'unknown' },
      }),
    );
  const landingOperationId = culpritId({ landRevert: state.audit.id });
  await enqueueHostedLanding(
    ctx,
    { projectId: project._id },
    hostedLandingRequestSchema.parse({
      operationId: landingOperationId,
      authorityEpoch: project.sourceAuthority!.epoch,
      channel: 'main',
      expectedMain: candidate.base,
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      agent: true,
      revertOf: state.target!.id,
      check: { kind: 'run', runId: id },
      finish: { composeOperationId: state.composeOperationId, after: null },
    }),
    { id: project.owner, kind: 'agent' },
  );
  state.stage = 'landing';
  state.landingOperationId = landingOperationId;
  await retain(ctx, row, state);
}
/** Source job terminal callbacks schedule this finite continuation. */
export const advance = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    if (!project) return null;
    const row = await recoveryRow(ctx, input, project.owner);
    if (!row?.recovery) return null;
    const state: Recovery = JSON.parse(row.recovery);
    await hostedWriteProject(ctx, input.projectId, project.owner, state.audit.request.authorityEpoch);
    const audit = await ctx.db
      .query('projectHostedMainAudits')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .unique();
    if (state.stage !== 'done' && audit?.red?.runId !== state.audit.id) {
      if (state.stage === 'landing') {
        const landingOperation = state.landingOperationId
          ? await hostedOperationRow(ctx, input.projectId, project.owner, state.landingOperationId)
          : null;
        const terminal = landingOperation
          ? hostedOperationSchema.parse(JSON.parse(landingOperation.value)).terminal
          : null;
        // A completed publication is green before its receipt-notice callback runs.
        // Pending/unknown outcomes must reconcile through the original landing.
        if (terminal?.outcome.status !== 'failed') return null;
      }
      state.stage = 'done';
      state.reason = 'The red audit was superseded; no automatic reverse was landed.';
      delete state.uploads;
      await retain(ctx, row, state);
      return null;
    }
    if (state.stage === 'sync' && !state.uploads?.length) {
      try {
        await prepareSystemCompose(ctx, project, row, state);
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        await fixForward(ctx, project, row, state, `${error.code}: ${error.message}`);
      }
    } else if (state.stage === 'compose' && !state.uploads?.length) {
      // Landing mutations must abort atomically on an unexpected invariant failure.
      await finishSystemRevert(ctx, project, row, state);
    }
    return null;
  },
});
/** Reserve only small metadata objects; the drive action never loads a source tree. */
export const transfer = internalMutation({
  args: { ...identity, committed: v.optional(v.boolean()), token: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    invariant(project, 'NOT_FOUND', 'Recovery project is unavailable.');
    const row = await recoveryRow(ctx, input, project.owner);
    invariant(row?.recovery, 'NOT_FOUND', 'Recovery operation is unavailable.');
    const state: Recovery = JSON.parse(row.recovery);
    await hostedWriteProject(ctx, input.projectId, project.owner, state.audit.request.authorityEpoch);
    if (!state.uploads?.length) return '{}';
    const audit = await ctx.db
      .query('projectHostedMainAudits')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .unique();
    if (audit?.red?.runId !== state.audit.id) {
      state.stage = 'done';
      state.reason = 'The red audit was superseded; no automatic reverse was landed.';
      delete state.uploads;
      await retain(ctx, row, state);
      return '{}';
    }
    const token = checkPin(state.uploads);
    if (input.committed && input.token !== token) return '{}';
    for (const upload of state.uploads) {
      invariant(
        upload.pin.size <= 128 * 1024 && checkPin(JSON.parse(upload.value)) === upload.pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Recovery metadata differs.',
      );
      const object = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q =>
          q.eq('projectId', input.projectId).eq('digest', upload.pin.sha256),
        )
        .unique();
      const key = r2Key(input.projectId, upload.pin.sha256);
      if (!object)
        await ctx.db.insert('projectObjects', {
          projectId: input.projectId,
          digest: upload.pin.sha256,
          size: upload.pin.size,
          nonce: crypto.randomUUID(),
          removed: false,
          location: 'r2',
          r2Key: key,
          ...(input.committed ? { r2Committed: true } : {}),
        });
      else {
        invariant(
          !object.removed && object.size === upload.pin.size,
          'SOURCE_HASH_MISMATCH',
          'Recovery metadata binding differs.',
        );
        if (input.committed)
          await ctx.db.patch(object._id, { location: 'r2', r2Key: key, r2Committed: true });
      }
    }
    if (!input.committed) return canonicalPayload({ uploads: state.uploads, token });
    delete state.uploads;
    await retain(ctx, row, state);
    if (state.stage === 'sync') {
      const auth = { projectId: input.projectId, actor: project.owner, operationId: state.syncOperationId! };
      const sync = await loadSync(ctx, auth);
      const pin = savePin(hostedSyncInput(sync.state, sync.operation.firstAttempt.at));
      const payload = {
        jobKind: 'sync',
        input: pin,
        inputDigest: pin.sha256,
        ...sourceWorkerPlan(process.env),
      };
      const operationId = sync.state.jobOperationId,
        expected = sync.operation.expected;
      await enqueueSourceJob(ctx, {
        ...auth,
        request: {
          schema: 1,
          projectId: input.projectId,
          actor: project.owner,
          operationId,
          expected,
          payloadHash: hostedPayloadHash(payload, expected),
        },
        payload,
        firstAttempt: {
          projectId: input.projectId,
          operationId,
          id: sync.row.jobId,
          parentAttemptId: null,
          at: sync.operation.firstAttempt.at,
          expected,
          ids: { job: sync.row.jobId },
        },
      });
      await writeSyncState(ctx, sync.row._id, { ...sync.state, status: 'submitted' });
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'action'>(
          payload.provider === 'convex' ? 'projectConvexSource:dispatch' : 'projectModalSource:dispatch',
        ),
        { projectId: input.projectId, jobId: sync.row.jobId },
      );
    } else if (state.stage === 'compose')
      await submitHostedCompose(ctx, {
        projectId: input.projectId,
        actor: project.owner,
        operationId: state.composeOperationId!,
      });
    return '{}';
  },
});
export const drive = internalAction({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const raw: string = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedCulprit:transfer'),
      input,
    );
    const transfer = JSON.parse(raw) as {
      uploads?: { value: string; pin: { sha256: string; size: number } }[];
      token?: string;
    };
    const uploads = transfer.uploads;
    if (!uploads?.length) return null;
    for (const { value, pin } of uploads) {
      const key = r2Key(input.projectId, pin.sha256);
      const target = await presignPut(r2Config(), key, { digest: pin.sha256, size: pin.size });
      const response = await fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body: value,
        signal: AbortSignal.timeout(10000),
      });
      invariant(
        response.ok || response.status === 412,
        'R2_UPLOAD_FAILED',
        'Recovery metadata upload failed.',
      );
      invariant(
        await verifyArchiveUpload({ r2Key: key, digest: pin.sha256, size: pin.size }),
        'R2_OBJECT_MISSING',
        'Recovery metadata upload is unavailable.',
      );
    }
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedCulprit:transfer'), {
      ...input,
      committed: true,
      token: transfer.token!,
    });
    return null;
  },
});
/** Called from the existing receipt-completion transaction, never a status read. */
export async function onRecoveryAccepted(ctx: MutationCtx, receipt: HostedAcceptance) {
  const projectId = receipt.projectId as Id<'hostedProjects'>;
  const project = await ctx.db.get(projectId);
  if (!project?.needsFix) return;
  const candidate = await readHostedRecord(ctx, {
    projectId,
    actor: project.owner,
    kind: 'candidate',
    key: receipt.candidate.id,
  });
  if (!candidate) return;
  const intentId = hostedRecordSchema.options[3].parse(JSON.parse(candidate.value)).intentId;
  // A normal re-landing handles its own notice; a system reverse has another Intent.
  const own = await readHostedRecord(ctx, { projectId, actor: project.owner, kind: 'intent', key: intentId });
  const intent = own ? hostedRecordSchema.options[0].parse(JSON.parse(own.value)) : null;
  if (
    intent?.needsFix &&
    receipt.id !== intent.needsFix.receiptId &&
    receipt.snapshot.revision > (intent.needsFix.sequence ?? 0)
  ) {
    await clearNeedsFix(ctx, projectId, intentId);
    const { needsFix: handledNotice, ...rest } = intent;
    void handledNotice;
    await writeHostedRecord(ctx, {
      projectId,
      actor: project.owner,
      authorityEpoch: receipt.authorityEpoch,
      expectedVersion: intent.version,
      record: { ...rest, version: intent.version + 1 },
    });
  }
  if (!intent?.recoveryRunId) return;
  const row = await recoveryRow(ctx, { projectId, runId: intent.recoveryRunId }, project.owner);
  if (!row?.recovery) return;
  const state: Recovery = JSON.parse(row.recovery);
  if (state.stage === 'done' && state.intentId === intentId && state.target && intent.needsFix) {
    const original = await candidateIntent(ctx, project, state.target);
    if (original) {
      const originalRow = await readHostedRecord(ctx, {
        projectId,
        actor: project.owner,
        kind: 'intent',
        key: original,
      });
      const record = originalRow ? hostedRecordSchema.options[0].parse(JSON.parse(originalRow.value)) : null;
      if (record?.needsFix?.auditRunId === state.audit.id) {
        const { needsFix: resolvedNotice, ...rest } = record;
        void resolvedNotice;
        await clearNeedsFix(ctx, projectId, original);
        await writeHostedRecord(ctx, {
          projectId,
          actor: project.owner,
          authorityEpoch: receipt.authorityEpoch,
          expectedVersion: record.version,
          record: { ...rest, version: record.version + 1 },
        });
      }
    }
    return;
  }
  if (state.stage !== 'landing' || state.intentId !== intentId || !state.target) return;
  const original = await candidateIntent(ctx, project, state.target);
  if (original)
    await notice(ctx, project, original, {
      ...report(state, state.target, 'reverted', receipt.id),
      sequence: receipt.snapshot.revision,
    });
  state.undo = `nforge agent ROOT revert '${JSON.stringify({ target: { kind: 'receipt', receiptId: receipt.id } })}'`;
  state.reason = report(state, state.target, 'reverted', receipt.id).summary + ` Undo: ${state.undo}`;
  state.stage = 'done';
  await retain(ctx, row, state);
}
export { fixBrief, fixGate, needsFix } from '../src/culprit-bisect';

export const accepted = internalMutation({
  args: { projectId: v.id('hostedProjects'), receiptId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await acceptanceRow(ctx, input);
    invariant(row, 'NOT_FOUND', 'An actual accepted receipt is required.');
    await onRecoveryAccepted(ctx, hostedAcceptanceSchema.parse(JSON.parse(row.value)));
    return null;
  },
});

/** A flake has cleared this hold; continue in finite indexed windows, never poll. */
export const releaseHolds = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, input) => {
    const audit = await ctx.db
      .query('projectHostedMainAudits')
      .withIndex('by_project', q => q.eq('projectId', input.projectId))
      .unique();
    if (audit?.red) return null;
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectHostedMainAudit:releaseHeld'),
      input,
    );
    return null;
  },
});

/** B2.3 schedules this after the terminal run commits, avoiding a module cycle. */
export const terminal = internalMutation({
  args: identity,
  returns: v.null(),
  handler: async (ctx, input) => {
    const { run } = await loadHostedCheck(ctx, input);
    if (hostedCheckTerminal(run)) await onCulpritRunTerminal(ctx, run);
    return null;
  },
});
