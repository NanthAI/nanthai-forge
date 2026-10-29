import { ContractTimingReader } from './contract-test-timings.js';
// SPDX-License-Identifier: Apache-2.0
import { checkEvidenceLines } from './check-compact-output.js';
import { testReports } from './check-test-report.js';
import { checkQuarantineResult } from './check-quarantine.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';
export function nativeQuarantine(
  store: WorkStore,
  run: CheckRun,
  path: string,
  exitCode: number | null,
  at: string,
) {
  if (JSON.stringify(run.check.args) !== JSON.stringify(['scripts/forge-check.mjs'])) return;
  const reports = testReports(checkEvidenceLines(path));
  if (!Object.keys(reports).length) return;
  let staticPassed = false;
  for (const line of checkEvidenceLines(path))
    if (line.trim() === '__FORGE_STATIC__{"passed":true}') staticPassed = true;
  const reader = new ContractTimingReader();
  for (const report of Object.values(reports)) reader.report(report);
  const assessment = checkQuarantineResult(
    store,
    run,
    {
      kind: 'result',
      pin: run.backend?.pin ?? '',
      head: run.head,
      definition: run.check.definition,
      exitCode: exitCode ?? 1,
      estimatedCostUsd: 0,
      executions: [
        { executionId: run.id, index: 0, attempt: 0, exitCode: exitCode ?? 1, tests: reports },
        { executionId: `${run.id}:static`, index: 1, attempt: 0, exitCode: staticPassed ? 0 : 1 },
      ],
    },
    [run.checkSelection?.tests ?? Object.keys(reports)],
    at,
  );
  return { ...assessment, fileReports: reader.reports };
}
