// SPDX-License-Identifier: Apache-2.0
import { recoveryEdit } from './optimistic-recovery-edit.js';
export { recoveryEdit } from './optimistic-recovery-edit.js';
import { observeRecoveryRecords } from './post-accept-records.js';
import { failedAuditTests } from './optimistic-evidence.js';
import { optimisticLanding } from './autonomy-policy.js';
import { finishChild } from './agent-finish-journal.js';
import { NativeSource } from './native-source.js';
import { runWork, checkEnvironment } from './work-run.js';
import { waitForAgentRun } from './agent-run-observer.js';
import { retryWorkPhase } from './work-retry.js';
import { ForgeError, invariant } from './errors.js';
import { bisectLandings, reverseLandings } from './optimistic-bisect.js';
import type { WorkStore } from './work-store.js';
import type { ChannelMove, CheckRun, WorkData, WorkView } from './work-types.js';

export const recoveryAllowed = (data: WorkData) =>
  !!data.autonomyPolicy && optimisticLanding(data.autonomyPolicy);
export const recoveryResult = (data: WorkData, run: CheckRun) =>
  data.channelMoves.find(move => move.optimisticRecovery?.auditRunId === run.id)?.optimisticRecovery;

/** Reuse completed exact subset evidence, including after a worker restart.
 * Interrupted executions get distinct retained operation IDs. */
export async function recoveryCheck(store: WorkStore, audit: CheckRun, view: WorkView, observe?: () => void) {
  await recoveryEdit(
    store,
    data => {
      if (!data.views.some(item => item.id === view.id)) data.views.push(view);
    },
    [view.id],
  );
  const previous =
    store.readRecords()?.all('runs', view.id, 'viewId') ??
    store.load().runs.filter(run => run.viewId === view.id);
  let run = previous.at(-1);
  if (run && ['passed', 'failed'].includes(run.status)) {
    invariant(
      run.check.definition === audit.check.definition &&
        store.select('checks', audit.check.id)?.definition === audit.check.definition &&
        run.environment.fingerprint === checkEnvironment().fingerprint,
      'EVIDENCE_CHANGED',
      'Recovery evidence pins changed; preserve source for fix forward.',
    );
    return run;
  }
  const runId = run && !run.endedAt ? run.id : finishChild(view.id, `check:${previous.length}`);
  const check = store.select('checks', audit.check.id)!;
  invariant(
    check.definition === audit.check.definition,
    'EVIDENCE_CHANGED',
    'Recovery check definition changed; retain source for fix forward.',
  );
  runWork(
    store,
    {
      action: 'run-check',
      operationId: runId,
      viewId: view.id,
      expectedHead: view.head!,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: checkEnvironment().fingerprint,
    },
    store.revision(),
  );
  do {
    observe?.();
    await waitForAgentRun(store, runId, 1000, false);
  } while (['queued', 'preparing', 'running'].includes(store.select('runs', runId)!.status));
  run = store.select('runs', runId)!;
  return run;
}
function recoveryView(
  audit: CheckRun,
  head: string,
  base: string,
  key: string,
  phase: 'retry' | 'bisect' | 'revert',
): WorkView {
  return {
    id: finishChild(audit.id, key),
    intentId: '',
    base,
    composedMain: base,
    head,
    inputs: [],
    dependencies: [],
    status: 'clean',
    at: audit.startedAt,
    details: `Optimistic ${phase}; evidence from audit ${audit.id}.`,
    recovery: { auditRunId: audit.id, phase },
    ...(phase === 'retry' ? { mainCheck: audit.mainCheck! } : {}),
  };
}
async function settleRecovery(
  store: WorkStore,
  audit: CheckRun,
  status: 'flaky' | 'fix-forward' | 'reverted',
  culprits: ChannelMove[] = [],
  accepted?: ChannelMove,
) {
  await recoveryEdit(
    store,
    data => {
      const landing = data.channelMoves.find(
        move => move.head === audit.head && move.channel === audit.mainCheck!.channel,
      )!;
      if (landing.optimisticRecovery) return;
      landing.optimisticRecovery = {
        auditRunId: audit.id,
        status,
        culpritIds: culprits.map(move => move.id),
        ...(accepted ? { acceptanceId: accepted.id } : {}),
      };
      if (!accepted) return;
      accepted = data.channelMoves.find(move => move.id === accepted!.id)!;
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const undo = `nforge agent ${quote(store.root)} undo-revert ${quote(JSON.stringify({ acceptanceId: accepted.id, operationId: finishChild(accepted.id, 'undo') }))}`;
      accepted.automatic = {
        ...accepted.automatic!,
        summary: `Automatically reverted ${culprits.map(move => move.id).join(', ')} after audit ${audit.id}`,
        undo,
      };
      for (const culprit of culprits) {
        const view = data.views.find(view => view.id === culprit.viewId)!;
        for (const pin of view.inputs) {
          const lane = data.lanes.find(lane => lane.id === pin.laneId);
          if (!lane) continue;
          lane.state = 'active';
          const intent = data.intents.find(intent => intent.id === lane.intentId)!;
          intent.status = 'active';
          intent.notes.push({
            kind: 'decision',
            at: accepted.at,
            text: `Automatic compensating revert ${accepted.id} on ${accepted.channel}. Your Lane and edits are retained. Failing audit ${audit.id}: ${audit.failureSummary ?? audit.details}. ${undo}`,
          });
        }
      }
    },
    culprits.map(move => move.viewId),
    [...culprits.map(move => move.id), ...(accepted ? [accepted.id] : [])],
  );
}

