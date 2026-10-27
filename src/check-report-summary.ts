// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';

/** File-level timing and failing names survive; passing test names and coverage traces do not. */
export function summarizeCheckLines(lines: Iterable<string>): string {
  const retained: string[] = [];
  let diagnostics = 0;
  for (const line of lines) {
    const clean = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim();
    if (clean.startsWith('__FORGE_COVERAGE__')) continue;
    if (clean.startsWith('__FORGE_TESTS__')) {
      try {
        retained.push('__FORGE_TESTS__' + JSON.stringify(summarizeTestReport(JSON.parse(clean.slice(15)))));
      } catch {
        retained.push('__FORGE_TESTS__{"complete":false}');
      }
    } else if (
      clean.startsWith('__FORGE_TEST_FAILURE__') ||
      /^# (?:tests|pass|fail|cancelled|skipped|todo) \d+$/.test(clean)
    ) {
      retained.push(clean);
    } else if (diagnostics < 4096 && !clean.startsWith('__FORGE_')) {
      const excerpt = line.slice(0, 4096 - diagnostics);
      diagnostics += excerpt.length + 1;
      if (excerpt) retained.push(excerpt);
    }
  }
  return retained.join('\n') + (retained.length ? '\n' : '');
}
export function summarizeTestReport(report: {
  file?: string;
  complete?: boolean;
  durationMs?: number;
  results?: { name: string; passed: boolean; durationMs?: number }[];
  counts?: { total: number; failed: number };
  evidence?: string;
}) {
  const results = report.results ?? [];
  return {
    file: report.file,
    complete: report.complete,
    durationMs: report.durationMs,
    counts: report.counts ?? {
      total: results.length,
      failed: results.filter(test => test.passed === false).length,
    },
    results: results.filter(test => test.passed === false).map(test => ({ name: test.name, passed: false })),
    evidence: report.evidence ?? digest(JSON.stringify(report)),
  };
}

export function summarizeExecutions(bytes: Buffer): Buffer {
  const executions = JSON.parse(bytes.toString('utf8'));
  for (const execution of executions)
    if (execution.tests)
      execution.tests = Object.fromEntries(
        Object.entries(execution.tests).map(([file, report]) => [
          file,
          summarizeTestReport(report as Parameters<typeof summarizeTestReport>[0]),
        ]),
      );
  return Buffer.from(JSON.stringify(executions));
}
