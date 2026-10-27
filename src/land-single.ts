import { withLandingAttempt } from './landing-attempt-timing.js';
import { pendingActionsInfra, PENDING_ACTIONS_INFRA } from './github-actions-infra.js';
import { previewLanding, previewExclusionMessage } from './integration-preview-landing.js';
// SPDX-License-Identifier: Apache-2.0
import { finishChild } from './agent-finish-journal.js';
import { ForgeError } from './errors.js';
import { waitForAgentRun } from './agent-run-observer.js';
import { acceptedLifecycle } from './agent-autonomy-lifecycle.js';
import { currentChannelHead } from './agent-defaults.js';
import { composeSavedMain } from './land-compose.js';
import type { LandEntry } from './land-journal.js';
import type { LandCommand } from './land-schema.js';
import type { WorkService } from './work.js';
import type { ChannelMove } from './work-types.js';
/** Ineligible entries use ordinary exact-check/policy-bound acceptance. No Lane files are written. */
async function landSingleOnce(
  work: WorkService,
  entry: LandEntry,
  command: LandCommand,
  phase: (input: unknown) => Promise<{ result: unknown }>,
  save: () => void,
  options: { cancelled?: () => boolean; retry?: () => boolean; onRun?: (runId: string) => void } = {},
): Promise<Record<string, unknown>> {
  if (options.cancelled?.()) return { status: 'cancelled' };
  const store = work.store;
  entry.single ??= {
    attempt: 0,
    previous: currentChannelHead(store, command.channel),
    timing: { selectedAt: new Date().toISOString() },
  };
  const single = entry.single;
  const child = (phase: string) =>
    finishChild(entry.command.operationId, `single:${single.attempt}:${phase}`);
  if (!single.viewId) {
    if (single.timing) single.timing.composeStartedAt ??= new Date().toISOString();
    save(); // Pin main and attempt before composing or checking.
    const view = await composeSavedMain(
      work,
      store.select('views', entry.viewId!)!,
      single.previous,
      child('compose'),
    );
    single.viewId = view.id;
    if (single.timing) single.timing.composedAt ??= new Date().toISOString();
    save();
  }
  const view = store.select('views', single.viewId)!;
  if (view.status !== 'clean') return { status: 'conflict', viewId: view.id, conflict: view.details };
  const runId = child('run');
  options.onRun?.(runId);
  if (options.cancelled?.()) return { status: 'cancelled' };
  if (command.channel === 'main' && !store.select('runs', runId)) {
    const preview = previewLanding(store, view.inputs, {
      skip: command.preview === 'skip',
      ...(single.previous ? { base: single.previous } : {}),
    });
    if (preview?.excluded.length)
      return {
        status: 'preview-excluded',
        code: 'INTEGRATION_PREVIEW_EXCLUDED',
        message: previewExclusionMessage,
        preview,
      };
  }
  if (single.timing && !single.timing.checkReservedAt) {
    single.timing.checkReservedAt = new Date().toISOString();
    save();
  }
  await phase({
    action: 'run-check',
    operationId: runId,
    viewId: view.id,
    expectedHead: view.head,
    checkId: entry.command.checkId,
    expectedDefinition: entry.command.expectedDefinition,
    expectedEnvironment: entry.command.expectedEnvironment,
  });
  await waitForAgentRun(store, runId, command.waitMs);
  const run = store.select('runs', runId)!;
  if (pendingActionsInfra(run))
    return { status: 'waiting', code: PENDING_ACTIONS_INFRA, runId, viewId: view.id };
  if (run.status !== 'passed')
    return {
      status: ['queued', 'preparing', 'running'].includes(run.status) ? 'waiting' : 'failed',
      runId,
      viewId: view.id,
      checkStatus: run.status,
    };
  if (options.cancelled?.()) return { status: 'cancelled', runId, viewId: view.id };
  if (single.timing) {
    single.timing.settlementStartedAt ??= new Date().toISOString();
    save();
  }
  try {
    const move = (
      await phase({
        action: 'accept-channel',
        ...(entry.command.accept?.invariant ? { invariant: entry.command.accept.invariant } : {}),
        operationId: child('accept'),
        viewId: view.id,
        expectedHead: view.head,
        channel: command.channel,
        expectedPrevious: single.previous,
      })
    ).result as ChannelMove;
    if (single.timing) {
      single.timing.commitObservedAt ??= new Date().toISOString();
      save();
    }
    const lifecycle = await acceptedLifecycle(work, move, command.keepOpen);
    return { status: 'accepted', runId, viewId: view.id, acceptanceId: move.id, ...lifecycle };
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    if (error.code === 'REVIEW_REQUIRED') {
      await phase({ action: 'intent-status', intentId: view.intentId, status: 'ready' });
      return { status: 'review-needed', runId, viewId: view.id, message: error.message };
    }
    if (['CHANNEL_CHANGED', 'CHANNEL_DIVERGED', 'CONTRACT_RESYNC_REQUIRED'].includes(error.code)) {
      if (options.retry && !options.retry())
        return {
          status: 'retry-exhausted',
          code: error.code,
          runId,
          viewId: view.id,
          message: 'Finish retry budget exhausted; start a new finish operation to choose a new attempt.',
        };

      (entry.singleAttempts ??= []).push(single);
      entry.single = {
        attempt: single.attempt + 1,
        previous: currentChannelHead(store, command.channel),
        timing: { selectedAt: new Date().toISOString() },
      };
      save();
      return { status: 'waiting', code: error.code, runId, viewId: view.id, message: error.message };
    }
    throw error;
  }
}

export async function landSingle(...args: Parameters<typeof landSingleOnce>) {
  const [work, entry, command, , save] = args;
  entry.single ??= {
    attempt: 0,
    previous: currentChannelHead(work.store, command.channel),
    timing: { selectedAt: new Date().toISOString() },
  };
  const selected = entry.single;
  const result = await withLandingAttempt(
    work.store,
    finishChild(entry.command.operationId, `single:${selected.attempt}:attempt`),
    () => landSingleOnce(...args),
  );
  if (result.status !== 'waiting' && selected.timing) {
    selected.timing.settledAt ??= new Date().toISOString();
    save();
  }
  return result;
}
