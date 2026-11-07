// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
/** One bounded policy for R2 read-after-write lag on an object a source job
 * itself just stored or already committed (eb0491bb). Pure data plus one helper,
 * so every source I/O site shares it (pattern of hosted-github-retry.ts).
 *
 * Inside source steps only a 404/absent answer is retried here. Timeouts, resets
 * and 408/425/429/5xx are not: they stay SourceIoError and re-enter the scheduled
 * same-execution repair (hosted-source-retry.ts). `readR2Exact` is for actions
 * with no such repair and also retries those, within the same budget. Hash/size mismatch, 403 and malformed data are
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

const retryableStatus = (status: number) =>
  status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
const domain = (error: unknown) =>
  error instanceof ForgeError && !/^EXCHANGE_REQUEST_(FAILED|TIMEOUT)$/.test(error.code);

/** Exact read of a small committed object (a source job's result manifest or a
 * finish selection page) inside an action that has no scheduled same-execution
 * repair of its own. Without this one bound a single timeout, reset, 5xx or lag
 * 404 failed the action, so the operation stayed submitted until a watchdog or
 * client replay (eb0491bb, 4f60d57a). Uses the same `r2LagDelays` budget: at
 * most two extra tries, only on a network failure or 404/408/425/429/5xx, and
 * only before `consume` returns. `consume` owns the exact checks: its ForgeError
 * (a permanent status, wrong size, digest or pack interval) is never retried.
 * After the bound the last answer or failure stands unchanged. A healthy read is
 * one request. */
export async function readR2Exact<T>(
  request: () => Promise<Response>,
  consume: (response: Response) => Promise<T>,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= r2LagDelays.length;
    let response: Response | undefined;
    try {
      response = await request();
      if (last || !retryableStatus(response.status)) return await consume(response);
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      if (last || domain(error)) throw error;
      await response?.body?.cancel().catch(() => {});
    }
    await sleep(r2LagDelays[attempt]!);
  }
}
