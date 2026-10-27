// SPDX-License-Identifier: Apache-2.0
/** Reads the existing complete per-file machine reports. Truncated reports and
 * partial executions never supply a duration. No defaults or guessed times. */
export class ContractTimingReader {
  private pending = '';
  private dropping = false;
  readonly reports: Record<string, { durationMs: number; failed: boolean }> = {};
  readonly timings: Record<string, number> = {};
  accept(text: string) {
    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop()!;
    for (const line of lines) {
      if (!this.dropping && line.length <= 1024 * 1024) this.line(line);
      this.dropping = false;
    }
    if (this.pending.length > 1024 * 1024) {
      this.pending = '';
      this.dropping = true;
    }
  }
  report(report: { file?: unknown; complete?: unknown; durationMs?: unknown; results?: unknown }) {
    if (
      typeof report?.file === 'string' &&
      report.complete === true &&
      typeof report.durationMs === 'number' &&
      Number.isFinite(report.durationMs) &&
      report.durationMs > 0
    ) {
      this.timings[report.file] = report.durationMs;
      if (
        Array.isArray(report.results) &&
        report.results.length &&
        report.results.every(item => typeof item?.passed === 'boolean')
      )
        this.reports[report.file] = {
          durationMs: report.durationMs,
          failed: report.results.some(item => !item.passed),
        };
    }
  }
  private line(line: string) {
    const clean = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim();
    if (!clean.startsWith('__FORGE_TESTS__')) return;
    try {
      this.report(JSON.parse(clean.slice('__FORGE_TESTS__'.length)));
    } catch {
      /* Malformed report is unknown timing. */
    }
  }
}
