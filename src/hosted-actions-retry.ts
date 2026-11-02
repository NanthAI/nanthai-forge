import { withExchangeProgress } from './exchange-progress.js';
import { networkDeadline, networkFailure } from './network-fetch.js';
// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';

export const actionsInfrastructureAttempts = 3;
export const actionsInfrastructureDeadlineMs = 180_000;
class TransientActionsError extends Error {}

/** Only infrastructure IO belongs here. Callers must preserve immutable bodies,
 * run/fence pins, and create-only object keys across every replay. */
export async function retryActionsInfrastructure<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 60_000,
  deadlineMs = actionsInfrastructureDeadlineMs,
) {
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new ForgeError('RUNNER_UNAVAILABLE', 'Actions infrastructure deadline exceeded.');
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
      const delay = 1000 * 2 ** attempt;
      if (attempt + 1 >= actionsInfrastructureAttempts || Date.now() + delay >= deadline)
        throw new ForgeError(
          'RUNNER_UNAVAILABLE',
          'Actions infrastructure unavailable after bounded retries.',
        );
      console.log(
        `Actions infrastructure: retry ${attempt + 2}/${actionsInfrastructureAttempts} after ${delay / 1000}s.`,
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
    throw new TransientActionsError();
  }
  return response;
}
