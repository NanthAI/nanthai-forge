// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { z } from 'zod';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedLandingDesiredSchema } from './hosted-landing-desired.js';
import { hostedLandingRequestSchema, type HostedLandingState } from './hosted-landing.js';
import { sourceWaitSnapshot } from './hosted-agent-source-wait.js';
import { hostedCheckRequestSchema } from './hosted-check.js';
import { hostedRecordSchema } from './hosted-records.js';
import { saveHostedLane } from './hosted-save-client.js';
import { composeAgentSource, selectAgentLane } from './hosted-agent-source.js';
import { recoverHostedCandidate } from './hosted-agent-resolution.js';
import { agentSourceOutcome, checkSelection } from './hosted-agent-actions.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';
import { shellQuote } from './agent-brief-render.js';
import { hostedAgentDirectory, readAgentJson } from './hosted-agent-journal.js';
import { finishRetryHint, type FinishContext } from './hosted-agent-finish-identity.js';
import { landWaitCommand } from './hosted-land-wait.js';
import type { HostedAgentResponse, HostedAgentSession } from './hosted-agent-transport.js';

type FinishCommand = z.infer<typeof hostedAgentCommandSchemas.finish>;

async function replayFinish(session: HostedAgentSession) {
  const composeOperationId =
    session.journal.get<string>('finish-compose-operation') ?? session.journal.get<string>('id:compose');
  const desired = session.journal.get('desired-landing');
  if (desired) {
    const submission = await session.mutation<HostedLandingState>('projectHostedLandingDesired:submit', {
      request: canonicalPayload(desired),
    });
    // Only a still-preparing submission needs source recovery. Terminal replay
    // remains discovery plus the original admission, without probing old jobs.
    let progress: unknown;
    if (submission.observation.state === 'pending' && submission.phase === 'composing') {
      const observed = await session.query<{ status?: string }>('projectHostedCompose:progress', {
        operationId: composeOperationId,
      });
      progress =
        observed.status === 'retryable'
          ? await session.mutation('projectHostedComposeJobs:submit', { operationId: composeOperationId })
          : observed.status
            ? sourceWaitSnapshot(observed)
            : undefined;
    }
    return {
      phase: 'finish',
      composeOperationId,
      ...(progress === undefined ? {} : { progress }),
      submission,
    };
  }
  const request = session.journal.get<Record<string, unknown>>('finish-request');
  if (!request) return null;
  if (!request.channel) {
    const run = await session.mutation('projectHostedChecks:enqueue', { request: canonicalPayload(request) });
    await session.journal.retain('finish-check-run', () => run);
    return { phase: 'check', composeOperationId, run };
  }
  const queuePosition = session.journal.get<{ queuePosition?: number | null }>(
    'finish-queue-advice',
  )?.queuePosition;
  const submission = await session.mutation<HostedLandingState>('projectHostedLanding:enqueue', {
    request: canonicalPayload(request),
  });
  return {
    phase: 'finish',
    composeOperationId,
    submission,
    ...(queuePosition === undefined ? {} : { queuePosition }),
    ...(await queuedConflict(session, submission)),
  };
}

/** A replay of a queued, not-yet-checked landing reports when main has since changed its files. */
export async function queuedConflict(session: HostedAgentSession, submission: HostedLandingState) {
  if (submission.phase !== 'queued') return {};
  try {
    const { wouldConflict } = await session.query<{ wouldConflict?: { next: string } }>(
      'projectHostedLanding:status',
      { submissionId: submission.id },
    );
    if (!wouldConflict) return {};
    const laneId = session.marker()?.selection.laneId;
    return {
      wouldConflict,
      next: 'sync-and-land',
      nextCommand: `nforge agent ${shellQuote(session.root)} land --save ${shellQuote(
        JSON.stringify(laneId ? { laneId } : {}),
      )}`,
    };
  } catch {
    return {}; /* Advisory read; the replay result stands. */
  }
}

