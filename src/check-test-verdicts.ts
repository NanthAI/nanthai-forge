// SPDX-License-Identifier: Apache-2.0
import type { CheckExecutionEvent } from './check-execution-event.js';
import type { TestVerdict as Verdict } from './check-flake-evidence.js';
/** Only complete, attributed reports may remove a failure from the landing gate. */
export function testExecutionVerdicts(
  result: Extract<CheckExecutionEvent, { kind: 'result' }>,
  groups: string[][],
) {
  const latest = new Map<number, NonNullable<typeof result.executions>[number]>();
  for (const execution of result.executions ?? [])
    if ((latest.get(execution.index)?.attempt ?? -1) < execution.attempt)
      latest.set(execution.index, execution);
  const verdicts = new Map<string, Verdict>();
  const failures: string[] = [];
  let unknownFailure =
    result.executions !== undefined &&
    Array.from({ length: groups.length + 1 }, (_, index) => index).some(index => !latest.has(index));
  const priorAttempts = (execution: NonNullable<typeof result.executions>[number]) =>
    (result.executions ?? []).filter(
      item => item.index === execution.index && item.attempt < execution.attempt,
    );
  const infrastructureOnly = (execution: NonNullable<typeof result.executions>[number]) =>
    (execution.exitCode === 137 || execution.infrastructure === 'sandbox-stopped') &&
    !Object.values(execution.tests ?? {}).some(report => report.results.some(test => !test.passed));
  const recoveredFailure = [...latest.values()].some(
    execution =>
      groups[execution.index] &&
      execution.exitCode === 0 &&
      priorAttempts(execution).some(
        previous =>
          previous.tests &&
          Object.values(previous.tests).some(report => report.results.some(test => !test.passed)),
      ),
  );
  for (const execution of latest.values()) {
    const files = groups[execution.index];
    if (!files) {
      if (execution.exitCode !== 0) unknownFailure = true;
      continue;
    }
    const previous = priorAttempts(execution);
    const recoveredInfrastructure = previous.length > 0 && previous.every(infrastructureOnly);
    let namedFailure = false;
    for (const file of files) {
      const report = execution.tests?.[file];
      if (!report?.complete || report.file !== file) {
        if (execution.exitCode !== 0 || previous.length > 0) unknownFailure = true;
        continue;
      }
      const fileRecovered =
        report.flaky === true &&
        !!report.retry &&
        !report.failed &&
        report.results.every(test => test.passed);
      if (report.retry && !report.retry.complete && !fileRecovered) unknownFailure = true;
      if (fileRecovered && !report.retry!.complete)
        verdicts.set(`${file} :: [file execution]`, {
          test: `${file} :: [file execution]`,
          verdict: 'flake',
          recovery: 'unchanged-source',
          evidenceRunId: execution.executionId,
          attempts: [
            { runId: execution.executionId, attempt: 0, passed: false },
            { runId: execution.executionId, attempt: 1, passed: true },
          ],
        });
      if (
        !fileRecovered &&
        report.retry?.results.some(old => !old.passed && !report.results.some(test => test.name === old.name))
      )
        unknownFailure = true;
      for (const test of report.results) {
        const identity = `${file} :: ${test.name}`;
        const failedBefore = previous.some(
          item =>
            item.exitCode !== 0 &&
            item.tests?.[file]?.complete &&
            item.tests[file]!.file === file &&
            item.tests[file]!.results.some(old => old.name === test.name && !old.passed),
        );
        const sameRunFailure =
          report.retry?.complete && report.retry.results.some(old => old.name === test.name && !old.passed);
        const verdict = !test.passed
          ? 'failed'
          : sameRunFailure
            ? 'flake'
            : failedBefore
              ? 'recovered'
              : 'passed';
        const old = verdicts.get(identity);
        // Infrastructure recovery does not advance quarantine clean-pass streaks.
        // Duplicate names are conservative: a failure wins over a pass.
        if (
          !(recoveredInfrastructure && execution.exitCode === 0 && test.passed) &&
          (!old || verdict === 'failed' || (old.verdict === 'passed' && verdict === 'recovered'))
        )
          verdicts.set(identity, {
            test: identity,
            verdict,
            ...(sameRunFailure
              ? {
                  recovery: 'unchanged-source' as const,
                  evidenceRunId: execution.executionId,
                  attempts: [
                    { runId: execution.executionId, attempt: 0, passed: false },
                    { runId: execution.executionId, attempt: 1, passed: test.passed },
                  ],
                }
              : {}),
          });
        if (verdict === 'failed' || verdict === 'recovered') failures.push(identity);
        if (!test.passed) namedFailure = true;
      }
    }
    if (execution.exitCode !== 0 && !namedFailure) unknownFailure = true;
    if (
      execution.exitCode === 0 &&
      previous.some(item => !infrastructureOnly(item) && item.exitCode !== 0) &&
      ![...verdicts.values()].some(
        item => item.verdict === 'recovered' && files.some(file => item.test.startsWith(`${file} :: `)),
      )
    )
      unknownFailure = true;
  }
  return {
    verdicts: [...verdicts.values()],
    failures: [...new Set(failures)],
    unknownFailure,
    recoveredFailure,
  };
}
