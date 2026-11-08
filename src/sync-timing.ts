// SPDX-License-Identifier: Apache-2.0
/** Phase split of one hosted `sync` in the calling process (friction 710f9028): local clock
 * reads only, no I/O and no extra calls. Each step is "from the previous mark to this one":
 * `settle` finishes this client's unfinished save (`save`: resolve's own save and its wait),
 * `submit` pins and sends the request, `hostedWait` covers the server compose and the client's
 * wait for it, `apply` (or `conflict`) writes the result into the checkout or prepares the
 * conflict files, and `select` (resolve) picks the follow-up landing. */
export type SyncTiming = { totalMs: number; stepsMs: Record<string, number> };

export function syncTiming(now: () => number = () => performance.now()) {
  const start = now(),
    stepsMs: Record<string, number> = {};
  let previous = start;
  return {
    mark(step: 'settle' | 'save' | 'submit' | 'hostedWait' | 'apply' | 'conflict' | 'select') {
      const at = now();
      stepsMs[step] = Math.max(0, Math.round(at - previous));
      previous = at;
    },
    value(): SyncTiming {
      return { totalMs: Math.max(0, Math.round(previous - start)), stepsMs: { ...stepsMs } };
    },
  };
}
