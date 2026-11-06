// SPDX-License-Identifier: Apache-2.0
/** One bounded policy for R2 read-after-write lag on an object a source job
 * itself just stored or already committed (eb0491bb). Pure data plus one helper,
 * so every source I/O site shares it (pattern of hosted-github-retry.ts).
 *
 * Only a 404/absent answer is retried here. Timeouts, resets and 408/425/429/5xx
 * are not: they stay SourceIoError and re-enter the scheduled same-execution
 * repair (hosted-source-retry.ts). Hash/size mismatch, 403 and malformed data are
 * never retried. A healthy read or write makes no extra call. */

/** In-action wait before each extra try; its length is the retry budget (two
 * extra tries per failed object, 2 s worst case, billed only on the fault path). */
export const r2LagDelays = [400, 1_600] as const;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Run `attempt`; while `lagged` says the answer is the not-yet-visible kind, wait
 * and try again, at most `r2LagDelays.length` more times. Returns the last answer
 * so the caller keeps its own exact terminal failure and cause. `discard` frees a
 * lagged answer (for example a response body) before the next try. */
export async function retryR2Lag<T>(
  attempt: () => Promise<T>,
  lagged: (value: T) => boolean,
  discard: (value: T) => unknown = () => undefined,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<T> {
  let value = await attempt();
  for (const delay of r2LagDelays) {
    if (!lagged(value)) return value;
    await discard(value);
    await sleep(delay);
    value = await attempt();
  }
  return value;
}
