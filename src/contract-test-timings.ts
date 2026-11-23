// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  /** Files whose every test skipped: reported as skipped with no timing, never pass evidence (Item 687d1eda). */
  readonly skipped = new Set<string>();
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
    counts?: { total?: number; failed?: number } | undefined;
    flaky?: unknown;
    skipped?: unknown;
    firstError?: unknown;
    retry?: { durationMs?: unknown; firstError?: unknown; results?: { passed: boolean }[] } | undefined;
  }) {
    if (typeof report?.file !== 'string') return;
    const duration = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0;
    const results =
      Array.isArray(report.results) && report.results.every(item => typeof item?.passed === 'boolean')
        ? report.results
        : undefined;
    const failed =
      report.failed === true ||
      report.complete === false ||
      !!report.counts?.failed ||
      !!results?.some(item => !item.passed);
    // A skip is not a pass (Item 687d1eda): a file that ran no test is kept as `attempts: []`
    // (src/intent-semantic-conflict.ts skippedReport), with no timing, so pools still see it reported
    // and no reader takes it as pass evidence. Older Candidates' markers lack the flag; tests counted
    // with no result line means every one skipped.
    if (
      !failed &&
      (report.skipped === true || (results && !results.length && (report.counts?.total ?? 0) > 0))
    ) {
      if (!this.storable(report.file, false)) return;
      this.skipped.add(report.file);
      this.reports[report.file] = { failed: false, attempts: [] };
      return;
    }
    const measured = report.complete === true && duration(report.durationMs);
    if (measured) this.timings[report.file] = report.durationMs as number;
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
/** Next step for a skipped browser test on a hosted runner, whose browser comes from the pinned cache. */
export const browserCacheNext = 'Next: restore the pinned Playwright browser cache.';
/** One log line naming files whose every test skipped, or null. `browser`: a skipped browser test while
 * the plan selected browser coverage, which fails the shard (a skip is not a pass, Item 687d1eda).
 * `next` names the cause and the step that fixes it on this executor. */
export function skippedReportsNote(
  reader: Pick<ContractTimingReader, 'skipped'>,
  browserSelected: boolean,
  isBrowserTest: (file: string) => boolean,
  next = browserCacheNext,
) {
  const files = reader.skipped.size;
  if (!files) return null;
  const all = [...reader.skipped].sort();
  const browser = browserSelected && all.some(isBrowserTest);
  const names = (browser ? all.filter(isBrowserTest) : all).slice(0, unstoredNames).map(n => n.slice(0, 200));
  return {
    browser,
    line:
      `Forge: ${files} test file${files === 1 ? '' : 's'} skipped every test ` +
      `(${names.map(name => JSON.stringify(name)).join(', ')}${files > names.length ? ', …' : ''}); ` +
      (browser
        ? `browser coverage was selected, so the check fails: a skipped browser test is not a pass. ${next}`
        : 'they are recorded as skipped, not as passes.'),
  };
}
/** A skip is not a pass (Item 687d1eda), shared by every executor: one note for files whose every test
 * skipped and, when browser coverage was selected, each skipped browser test becomes a named failing
 * file with its cause, so the failure names the file instead of reading as an unnamed test failure.
 * attempts: [] keeps it skipped, so it is never probe pass or fail evidence. `browser` means the shard
 * or run must fail. */
export function failSkippedBrowserTests(
  reader: Pick<ContractTimingReader, 'skipped' | 'reports'>,
  browserSelected: boolean,
  isBrowserTest: (file: string) => boolean,
  next = browserCacheNext,
) {
  const note = skippedReportsNote(reader, browserSelected, isBrowserTest, next);
  if (note?.browser)
    for (const file of reader.skipped)
      if (isBrowserTest(file))
        reader.reports[file] = {
          failed: true,
          attempts: [],
          firstError: `Every test skipped: browser coverage was selected but no browser ran. ${next}`.slice(
            0,
            2048,
          ),
        };
  return note;
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
