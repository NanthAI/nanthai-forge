// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Phase split of one hosted `sync` in the calling process (friction 710f9028): local clock
 * reads only, no I/O and no extra calls. Each step is "from the previous mark to this one":
 * `settle` finishes this client's unfinished save (`save`: resolve's own save and its wait),
 * `submit` pins and sends the request, `hostedWait` covers the server compose and the client's
 * wait for it, `apply` (or `conflict`) writes the result into the checkout or prepares the
 * conflict files, and `select` (resolve) picks the follow-up landing. A save (friction f15db544) uses
 * the same split: `settle` (an earlier unfinished save), `capture` (walk and hash the checkout),
 * `prepare` (object preparation, the save preparation and the changed-file uploads beside it),
 * `upload` (the save's metadata pages and the one object commit), `submit` (last page and job
 * submission), `hostedWait` and `apply` (the checkout marker). A step marked twice (a save repaired
 * once after WORK_STALE) adds up. After a sync, resolve, revert, compose or undo returns, the CLI
 * follows a changed lockfile: that refresh is `dependencies` (friction a1f01239: a relink waited
 * minutes on another process's install outside a 15.6 s split). */
export type SyncTiming = {
  totalMs: number;
  stepsMs: Record<string, number>;
  /** Where `hostedWait` went on the server, when the server reports it (friction 84c1497f). */
  server?: ServerSyncTiming;
  /** Resolve: its save's own split. */
  save?: SyncTiming;
  /** The whole command in this process, from dispatch to reply (friction a1f01239): with `totalMs`
   * it shows any time no step accounts for. Set on replies that carry a split. */
  wallMs?: number;
};
/** Numbers, plus `phase` (`from>to`) and `stop` (why the step ended) from current servers. */
type ServerStep = Record<string, number | string>;
/** `dispatchMs`: submit until the first step was scheduled. Each step: `waitMs` from its scheduling
 * (or fan-out join) to its handler start, including any runtime start (`bootMs` for the Node hand-off);
 * `runMs` its handler time, of which `readMs`/`writeMs`/`callMs` had R2 reads, R2 writes or Convex
 * calls in flight (the rest is merge work); `phase`, `stop` and the `states`/`pages`/`blobs` read counts
 * say what the step ran and why it ended (friction 09c0b7cd). `publishMs`: last commit until the result was published.
 * `watchMs`: the client's remaining hostedWait, from publication until it observed the result
 * (durations from two clocks, so approximate). */
export type ServerSyncTiming = {
  dispatchMs: number;
  steps: ServerStep[];
  publishMs: number;
  watchMs: number;
};
/** The server split from a sync progress observation's state, or undefined. Reads only fields. */
export function serverSyncTiming(progress: unknown, hostedWaitMs: number): ServerSyncTiming | undefined {
  const state =
    progress && typeof progress === 'object'
      ? (progress as { state?: { submittedAt?: unknown; serverTiming?: unknown } }).state
      : undefined;
  const t = state?.serverTiming as
    | { queuedAt?: number; steps?: ServerStep[]; doneAt?: number; publishedAt?: number }
    | undefined;
  const submittedAt = state?.submittedAt;
  if (
    !t ||
    typeof submittedAt !== 'number' ||
    typeof t.queuedAt !== 'number' ||
    typeof t.publishedAt !== 'number' ||
    !Array.isArray(t.steps)
  )
    return undefined;
  const ms = (value: number) => Math.max(0, Math.round(value));
  return {
    dispatchMs: ms(t.queuedAt - submittedAt),
    steps: t.steps.slice(0, 16),
    publishMs: ms(t.publishedAt - (t.doneAt ?? t.publishedAt)),
    watchMs: ms(hostedWaitMs - (t.publishedAt - submittedAt)),
  };
}

export type TimingStep =
  | 'settle'
  | 'save'
  | 'capture'
  | 'prepare'
  | 'upload'
  | 'submit'
  | 'hostedWait'
  | 'apply'
  | 'conflict'
  | 'select';
export type StepTimer = ReturnType<typeof syncTiming>;
export function syncTiming(now: () => number = () => performance.now()) {
  const start = now(),
    stepsMs: Record<string, number> = {};
  let previous = start,
    server: ServerSyncTiming | undefined,
    nested: SyncTiming | undefined;
  return {
    mark(step: TimingStep) {
      const at = now();
      stepsMs[step] = (stepsMs[step] ?? 0) + Math.max(0, Math.round(at - previous));
      previous = at;
    },
    /** The last hosted wait's server split, from its final progress observation. */
    server(progress: unknown) {
      server = serverSyncTiming(progress, stepsMs.hostedWait ?? 0);
    },
    /** A nested operation's own split (resolve's save). */
    nest(value: SyncTiming) {
      nested = value;
    },
    value(): SyncTiming {
      return {
        totalMs: Math.max(0, Math.round(previous - start)),
        stepsMs: { ...stepsMs },
        ...(server ? { server } : {}),
        ...(nested ? { save: nested } : {}),
      };
    },
  };
}

/** A source reply with the CLI's dependency refresh after it (`dependencies`, included in `totalMs`)
 * and the command's wall time since `dispatchedAt` (the same clock as `now`). A reply without a split names only a
 * refresh of a second or more, as `dependenciesMs`. Clock reads only. */
export function withDependencyTiming<T>(
  result: T,
  dependenciesMs: number,
  dispatchedAt: number,
  now: number,
): T {
  if (!result || typeof result !== 'object') return result;
  const timing = (result as { timing?: Partial<SyncTiming> }).timing;
  const ms = Math.max(0, Math.round(dependenciesMs));
  if (timing && typeof timing.totalMs === 'number' && timing.stepsMs && typeof timing.stepsMs === 'object') {
    const totalMs = timing.totalMs + ms;
    return {
      ...result,
      timing: {
        ...timing,
        totalMs,
        stepsMs: ms ? { ...timing.stepsMs, dependencies: ms } : timing.stepsMs,
        wallMs: Math.max(totalMs, Math.round(now - dispatchedAt)),
      },
    };
  }
  return ms >= 1000 ? { ...result, dependenciesMs: ms } : result;
}
/** Re-stamp a reply's `timing.wallMs` (only where a split already carries one) at its final
 * assembly, so reads after the operation (overlap and conflict advice) are inside it too. */
export function stampWallMs<T>(result: T, from: number, now: number): T {
  const timing = (result as { timing?: Partial<SyncTiming> } | null)?.timing;
  if (!timing || typeof timing.wallMs !== 'number' || typeof timing.totalMs !== 'number') return result;
  return {
    ...result,
    timing: { ...timing, wallMs: Math.max(timing.wallMs, timing.totalMs, Math.round(now - from)) },
  };
}
