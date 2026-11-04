// SPDX-License-Identifier: Apache-2.0
import { rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { atStep, durabilityError } from './hosted-durability-errors.mjs';
import { readSnapshot } from './hosted-durability-compare.mjs';

export const indexRetryBackoff = [15_000, 45_000];
// Re-reading an immutable failed ZIP cannot recover. Export a fresh snapshot,
// before any R2 write, retaining the same enclosing backup operation identity.
export async function exportAndVerify(
  deployment,
  path,
  exporter,
  {
    databaseOnly = false,
    step = 'backup',
    read = readSnapshot,
    delay = setTimeout,
    now = () => new Date(),
    report = event => console.error(JSON.stringify(event)),
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    const observedAt = now().toISOString();
    await atStep(`${step}.export`, () => exporter(deployment, path, { databaseOnly }));
    try {
      const summary = await atStep(`${step}.validate`, () => read(path, { databaseOnly }));
      return { ...summary, observedAt };
    } catch (error) {
      error.attempts = attempt;
      const diagnostic = durabilityError(error);
      const transient =
        diagnostic.code === 'WORK_INDEX_UNAVAILABLE' &&
        ['generation-missing', 'generation-building', 'partition-missing'].includes(
          diagnostic.diagnostics?.reason,
        );
      if (!transient || attempt > indexRetryBackoff.length) throw error;
      const backoffMs = indexRetryBackoff[attempt - 1];
      report({ operation: 'durability-retry', error: diagnostic, attempt, maxAttempts: 3, backoffMs });
      await rm(path, { force: true });
      await delay(backoffMs);
    }
  }
}
