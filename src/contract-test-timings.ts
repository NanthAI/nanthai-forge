// SPDX-License-Identifier: Apache-2.0
import { HostedOutputRedactor } from './hosted-output-redactor.js';
import { semanticReportsSchema } from './intent-semantic-conflict.js';
import { contractTestPath } from './intent-test-contract.js';
import type { z } from 'zod';
/** Names kept per reader for the log line about refused names; the counts stay exact. */
const unstoredNames = 3;
/** Failure attribution survives incomplete files; only complete files supply timings.
 * `reports` holds only names the result schema accepts as test paths: one odd name (a JUnit
 * report naming a source file, or none: `junit`) never makes a whole result invalid, which
 * Forge would refuse and the check would wrongly settle as runner-unavailable (Issue 7a0ccbef).
 * Refused names are counted in `unstored`; callers fail closed when one of them failed. */
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
  readonly unstored = { files: 0, failed: 0, names: [] as string[] };
  private readonly refused = new Map<string, boolean>();
  /** False (and counted) for a name the result schema refuses as a test path. */
  private storable(file: string, failed: boolean) {
    if (contractTestPath.safeParse(file).success) return true;
    const prior = this.refused.get(file);
    if (prior === undefined) {
      this.unstored.files++;
      if (this.unstored.names.length < unstoredNames) this.unstored.names.push(file.slice(0, 200));
    }
    if (failed && !prior) this.unstored.failed++;
    this.refused.set(file, prior || failed);
    return false;
  }
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
    if (!this.storable(report.file, failed)) return;
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
    if (named && !this.reports[named[1]!] && this.storable(named[1]!, true))
      this.reports[named[1]!] = { failed: true };
    if (!clean.startsWith('__FORGE_TESTS__')) return;
    try {
      this.report(JSON.parse(clean.slice('__FORGE_TESTS__'.length)));
    } catch {
      /* Malformed report is unknown timing. */
    }
  }
}
/** One log line for names a reader refused, or null; `failed` means the run must fail closed. */
export function unstoredReportsNote(...readers: Pick<ContractTimingReader, 'unstored'>[]) {
  const files = readers.reduce((sum, reader) => sum + reader.unstored.files, 0);
  if (!files) return null;
  const failed = readers.reduce((sum, reader) => sum + reader.unstored.failed, 0);
  const names = readers.flatMap(reader => reader.unstored.names).slice(0, unstoredNames);
  return {
    failed: failed > 0,
    line:
      `Forge: ${files} test report${files === 1 ? '' : 's'} named a file Forge cannot store as a test path ` +
      `(${names.map(name => JSON.stringify(name)).join(', ')}${files > names.length ? ', …' : ''}); ` +
      (failed
        ? `${failed} failed, so this run fails. Next: fix the failing test, or name test files in its reports.`
        : 'they passed and are not retained.'),
  };
}
