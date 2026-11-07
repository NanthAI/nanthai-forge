// SPDX-License-Identifier: Apache-2.0
import { withExchangeProgress } from './exchange-progress.js';
import { networkDeadline, networkFailure } from './network-fetch.js';
import { ForgeError } from './errors.js';

export const actionsInfrastructureAttempts = 3;
export const actionsInfrastructureDeadlineMs = 180_000;
/** Issue 72d50375: a finished check's result must outlive a write outage. An
 * approved dev storage pause lasts at most 30 minutes; deliver for a little
 * longer. The request body is built once, so every retry is the same
 * run/fence/index/digest-deduplicated request, and the result stays in this
 * process until Forge accepts it. */
export const actionsDeliveryDeadlineMs = 35 * 60_000;
export const actionsDeliveryPolicy = {
  attempts: Number.POSITIVE_INFINITY,
  maxDelayMs: 60_000,
  label: 'Actions result delivery',
};
type RetryPolicy = { attempts: number; maxDelayMs: number; label: string };
const infrastructurePolicy: RetryPolicy = {
  attempts: actionsInfrastructureAttempts,
  maxDelayMs: Number.POSITIVE_INFINITY,
  label: 'Actions infrastructure',
};
class TransientActionsError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** Only infrastructure IO belongs here. Callers must preserve immutable bodies,
 * run/fence pins, and create-only object keys across every replay. */
export async function retryActionsInfrastructure<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 60_000,
  deadlineMs = actionsInfrastructureDeadlineMs,
  policy: RetryPolicy = infrastructurePolicy,
) {
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ForgeError('RUNNER_UNAVAILABLE', `${policy.label} deadline exceeded.`);
    try {
      return await networkDeadline(
        signal => withExchangeProgress({ signal, networkRetries: 0 }, () => operation(signal)),
        Math.min(timeoutMs, remaining),
      );
    } catch (error) {
      const name = (error as Error)?.name;
      const transient =
        error instanceof TransientActionsError ||
        networkFailure(error) ||
        name === 'TimeoutError' ||
        name === 'AbortError' ||
        name === 'TypeError' ||
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(
          String((error as { code?: unknown })?.code),
        );
      if (!transient) throw error;
      // A paused deployment names when writes return: wait for that once.
      const retryAfter = error instanceof TransientActionsError ? (error.retryAfterMs ?? 0) : 0;
      const delay = Math.max(Math.min(1000 * 2 ** attempt, policy.maxDelayMs), retryAfter);
      if (attempt + 1 >= policy.attempts || Date.now() + delay >= deadline)
        throw new ForgeError('RUNNER_UNAVAILABLE', `${policy.label} unavailable after bounded retries.`);
      const cause = error instanceof TransientActionsError ? ` (HTTP ${error.status})` : '';
      console.log(
        Number.isFinite(policy.attempts)
          ? `${policy.label}: retry ${attempt + 2}/${policy.attempts} after ${delay / 1000}s.`
          : `${policy.label}: Forge is not accepting it yet${cause}; retry ${attempt + 2} after ${Math.round(delay / 1000)}s, keeping it for ${Math.ceil((deadline - Date.now()) / 60_000)} more min.`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/** Bodies and signed URLs are never included in errors. Consume bodies inside
 * the retry operation so their network failures share its total deadline. */
export async function actionsInfrastructureResponse(response: Response) {
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    const seconds = Number(response.headers.get('retry-after'));
    // Bounded: a header can only stretch one wait, never the overall deadline.
    throw new TransientActionsError(
      response.status,
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30 * 60) * 1000 : null,
    );
  }
  return response;
}
