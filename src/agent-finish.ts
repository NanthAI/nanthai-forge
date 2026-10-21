// SPDX-License-Identifier: Apache-2.0
import { CheckQueue, cancelTickets } from './check-queue.js';
import { withWorkLockOptions } from './work-lock.js';
import { finishQueuedBatch } from './agent-finish-batch.js';
import { finishRetryProgress } from './agent-finish-progress.js';
import { withWorkProgress } from './work-progress.js';
import { retryWorkPhase } from './work-retry.js';
import { join } from 'node:path';
import { waitingDependencies, acceptedInputs } from './agent-dependencies.js';
import { ForgeError } from './errors.js';
import { NativeSource } from './native-source.js';
import { gitIsAncestor } from './work-git.js';
import { reusableFinish, adoptLaneFinish } from './agent-finish-reuse.js';
import { checkEnvironment } from './work-run.js';
import { readPolicy, acceptancePaths } from './work-autonomy.js';
import { reviewReason } from './autonomy-policy.js';
import { currentChannelHead } from './agent-defaults.js';
import { completeAccepted } from './agent-lifecycle.js';
import { acceptedLifecycle } from './agent-autonomy-lifecycle.js';
import { localActor, type WorkActor } from './work-actor.js';
import { viewReceipt, runReceipt, acceptanceReceipt } from './agent-receipts.js';
import { runReceiptWithFailure } from './agent-run-failure.js';
import {
  FinishJournal,
  finishAttempt,
  retainedFinishCommand,
  type FinishAttempt,
} from './agent-finish-journal.js';
import { withLandingSlot, withQueueSlot } from './landing-queue.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { WorkService } from './work.js';
import type { WorkView, WorkData } from './work-types.js';

type Fields = Record<string, unknown>;
type Response = { revision: number; result: unknown };
type Phases = {
  checkpoint: () => Promise<{ result: Fields }>;
  sync: (operationId: string, head: string, target: string) => Promise<{ result: Fields }>;
  phase: (command: unknown, keepOpen?: boolean, actor?: WorkActor) => Promise<Response>;
  wait: (operationId: string, waitMs?: number) => Promise<void>;
  review: (viewId: string, reason: string) => Promise<Response>;
};
/** Every exact-View check runs without a Lane, Work or Channel lock. Only
 * acceptance joins the landing queue; a CAS race starts a separately pinned attempt. */
