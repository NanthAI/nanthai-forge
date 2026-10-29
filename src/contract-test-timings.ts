import { HostedOutputRedactor } from './hosted-output-redactor.js';
// SPDX-License-Identifier: Apache-2.0
import { semanticReportsSchema } from './intent-semantic-conflict.js';
import type { z } from 'zod';
/** Failure attribution survives incomplete files; only complete files supply timings. */
export class ContractTimingReader {
  constructor(
    private readonly redaction: { secrets: readonly string[]; paths: readonly string[] } = {
      secrets: [],
      paths: [],
    },
  ) {}
  private pending = '';
  private dropping = false;
  readonly reports: z.infer<typeof semanticReportsSchema> = {};
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
  report(report: {
    file?: unknown;
    complete?: unknown;
    durationMs?: unknown;
    results?: unknown;
    failed?: unknown;
    counts?: { failed?: number } | undefined;
    flaky?: unknown;
    firstError?: unknown;
    retry?: { durationMs?: unknown; firstError?: unknown; results?: { passed: boolean }[] } | undefined;
  }) {
    if (typeof report?.file !== 'string') return;
    const duration = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0;
    const measured = report.complete === true && duration(report.durationMs);
    if (measured) this.timings[report.file] = report.durationMs as number;
    const results =
      Array.isArray(report.results) && report.results.every(item => typeof item?.passed === 'boolean')
        ? report.results
        : undefined;
    const failed =
      report.failed === true ||
      report.complete === false ||
      !!report.counts?.failed ||
      !!results?.some(item => !item.passed);
    if (!failed && !(measured && (results?.length || report.counts))) return;
    const firstError = report.retry?.firstError ?? report.firstError ?? this.reports[report.file]?.firstError;
    this.reports[report.file] = {
      ...(measured ? { durationMs: report.durationMs as number } : {}),
      failed,
      ...(typeof firstError === 'string'
        ? {
            firstError: new HostedOutputRedactor(this.redaction)
              .write(Buffer.from(firstError), true)
              .subarray(0, 2048)
              .toString('utf8')
              .replace(/\uFFFD$/, ''),
          }
        : {}),
      ...(report.flaky === true && !failed ? { flaky: true } : {}),
      ...(report.retry && duration(report.retry.durationMs) && duration(report.durationMs)
        ? {
            attempts: [
              { durationMs: report.retry.durationMs, failed: true },
              { durationMs: report.durationMs, failed },
            ],
          }
        : {}),
    };
  }
  private line(line: string) {
    const clean = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim();
    const named = /^(?:# |\[test\] )?Failed test file:\s*(.+)$/.exec(clean);
    if (named && !this.reports[named[1]!]) this.reports[named[1]!] = { failed: true };
    if (!clean.startsWith('__FORGE_TESTS__')) return;
    try {
      this.report(JSON.parse(clean.slice('__FORGE_TESTS__'.length)));
    } catch {
      /* Malformed report is unknown timing. */
    }
  }
}
