// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { hostedCheckTerminal, type HostedCheckRun } from './hosted-check.js';
import { signMacHeartbeat } from './hosted-mac-lease.js';
import type { HostedCheckDispatch, HostedCheckProvider } from './hosted-check-controller.js';
import { invariant } from './errors.js';

/** The local provider starts only after hosted has recorded its live owner and
 * exact execution. Concurrent delivery shares the same in-process execution. */
export class HostedMacProvider implements HostedCheckProvider {
  readonly id = 'mac';
  private execution: Promise<void> | undefined;
  constructor(
    private readonly run: HostedCheckRun,
    private readonly execute: () => Promise<void>,
    private readonly signal: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {}
  async dispatch(input: HostedCheckDispatch) {
    const run = this.run;
    invariant(
      run.configuration.provider === this.id &&
        input.id === run.id &&
        input.fence === run.fence &&
        input.dispatchKey === run.dispatchKey &&
        input.planDigest === run.planDigest &&
        run.plan &&
        run.planDigest &&
        run.dispatchStarted &&
        run.executionId &&
        run.lease &&
        run.lease.until > this.now() &&
        !this.signal.aborted,
      'WORK_STALE',
      'Start only the exact Mac execution with a live owner.',
    );
    this.execution ??= this.execute();
    await this.execution;
    return { status: 'accepted' as const, executionId: run.executionId };
  }
  async lookup(input: HostedCheckDispatch): ReturnType<HostedCheckProvider['lookup']> {
    return this.execution && input.id === this.run.id && input.fence === this.run.fence
      ? { status: 'found', executionId: this.run.executionId! }
      : { status: 'unknown' };
  }
}
export interface MacWorkerServices {
  sessionId: string;
  key: string;
  work(update: (ids: string[]) => void, error: (error: Error) => void): () => void;
  watch(runId: string, update: (run: HostedCheckRun) => void, error: (error: Error) => void): () => void;
  control(
    runId: string,
    command: unknown,
  ): Promise<{ run: HostedCheckRun; acquired: boolean; dispatch: boolean }>;
  heartbeat(
    callback: {
      projectId: string;
      runId: string;
      eventId: string;
      owner: string;
      token: number;
      fence: number;
    },
    signature: string,
  ): Promise<HostedCheckRun>;
  execute(
    run: HostedCheckRun,
    signal: AbortSignal,
    control: (command: unknown) => Promise<HostedCheckRun>,
  ): Promise<void>;
  close(): Promise<void>;
}
/** Subscriptions wake this runner. There is no idle poll, renewal or retry timer.
 * Active lease renewal is sequential and a separate local deadline stops source
 * work/processes even if a heartbeat reply never arrives. */
export async function runHostedMacWorker(services: MacWorkerServices, signal: AbortSignal) {
  let pending: string[] = [],
    active: AbortController | undefined,
    task: Promise<void> | undefined;
  let closed = false,
    unsubscribe: (() => void) | undefined;
  let settle: () => void = () => {},
    fail: (error: unknown) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const stop = () => {
    closed = true;
    active?.abort();
    settle();
  };
  const error = (failure: Error) => {
    closed = true;
    active?.abort();
    fail(failure);
  };
  async function consume() {
    while (!closed && pending.length) {
      const id = pending.shift()!;
      const claim = await services.control(id, { kind: 'claim', owner: services.sessionId, leaseMs: 60_000 });
      if (closed) return;
      if (!claim.acquired || hostedCheckTerminal(claim.run)) continue;
      let run = claim.run;
      invariant(
        run.lease?.owner === services.sessionId,
        'WORK_STALE',
        'The claim selected another controller.',
      );
      const controller = new AbortController();
      active = controller;
      let deadline: ReturnType<typeof setTimeout> | undefined,
        renewal: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(deadline);
        deadline = setTimeout(() => controller.abort(), Math.max(0, run.lease!.until - Date.now()));
      };
      const heartbeat = async () => {
        try {
          const callback = {
            projectId: run.projectId,
            runId: run.id,
            eventId: randomUUID(),
            owner: services.sessionId,
            token: run.lease!.token,
            fence: run.fence,
          };
          const renewed = await services.heartbeat(callback, signMacHeartbeat(callback, services.key));
          if (controller.signal.aborted || closed) return;
          invariant(
            !hostedCheckTerminal(renewed) &&
              renewed.fence === run.fence &&
              renewed.lease?.token === run.lease!.token,
            'WORK_STALE',
            'The runner lease changed during renewal.',
          );
          run = renewed;
          arm();
          renewal = setTimeout(() => {
            void heartbeat();
          }, 20_000);
        } catch {
          controller.abort();
        }
      };
      arm();
      renewal = setTimeout(() => {
        void heartbeat();
      }, 20_000);
      let unwatch = () => {};
      try {
        unwatch = services.watch(
          id,
          next => {
            if (
              hostedCheckTerminal(next) ||
              next.cancelRequested ||
              next.fence !== run.fence ||
              next.lease?.owner !== services.sessionId
            )
              controller.abort();
          },
          error,
        );
        await services.execute(run, controller.signal, async command => {
          const next = await services.control(id, command);
          run = next.run;
          return run;
        });
      } finally {
        clearTimeout(deadline);
        clearTimeout(renewal);
        unwatch();
        active = undefined;
      }
    }
  }
  const pump = () => {
    if (task || closed) return;
    task = consume()
      .catch(error)
      .finally(() => {
        task = undefined;
        if (pending.length && !closed) pump();
      });
  };
  try {
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    if (!closed)
      unsubscribe = services.work(ids => {
        pending = [...new Set(ids)];
        pump();
      }, error);
    await done;
  } finally {
    closed = true;
    active?.abort();
    unsubscribe?.();
    signal.removeEventListener('abort', stop);
    await task;
    await services.close();
  }
}