export async function agentFinish(work: WorkService, command: FinishAction, phases: Phases) {
  const control = new CheckQueue(undefined, {
    identity: {
      control: true,
      operationId: command.operationId,
      root: work.store.root,
      laneId: command.laneId,
      phase: 'finish',
    },
  });
  const onSignal = () => {
    cancelTickets(command.operationId);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', onSignal);
  try {
    const response = await withQueueSlot(
      join(work.store.directory, 'finish-queue', command.operationId),
      () =>
        withWorkLockOptions({ cancelled: () => control.cancelled() }, async () => {
          const checkpoint = (await phases.checkpoint()).result,
            journal = new FinishJournal(work.store, command, checkpoint.head as string),
            runner = new FinishRunner(work, command, phases, checkpoint, journal, control);
          return runner.run();
        }),
      { phase: 'preparing finish', control, anchor: work.store.directory },
    );
    if ('value' in response) return response.value;
    throw new ForgeError(
      'WORK_BUSY',
      `Finish driver lock wait expired at queue position ${response.waiting.position}. Retry finish operation ${command.operationId} or increase lockWaitMs/FORGE_WORK_LOCK_WAIT_MS.`,
    );
  } catch (error) {
    if (error instanceof ForgeError && ['WORK_BUSY', 'WORK_STALE'].includes(error.code)) {
      const recovery = retainedFinishCommand(work.store, command.operationId)
        ? `Resume the retained finish with nforge agent ${JSON.stringify(work.store.root)} finish '${JSON.stringify({ operationId: command.operationId })}'.`
        : `Retry the original finish request with operationId ${command.operationId}.`;
      throw new ForgeError(error.code, `${error.message} ${recovery}`, error.retryAt);
    }
    throw error;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.off('SIGHUP', onSignal);
    control.release();
  }
}
class FinishRunner {
  private readonly store;
  constructor(
    private readonly work: WorkService,
    private readonly command: FinishAction,
    private readonly phases: Phases,
    private readonly checkpoint: Fields,
    private readonly journal: FinishJournal,
    private readonly control: CheckQueue,
  ) {
    this.store = work.store;
  }
  private source(attempt: FinishAttempt) {
    return {
      checkpoint: this.checkpoint,
      ...(attempt.sync ? { sync: attempt.sync } : {}),
      view: attempt.view ?? null,
      run: attempt.run ?? null,
      acceptance: null,
    };
  }
  private async receipt(fields: Fields) {
    const result = {
      operationId: this.command.operationId,
      terminal: true,
      complete: false,
      ...fields,
      attempts: structuredClone(this.journal.state.attempts),
      ...(this.journal.state.landing.length ? { landing: structuredClone(this.journal.state.landing) } : {}),
    };
    // Match the wire receipt on first use and replay, including omitted undefined fields.
    const canonical = JSON.parse(JSON.stringify(result)) as typeof result;
    if (canonical.terminal) {
      this.journal.state.result = canonical;
      this.journal.save();
    }
    return {
      revision: await this.observedRevision(),
      result: canonical,
    };
  }
  private observedRevision() {
    // Receipts only report metadata; avoid making durable replay wait for a writer.
    return retryWorkPhase(this.command.operationId, () => this.store.revision(), ['SOURCE_CHANGED']);
  }
  private stop(attempt: FinishAttempt, fields: Fields) {
    attempt.status = fields.status as string;
    this.journal.save();
    return this.receipt({ ...this.source(attempt), ...fields });
  }
  private async review(attempt: FinishAttempt, reason: string) {
    const waiting = await this.phases.review(attempt.view!.viewId as string, reason);
    return this.stop(attempt, {
      ...(waiting.result as Fields),
      ...(reason.includes('re-check needed') ? { message: reason } : {}),
    });
  }
  private contains(head: string, previous: string) {
    return this.store.native
      ? new NativeSource(this.store.root).contains(head, previous)
      : gitIsAncestor(this.store.root, previous, head);
  }
  private async check(
    attempt: FinishAttempt,
  ): Promise<Awaited<ReturnType<FinishRunner['receipt']>> | undefined> {
    const { command, phases, store, journal } = this;
    if (this.control.cancelled()) return this.stop(attempt, { phase: 'check', status: 'cancelled' });
    if (attempt.view && attempt.run?.reused) return undefined;
    let head = attempt.head;
    // A prior checked candidate can enter the same short acceptance proof. No
    // check is reused until the acceptance owner revalidates it against main.
    if (
      attempt.number === 0 &&
      !attempt.view &&
      command.accept &&
      store.native &&
      readPolicy(store).acceptance.disjointFastPath &&
      (!attempt.previous || !this.contains(attempt.previous, head))
    ) {
      const reusable = reusableFinish(store, command, head);
      const candidate = reusable?.candidate,
        run = reusable?.run;
      if (candidate && run) {
        attempt.view = viewReceipt(candidate);
        attempt.run = { ...runReceipt(run), reused: true };
        attempt.operations.run = run.id;
        journal.save();
        return undefined;
      }
    }
    if (attempt.previous && !this.contains(head, attempt.previous)) {
      if (!attempt.sync && readPolicy(store).laneUpdates === 'ask')
        return this.stop(attempt, {
          phase: 'sync',
          status: 'sync-required',
          message: `${command.accept!.channel} moved; run sync, then finish again`,
        });
      attempt.sync ??= (await phases.sync(attempt.operations.sync, head, attempt.previous)).result;
      journal.save();
      if (attempt.sync.status === 'conflict')
        return this.stop(attempt, { phase: 'sync', status: 'conflict', conflicts: attempt.sync.conflicts });
      head = attempt.sync.head as string;
    }
    const lane = store.select('lanes', command.laneId, 'id', true)!;
    if (attempt.number === 0 && !attempt.view) {
      const adopted = adoptLaneFinish(store, command, head, attempt.previous);
      if (adopted) {
        attempt.view = viewReceipt(adopted.candidate);
        attempt.operations.run = adopted.run.id;
        journal.save();
      }
    }
    if (!attempt.view) {
      const view = (
        await phases.phase({
          action: 'compose',
          operationId: attempt.operations.compose,
          intentId: lane.intentId,
          inputs: [{ laneId: lane.id, head }, ...(command.withInputs ?? [])],
          dependencies: command.dependencies,
        })
      ).result as WorkView;
      attempt.view = viewReceipt(view);
      journal.save();
    }
    const view = attempt.view;
    if (view.status !== 'clean' || !view.head)
      return this.stop(attempt, { phase: 'compose', status: view.status });
    if (
      command.accept &&
      !store.select('channelMoves', attempt.operations.accept) &&
      !store.select('landingEntries', command.operationId) &&
      view.head === currentChannelHead(store, command.accept.channel) &&
      acceptedInputs(
        store,
        store.select('views', view.viewId as string)!.inputs,
        command.accept.channel,
        view.head as string,
      )
    ) {
      const completed =
        !command.keepOpen && readPolicy(store).lifecycle.completeOnAccept
          ? await completeAccepted(this.work, view.viewId as string)
          : undefined;
      return this.stop(attempt, {
        phase: 'accept',
        status: 'already-accepted',
        complete: true,
        ...(completed
          ? {
              completed,
              lifecycleAction: {
                summary: 'Completed already accepted input Lanes and Intent',
                undo: 'Run reopen with the Lane or Intent id; completion retains source and history.',
              },
            }
          : {}),
      });
    }
    const batched = await finishQueuedBatch(this.work, command, attempt);
    if (batched) {
      if (batched.status === 'awaiting-review')
        return this.review(attempt, 'Current autonomy policy requires review of this checked batch.');
      return this.stop(attempt, batched);
    }
    const original = store.select('runs', attempt.operations.run),
      environment =
        command.expectedEnvironment ?? original?.environment.fingerprint ?? checkEnvironment().fingerprint;
    this.control.update({ runId: attempt.operations.run, phase: 'check' });
    await withWorkProgress({ runId: attempt.operations.run, phase: 'queued for check' }, () =>
      phases.phase({
        action: 'run-check',
        operationId: attempt.operations.run,
        viewId: view.viewId,
        expectedHead: view.head,
        checkId: command.checkId,
        expectedDefinition: command.expectedDefinition,
        expectedEnvironment: environment,
        ...(attempt.interaction !== undefined ? { interaction: attempt.interaction } : {}),
      }),
    );
    await withWorkProgress({ runId: attempt.operations.run, phase: 'check' }, () =>
      phases.wait(attempt.operations.run, command.waitMs),
    );
    if (this.control.cancelled()) return this.stop(attempt, { phase: 'check', status: 'cancelled' });
    const run = store.select('runs', attempt.operations.run)!;
    attempt.run = runReceiptWithFailure(store, run);
    journal.save();
    if (run.status !== 'passed' || !command.accept)
      return this.stop(attempt, {
        phase: 'check',
        status: run.status,
        ...(['runner-unavailable', 'runner-budget-exhausted'].includes(run.status)
          ? { retryable: true, message: run.details }
          : {}),
        terminal: !['queued', 'preparing', 'running'].includes(run.status),
        complete: run.status === 'passed',
      });
    return undefined;
  }
  async run() {
    try {
      return await this.drive();
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'CANCELLED')
        return this.stop(this.journal.state.attempts.at(-1)!, { phase: 'check', status: 'cancelled' });
      if (!(error instanceof ForgeError && error.code === 'SOURCE_CHANGED')) throw error;
      // Keep the pinned attempt resumable; no failed observation can authorize landing.
      return this.receipt({
        ...this.source(this.journal.state.attempts.at(-1)!),
        terminal: false,
        phase: 'check',
        status: 'source-changed',
        code: error.code,
        message: `Source or Work changed during finish. Retry operation ${this.command.operationId} to reconcile its retained outcome.`,
      });
    }
  }
  private async drive() {
    const { journal, command } = this;
    if (journal.state.result)
      return { revision: await this.observedRevision(), result: journal.state.result };
    let attempt = journal.state.attempts.at(-1)!;
    const waiting = waitingDependencies(
      this.store,
      [command.laneId, ...(command.with ?? [])],
      command.accept?.channel,
    );
    if (waiting.length) {
      journal.state.dependencyWait = true;
      return this.stop(attempt, {
        terminal: false,
        phase: 'dependency',
        status: 'waiting-for-dependency',
        dependencies: waiting,
      });
    }
    if (attempt.status === 'waiting-for-dependency') {
      const previous = command.accept ? currentChannelHead(this.store, command.accept.channel) : null;
      if (attempt.view) {
        const prior = attempt;
        attempt = finishAttempt(
          command,
          attempt.number + 1,
          (attempt.sync?.head as string | undefined) ?? attempt.head,
          previous,
        );
        journal.state.attempts.push(attempt);
        finishRetryProgress(this.store, prior, attempt);
      } else {
        attempt.previous = previous;
        delete attempt.status;
      }
      journal.save();
    }
    // Every check is optimistic; acceptance alone holds a landing slot.
    if (attempt.number === 0 && attempt.status !== 'channel-changed') {
      const stopped = await this.check(attempt);
      if (stopped) return stopped;
    }
    for (;;) {
      if (this.control.cancelled()) return this.stop(attempt, { phase: 'accept', status: 'cancelled' });
      if (attempt.status === 'channel-changed') {
        // A new source selection cannot inherit a person's approval or bypass H6.
        const view = this.store.select('views', attempt.view!.viewId as string)!,
          reason = reviewReason(
            readPolicy(this.store),
            this.work.actor,
            acceptancePaths(this.store, view, attempt.previous),
          );
        if (reason)
          return this.review(
            attempt,
            `${command.accept!.channel} moved; re-check needed. Sync and check a new Candidate for a person to review.`,
          );
        if (attempt.number >= (command.maxRetries ?? 3))
          return this.stop(attempt, {
            phase: 'accept',
            status: 'retry-exhausted',
            code: attempt.error?.code ?? 'CHANNEL_CHANGED',
            message: `${command.accept!.channel} kept moving; landing retry budget exhausted. Start a new finish operation.${
              attempt.error?.code === 'CONTRACT_RESYNC_REQUIRED' ? ` ${attempt.error.message}` : ''
            }`,
          });
        const previous = currentChannelHead(this.store, command.accept!.channel),
          head = (attempt.sync?.head as string | undefined) ?? attempt.head;
        const checked = this.store.select('views', attempt.view!.viewId as string),
          reusedRunId = attempt.operations.run;
        const prior = attempt;
        attempt = finishAttempt(command, attempt.number + 1, head, previous);
        attempt.interaction = null;
        if (checked?.composedMain && checked.head && previous)
          attempt.interaction = {
            version: 1,
            reusedRunId,
            base: checked.composedMain,
            checkedHead: checked.head,
            main: previous,
          };
        journal.state.attempts.push(attempt);
        journal.save(); // Pin the target before sync, including a possible no-op.
        finishRetryProgress(this.store, prior, attempt);
      }
      if (attempt.number > 0) {
        const stopped = await this.check(attempt);
        if (stopped) return stopped;
      }
      try {
        this.control.update({ phase: 'landing' });
        const landed = await withWorkProgress({ runId: attempt.operations.run, phase: 'landing' }, () =>
          withLandingSlot(
            this.store,
            command.accept!.channel,
            async () => {
              if (this.control.cancelled())
                throw new ForgeError('CANCELLED', 'Finish cancelled before acceptance.');
              return this.phases.phase(
                {
                  action: 'accept-channel',
                  operationId: attempt.operations.accept,
                  viewId: attempt.view!.viewId,
                  expectedHead: attempt.view!.head,
                  ...command.accept,
                  ...(attempt.run?.reused ? { reuseRunId: attempt.operations.run } : {}),
                  expectedPrevious: attempt.previous,
                },
                command.keepOpen,
                localActor('agent', command.actor, command.tool),
              );
            },
            {
              waitMs: command.waitMs,
              observe: position => journal.position(position),
              control: this.control,
            },
          ),
        );
        if (!('value' in landed))
          return this.receipt({
            ...this.source(attempt),
            terminal: false,
            phase: 'accept',
            status: 'waiting to land',
            position: landed.waiting.position,
          });
        const accepted = landed.value;
        const move = accepted.result as WorkData['channelMoves'][number],
          lifecycle = await acceptedLifecycle(this.work, move, command.keepOpen);
        attempt.status = 'accepted';
        attempt.acceptance = { ...acceptanceReceipt(move), ...lifecycle };
        const run = this.store.select('runs', attempt.operations.run)!;
        attempt.run = runReceipt(run);
        return this.stop(attempt, {
          phase: 'accept',
          status: 'accepted',
          complete: true,
          acceptance: attempt.acceptance,
        });
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        if (error.code === 'REVIEW_REQUIRED') return this.review(attempt, error.message);
        // A contract resync takes the same sync, recheck and re-accept path as a moved Channel.
        if (error.code !== 'CHANNEL_CHANGED' && error.code !== 'CONTRACT_RESYNC_REQUIRED') throw error;
        attempt.status = 'channel-changed';
        attempt.error = { code: error.code, message: error.message };
        journal.save();
      }
    }
  }
}
