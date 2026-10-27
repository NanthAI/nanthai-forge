// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { readSource } from './files.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

/** Retained shard pins identify failed files; missing/static/ambiguous evidence
 * keeps ordinary affected-test selection, never invents passing shard results. */
export function failedAuditTests(store: WorkStore, audit: CheckRun): string[] | undefined {
  try {
    const directory = join(store.directory, `check-${audit.id}`);
    const plan = JSON.parse(readSource(directory, 'modal-plan.json', 4 * 1024 * 1024)!.toString());
    const executions = JSON.parse(
      readSource(directory, 'modal-shard-logs.json', 4 * 1024 * 1024)!.toString(),
    ) as { index: number; attempt: number; exitCode?: number }[];
    if (
      plan.pin !== audit.backend?.pin ||
      plan.head !== audit.head ||
      plan.definition !== audit.check.definition ||
      !Array.isArray(plan.groups)
    )
      return;
    const latest = new Map<number, (typeof executions)[number]>();
    for (const execution of executions)
      if (execution.attempt >= (latest.get(execution.index)?.attempt ?? -1))
        latest.set(execution.index, execution);
    if (
      latest.get(plan.groups.length)?.exitCode !== 0 ||
      plan.groups.some((_: unknown, index: number) => latest.get(index)?.exitCode === undefined)
    )
      return;
    const tests = plan.groups.flatMap((group: string[], index: number) =>
      latest.get(index)!.exitCode === 0 ? [] : group,
    );
    if (
      tests.length &&
      tests.every(
        (test: unknown) => typeof test === 'string' && /^tests\/[A-Za-z0-9_.-]+\.test\.mjs$/.test(test),
      )
    )
      return [...new Set(tests)] as string[];
  } catch {
    /* Older/custom/local runs have no retained shard selection. */
  }
  return;
}
