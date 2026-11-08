// SPDX-License-Identifier: Apache-2.0
/** Phase split of one hosted `sync` in the calling process (friction 710f9028): local clock
 * reads only, no I/O and no extra calls. Each step is "from the previous mark to this one":
 * `settle` finishes this client's unfinished save (`save`: resolve's own save and its wait),
 * `submit` pins and sends the request, `hostedWait` covers the server compose and the client's
 * wait for it, `apply` (or `conflict`) writes the result into the checkout or prepares the
 * conflict files, and `select` (resolve) picks the follow-up landing. */
export type SyncTiming = {
  totalMs: number;
  stepsMs: Record<string, number>;
  /** Where `hostedWait` went on the server, when the server reports it (friction 84c1497f). */
  server?: ServerSyncTiming;
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

export function syncTiming(now: () => number = () => performance.now()) {
  const start = now(),
    stepsMs: Record<string, number> = {};
  let previous = start,
    server: ServerSyncTiming | undefined;
  return {
    mark(step: 'settle' | 'save' | 'submit' | 'hostedWait' | 'apply' | 'conflict' | 'select') {
      const at = now();
      stepsMs[step] = Math.max(0, Math.round(at - previous));
      previous = at;
    },
    /** The last hosted wait's server split, from its final progress observation. */
    server(progress: unknown) {
      server = serverSyncTiming(progress, stepsMs.hostedWait ?? 0);
    },
    value(): SyncTiming {
      return {
        totalMs: Math.max(0, Math.round(previous - start)),
        stepsMs: { ...stepsMs },
        ...(server ? { server } : {}),
      };
    },
  };
}
