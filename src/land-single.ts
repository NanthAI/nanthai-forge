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
export async function landSingle(
  work: WorkService,
  entry: LandEntry,
  command: LandCommand,
  phase: (input: unknown) => Promise<{ result: unknown }>,
  save: () => void,
): Promise<Record<string, unknown>> {
  const store = work.store;
  entry.single ??= { attempt: 0, previous: currentChannelHead(store, command.channel) };
  const single = entry.single;
  const child = (phase: string) =>
    finishChild(entry.command.operationId, `single:${single.attempt}:${phase}`);
  if (!single.viewId) {
    save(); // Pin main and attempt before composing or checking.
    const view = await composeSavedMain(
      work,
      store.select('views', entry.viewId!)!,
      single.previous,
      child('compose'),
    );
    single.viewId = view.id;
    save();
  }
  const view = store.select('views', single.viewId)!;
  if (view.status !== 'clean') return { status: 'conflict', viewId: view.id };
  const runId = child('run');
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
  if (run.status !== 'passed')
    return {
      status: ['queued', 'preparing', 'running'].includes(run.status) ? 'waiting' : 'failed',
      runId,
      viewId: view.id,
      checkStatus: run.status,
    };
  try {
    const move = (
      await phase({
        action: 'accept-channel',
        operationId: child('accept'),
        viewId: view.id,
        expectedHead: view.head,
        channel: command.channel,
        expectedPrevious: single.previous,
      })
    ).result as ChannelMove;
    const lifecycle = await acceptedLifecycle(work, move, command.keepOpen);
    return { status: 'accepted', runId, viewId: view.id, acceptanceId: move.id, ...lifecycle };
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    if (error.code === 'REVIEW_REQUIRED') {
      await phase({ action: 'intent-status', intentId: view.intentId, status: 'ready' });
      return { status: 'review-needed', runId, viewId: view.id, message: error.message };
    }
    if (['CHANNEL_CHANGED', 'CHANNEL_DIVERGED', 'CONTRACT_RESYNC_REQUIRED'].includes(error.code)) {
      entry.single = { attempt: single.attempt + 1, previous: currentChannelHead(store, command.channel) };
      save();
      return { status: 'waiting', code: error.code, runId, viewId: view.id, message: error.message };
    }
    throw error;
  }
}
