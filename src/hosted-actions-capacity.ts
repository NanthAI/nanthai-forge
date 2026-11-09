// SPDX-License-Identifier: Apache-2.0
/** Where the planning job leaves the `capacity` step's read of the runner's queue. */
export const actionsCapacityFile = 'forge-actions-capacity.json';

/** A capacity file written by the `capacity` step; anything unreadable means no observation. */
export function parseActionsCapacity(text: string | undefined) {
  try {
    const value = JSON.parse(text ?? 'null') as { activeChecks?: unknown; jobCap?: unknown } | null;
    return value &&
      Number.isSafeInteger(value.activeChecks) &&
      Number.isSafeInteger(value.jobCap) &&
      (value.activeChecks as number) >= 0 &&
      (value.jobCap as number) > 0
      ? { activeChecks: value.activeChecks as number, jobCap: value.jobCap as number }
      : undefined;
  } catch {
    return undefined;
  }
}