async function reuseCheckedFinish(session: HostedAgentSession, command: FinishCommand) {
  const prior = session.journal.get<FinishContext>('finish-context')?.previous;
  if (!prior || prior.command.accept !== false || command.accept === false) return null;
  const journal = readAgentJson(join(hostedAgentDirectory(session.root), `${prior.operationId}.json`)) as {
    values: Record<string, unknown>;
  };
  const request = journal.values['finish-request'] as z.infer<typeof hostedCheckRequestSchema> | undefined;
  const run = journal.values['finish-check-run'] as { id: string } | undefined;
  const composeOperationId = journal.values['finish-compose-operation'] ?? journal.values['id:compose'];
  if (!request || !run || typeof composeOperationId !== 'string') return null;
  const checked = await session.query<{ status: string }>('projectHostedCheckRead:status', { runId: run.id });
  if (checked.status !== 'passed') return null;
  const current = await checkSelection(session, command.check);
  if (
    request.checkId !== current.checkId ||
    request.expectedDefinition !== current.expectedDefinition ||
    request.expectedConfiguration !== current.expectedConfiguration ||
    request.expectedEnvironment !== current.expectedEnvironment
  )
    return null;
  const candidate = hostedRecordSchema.options[3].parse(
    await session.query('projectHostedCompose:candidate', { candidateId: request.candidateId }),
  );
  const main = await session.main();
  if (candidate.base.head !== main.head || candidate.base.receiptId !== main.receipt.id) return null;
  return { candidateId: candidate.id, composeOperationId, check: { kind: 'run' as const, runId: run.id } };
}

export async function executeHostedFinish(session: HostedAgentSession, input: unknown) {
  const result = await executeFinishWork(session, input);
  const context = session.journal.get<FinishContext>('finish-context');
  const defaults = session.journal.get<Record<string, unknown>>('finish-defaults');
  const receipt = {
    ...(result as Record<string, unknown>),
    ...(defaults ? { defaults } : {}),
  };
  // One wake-driven command that resumes a long queue; absent once the outcome is final.
  const waitCommand = landWaitCommand(session.root, {
    operationId: session.journal.operationId,
    result: receipt,
  } as HostedAgentResponse);
  return finishRetryHint(session.root, hostedAgentCommandSchemas.finish.parse(context?.command ?? input), {
    ...receipt,
    ...(waitCommand ? { waitCommand } : {}),
  });
}