/** Run under the post-accept worker slot, never a Work/landing lock during checks. */
export async function recoverOptimisticMain(store: WorkStore, audit: CheckRun, observe?: () => void) {
  let data = await observeRecoveryRecords(store, audit.mainCheck!.channel);
  if (!store.native || !recoveryAllowed(data) || recoveryResult(data, audit)) return;
  const moves = data.channelMoves.filter(
    move => move.status === 'accepted' && move.channel === audit.mainCheck!.channel,
  );
  const end = moves.findIndex(move => move.head === audit.head);
  if (end < 0) return;
  if (
    data.runs.some(
      run =>
        run.mainCheck?.channel === audit.mainCheck!.channel &&
        run.status === 'passed' &&
        run.startedAt > audit.startedAt &&
        moves.some((move, index) => index > end && move.head === run.head),
    )
  ) {
    await settleRecovery(store, audit, 'flaky');
    return;
  }
  const original = data.views.find(view => view.id === audit.viewId)!;
  const failedTests = failedAuditTests(store, audit);
  // Reconcile an acceptance whose reply/final bookkeeping was lost before doing more source work.
  const prior = moves.find(move =>
    data.views.some(
      view =>
        view.id === move.viewId && view.recovery?.auditRunId === audit.id && view.recovery.phase === 'revert',
    ),
  );
  let start = -1;
  for (let i = 0; i < end; i++)
    if (
      data.runs.some(
        run =>
          run.mainCheck?.channel === audit.mainCheck!.channel &&
          run.head === moves[i]!.head &&
          run.status === 'passed' &&
          (!run.recovery || run.recovery.phase === 'retry'),
      )
    )
      start = i;
  const window = moves
    .slice(start + 1, end + 1)
    .filter(move => move.postAccept && !data.views.find(view => view.id === move.viewId)?.recovery)
    .flatMap(move => {
      const batch = data.landingBatches?.find(batch => batch.acceptanceId === move.id);
      const prefix = batch?.prefixes.find(
        prefix => prefix.viewId === (move.fastPath?.checkedViewId ?? move.viewId),
      );
      if (!batch || !prefix) return [{ ...move, previous: move.previous ?? data.nativeHead ?? null }];
      return prefix.entryIds.map((entryId, index) => {
        const entry = data.landingEntries!.find(entry => entry.id === entryId)!;
        const cumulative = batch.prefixes.find(item => item.entryIds.at(-1) === entryId)!;
        const previous = index
          ? batch.prefixes.find(item => item.entryIds.at(-1) === prefix.entryIds[index - 1])!.head
          : batch.base;
        return { ...move, id: entry.id, viewId: entry.viewId, head: cumulative.head, previous };
      });
    });
  if (data.views.find(view => view.id === moves[end]!.viewId)?.recovery) {
    await settleRecovery(store, audit, 'fix-forward');
    return;
  }
  if (!window.length || window.some(move => !move.previous)) {
    await settleRecovery(store, audit, 'fix-forward');
    return;
  }
  const make = (head: string, base: string, key: string, phase: 'retry' | 'bisect' | 'revert') => ({
    ...recoveryView(audit, head, base, key, phase),
    intentId: original.intentId,
    ...(phase !== 'retry' && failedTests
      ? { recovery: { auditRunId: audit.id, phase, tests: failedTests } }
      : {}),
  });
  try {
    const retry = await recoveryCheck(store, audit, make(audit.head, audit.head, 'retry', 'retry'), observe);
    if (retry.status === 'passed') {
      await settleRecovery(store, audit, 'flaky');
      return;
    }
    if (retry.status !== 'failed') throw new ForgeError('CANCELLED', 'Main retry inconclusive.');
    const source = new NativeSource(store.root),
      base = window[0]!.previous!;
    const checkSubset = async (subset: ChannelMove[]) => {
      if (subset.length === window.length) return retry.status;
      const head = reverseLandings(
        source,
        audit.head,
        window.filter(move => !subset.includes(move)),
        audit.startedAt,
      );
      if (!head) throw new ForgeError('RECOVERY_CONFLICT', 'Subset composition conflicts; fix forward.');
      const key = `subset:${subset.map(move => move.id).join(':')}`;
      return (await recoveryCheck(store, audit, make(head, base, key, 'bisect'), observe)).status;
    };
    if (!prior && (await checkSubset([])) !== 'passed') {
      await settleRecovery(store, audit, 'fix-forward');
      return;
    }
    const culprits = await bisectLandings(window, checkSubset);
    if (!culprits.length) {
      await settleRecovery(store, audit, 'fix-forward');
      return;
    }
    if (prior) {
      await settleRecovery(store, audit, 'reverted', culprits, prior);
      return;
    }
    data = await observeRecoveryRecords(store, audit.mainCheck!.channel);
    const current = data.channelMoves
      .filter(move => move.status === 'accepted' && move.channel === audit.mainCheck!.channel)
      .at(-1)!;
    const head = reverseLandings(source, current.head, culprits, audit.startedAt);
    if (!head) {
      await settleRecovery(store, audit, 'fix-forward');
      return;
    }
    const view = make(head, current.head, `revert:${current.id}`, 'revert');
    const verified = await recoveryCheck(store, audit, view, observe);
    if (verified.status !== 'passed') {
      await settleRecovery(store, audit, 'fix-forward');
      return;
    }
    // Recheck live policy immediately before ordinary acceptance enforces paths, actor and exact evidence.
    if (!recoveryAllowed(store.readRecords()?.data() ?? store.load())) {
      await settleRecovery(store, audit, 'fix-forward');
      return;
    }
    const { WorkService } = await import('./work.js');
    const work = new WorkService(store.root, { kind: 'agent', id: 'optimistic-recovery' });
    const accepted = (
      await retryWorkPhase(audit.id, () =>
        work.dispatch(
          {
            action: 'accept-channel',
            operationId: finishChild(view.id, 'accept'),
            channel: current.channel,
            viewId: view.id,
            expectedHead: head,
            expectedPrevious: current.head,
          },
          store.revision(),
          { keepOpen: true },
        ),
      )
    ).result as ChannelMove;
    await settleRecovery(store, audit, 'reverted', culprits, accepted);
  } catch (error) {
    if (
      error instanceof ForgeError &&
      [
        'WORK_BUSY',
        'WORK_STALE',
        'CHANNEL_CHANGED',
        'CANCELLED',
        'SOURCE_CHANGED',
        'MAIN_AUDIT_STALLED',
      ].includes(error.code)
    )
      throw error;
    if (!(error instanceof ForgeError)) throw error;
    await settleRecovery(store, audit, 'fix-forward');
  }
}
