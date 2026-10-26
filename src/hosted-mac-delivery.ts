// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from 'node:timers/promises';

/** Retry the same retained payload after an unknown reply. Never reconstruct an
 * event, claim, output message or byte chunk between deliveries. */
export async function deliverMacCallback<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const failure = error as { code?: string; data?: { code?: string } };
      const code = failure.code ?? failure.data?.code;
      if (
        attempt >= 2 ||
        (code && !['R2_VERIFY_FAILED', 'R2_OBJECT_MISSING', 'RUNNER_UNAVAILABLE'].includes(code))
      )
        throw error;
      await delay(250 * (attempt + 1));
    }
  }
}