async function executeFinishWork(session: HostedAgentSession, input: unknown) {
  const operationId = session.journal.operationId,
    epoch = session.capabilities.authority.epoch;
  const context = session.journal.get<FinishContext>('finish-context');
  const command = hostedAgentCommandSchemas.finish.parse(context?.command ?? input);
  const replayed = await replayFinish(session);
  if (replayed) return replayed;
  const checked = await reuseCheckedFinish(session, command);
  if (checked) {
    command.candidateId = checked.candidateId;
    command.composeOperationId = checked.composeOperationId;
  }
  if (!command.after && !command.candidateId && !command.inputs)
    command.after = await session.journal.retain('stack-parent-entry', async () => {
      const selected = await selectAgentLane(session, command.laneId);
      return selected.stack && !selected.stack.detached ? (selected.stack.entryId ?? null) : null;
    });
  const marker = session.marker();
  if (
    !command.candidateId &&
    !command.inputs &&
    marker &&
    (!command.laneId || marker.selection.laneId === command.laneId)
  ) {
    const clean = context?.clean;
    if (!clean) {
      const saveOperationId = await session.journal.id('save');
      const saved = await saveHostedLane(
        session.root,
        { operationId: saveOperationId, message: command.message },
        session.exchange,
      );
      if (agentSourceOutcome(saved)?.status !== 'completed') {
        if (agentSourceOutcome(saved)?.status === 'failed')
          await session.journal.retain('finish-source-failed', () => true);
        return { phase: 'save', saveOperationId, progress: saved };
      }
    }
    const selection = clean ?? session.marker()!.selection;
    // Agent defaults (overlap gate, preflight) judge the saved head this finish will land.
    if (session.finishGates) {
      const advice = await session.finishGates(selection.laneId, selection.head);
      if (Object.keys(advice).length) await session.journal.retain('finish-defaults', () => advice);
    }
    command.inputs = [
      {
        laneId: selection.laneId,
        expected: {
          head: selection.head,
          version: selection.version,
          sourceVersion: selection.sourceVersion,
          lifecycleVersion: selection.lifecycleVersion,
        },
      },
    ];
  }
  const composeOperationId = command.composeOperationId ?? (await session.journal.id('compose'));
  await session.journal.retain('finish-compose-operation', () => composeOperationId);
  let candidateId = command.candidateId;
  if (!candidateId) {
    const progress = await composeAgentSource(
      session,
      hostedAgentCommandSchemas.compose.parse({
        ...(command.laneId ? { laneId: command.laneId } : {}),
        ...(command.intentId ? { intentId: command.intentId } : {}),
        ...(command.inputs ? { inputs: command.inputs } : {}),
        dependencies: command.dependencies,
        message: command.message,
      }),
      composeOperationId,
    );
    const completed = agentSourceOutcome(progress);
    if (completed?.status !== 'completed') {
      if (command.accept === false) {
        if (completed?.status === 'failed') await session.journal.retain('finish-source-failed', () => true);
        return { phase: 'compose', composeOperationId, progress };
      }
      const desired = await session.journal.retain('desired-landing', async () =>
        hostedLandingDesiredSchema.parse({
          governanceVersion: 1,
          operationId,
          authorityEpoch: epoch,
          composeOperationId,
          after: command.after,
          ...(command.priority ? { priority: command.priority } : {}),
          check: await checkSelection(session, command.check),
          ...(command.reason ? { retryReason: command.reason } : {}),
          ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
        }),
      );
      return {
        phase: 'finish',
        composeOperationId,
        progress,
        submission: await session.mutation('projectHostedLandingDesired:submit', {
          request: canonicalPayload({ ...desired, governanceVersion: 1 }),
        }),
      };
    }
    const candidate = hostedRecordSchema.options[3].parse(completed.result);
    if (candidate.result.status === 'conflict' && session.capabilities.actions.includes('resolve')) {
      await session.journal.retain('finish-source-failed', () => true);
      return {
        phase: 'conflict',
        candidateId: candidate.id,
        recovery: await recoverHostedCandidate(session, candidate.id),
      };
    }
    candidateId = candidate.id;
  } else
    invariant(
      command.composeOperationId,
      'BAD_ARGUMENT',
      'Existing Candidate finish requires its original composeOperationId.',
    );
  const request = await session.journal.retain('finish-request', async () => {
    const candidate = hostedRecordSchema.options[3].parse(
      await session.query('projectHostedCompose:candidate', { candidateId }),
    );
    if (command.accept === false) {
      invariant(candidate.result.status === 'clean', 'VIEW_CONFLICT', 'Check a clean hosted Candidate.');
      const check = await checkSelection(session, command.check);
      const { kind: _kind, ...selection } = check;
      void _kind;
      return hostedCheckRequestSchema.parse({
        operationId,
        authorityEpoch: epoch,
        candidateId,
        expectedHead: candidate.result.head,
        ...selection,
      });
    }
    return hostedLandingRequestSchema.parse({
      governanceVersion: 1,
      operationId,
      authorityEpoch: epoch,
      channel: 'main',
      expectedMain: candidate.base,
      candidateId,
      expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
      agent: true,
      ...(command.priority ? { priority: command.priority } : {}),
      check: checked?.check ?? (await checkSelection(session, command.check)),
      ...(command.reason ? { retryReason: command.reason } : {}),
      finish: { composeOperationId, after: command.after },
      ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
    });
  });
  if (command.accept === false) {
    const run = await session.mutation('projectHostedChecks:enqueue', { request: canonicalPayload(request) });
    await session.journal.retain('finish-check-run', () => run);
    return { phase: 'check', composeOperationId, run };
  }
  // Account JWTs still make agent requests. Person authority is never selected by CLI input.
  const result = await session.mutation('projectHostedLanding:enqueue', {
    request: canonicalPayload({ ...request, governanceVersion: 1 }),
  });
  let queueAheadSelection: unknown;
  let queuePosition: number | null | undefined;
  try {
    const read = await session.query<{ queueAheadSelection?: unknown; queuePosition?: number | null }>(
      'projectHostedLanding:status',
      { submissionId: (result as { id: string }).id },
    );
    queueAheadSelection = read.queueAheadSelection;
    queuePosition = read.queuePosition;
  } catch {
    /* Advisory reads never affect admission. */
  }
  const queueAdvice = await session.journal.retain<{ queuePosition?: number | null }>(
    'finish-queue-advice',
    () => (queuePosition === undefined ? {} : { queuePosition }),
  );
  return {
    phase: 'finish',
    composeOperationId,
    submission: result,
    ...(queueAdvice.queuePosition === undefined ? {} : { queuePosition: queueAdvice.queuePosition }),
    ...(queueAheadSelection ? { queueAheadSelection } : {}),
  };
}
