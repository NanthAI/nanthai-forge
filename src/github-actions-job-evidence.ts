// SPDX-License-Identifier: Apache-2.0
export type ActionsJobLogEvidence = {
  status: 'passed' | 'failed' | 'incomplete';
  source: 'forge-test-markers' | 'node-test-summary' | 'job-log';
  passed?: number;
  failed?: number;
};

/** A green run can corroborate complete test output, never replace missing output. */
export function actionsJobLogEvidence(text: string, files: string[]): ActionsJobLogEvidence {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim());
  const failed = lines.some(line =>
    /^(?:not ok(?:\s|$)|# fail [1-9]\d*$|# Failed test file:|__FORGE_TEST_FAILURE__|##\[error\])/.test(line),
  );
  const markers = lines.filter(line => line.startsWith('__FORGE_TESTS__'));
  if (markers.length) {
    let passed = 0,
      failures = 0,
      complete = !lines.some(line => /^# cancelled [1-9]\d*$/.test(line));
    const seen = new Set<string>();
    for (const line of markers) {
      try {
        const report = JSON.parse(line.slice('__FORGE_TESTS__'.length));
        if (
          !files.includes(report.file) ||
          seen.has(report.file) ||
          report.complete !== true ||
          !Array.isArray(report.results)
        )
          complete = false;
        seen.add(report.file);
        for (const result of report.results ?? []) {
          if (typeof result?.name !== 'string' || typeof result.passed !== 'boolean') complete = false;
          if (result?.passed === true) passed++;
          if (result?.passed === false) failures++;
        }
      } catch {
        complete = false;
      }
    }
    return {
      source: 'forge-test-markers',
      status:
        failed || failures > 0 ? 'failed' : complete && seen.size === files.length ? 'passed' : 'incomplete',
      passed,
      failed: failures,
    };
  }
  const summaries: Record<string, number>[] = [];
  for (const line of lines) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'tests') summaries.push({});
    const summary = summaries.at(-1);
    if (summary) summary[match[1]!] = Number(match[2]);
  }
  const complete =
    summaries.length > 0 &&
    summaries.every(
      summary =>
        ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(key =>
          Number.isSafeInteger(summary[key]),
        ) &&
        summary.tests! > 0 &&
        summary.cancelled === 0 &&
        summary.tests ===
          summary.pass! + summary.fail! + summary.cancelled! + summary.skipped! + summary.todo!,
    );
  return {
    source: summaries.length ? 'node-test-summary' : 'job-log',
    status: failed ? 'failed' : complete ? 'passed' : 'incomplete',
    ...(summaries.length
      ? {
          passed: summaries.reduce((sum, summary) => sum + (summary.pass ?? 0), 0),
          failed: summaries.reduce((sum, summary) => sum + (summary.fail ?? 0), 0),
        }
      : {}),
  };
}
