// SPDX-License-Identifier: Apache-2.0
/** Reading a check's JUnit report directory (`FORGE_JUNIT_DIR`) with bounded, streamed files. */
import { closeSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { JunitReader, junitLimits, type JunitFileReport } from './junit-report.js';

/** Reads one report file in 64 KiB chunks; null when it is oversized or malformed. */
export function readJunitFile(path: string, checkout?: string, maxBytes = junitLimits.fileBytes) {
  // A regular file only: never follow a link the check left in the report directory.
  if (!lstatSync(path).isFile()) return null;
  const descriptor = openSync(path, 'r');
  try {
    const reader = new JunitReader(checkout);
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!read) break;
      total += read;
      if (total > maxBytes) return null;
      reader.accept(decoder.write(chunk.subarray(0, read)));
    }
    reader.accept(decoder.end());
    return { reports: reader.finish(), bytes: total };
  } finally {
    closeSync(descriptor);
  }
}

/** Every `*.xml` report in the directory, merged per file. Notes say what was skipped. */
export function readJunitReports(directory: string, checkout?: string) {
  const notes: string[] = [];
  const merged = new Map<string, JunitFileReport>();
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter(name => name.endsWith('.xml'))
      .sort();
  } catch {
    return { reports: [], notes };
  }
  if (names.length > junitLimits.files) {
    notes.push(`JUnit: read the first ${junitLimits.files} of ${names.length} report files.`);
    names = names.slice(0, junitLimits.files);
  }
  let budget = junitLimits.totalBytes;
  for (const name of names) {
    let read: ReturnType<typeof readJunitFile>;
    try {
      read = readJunitFile(join(directory, name), checkout, Math.min(junitLimits.fileBytes, budget));
    } catch {
      read = null;
    }
    if (!read?.reports) {
      notes.push(`JUnit: ignored ${name} (malformed, empty or over the size limit).`);
      continue;
    }
    budget -= read.bytes;
    for (const report of read.reports) {
      const prior = merged.get(report.file);
      if (!prior) {
        merged.set(report.file, report);
        continue;
      }
      // One file reported twice (e.g. two tools): failures and durations add up.
      const failed = prior.counts.failed + report.counts.failed;
      const durationMs = (prior.durationMs ?? 0) + (report.durationMs ?? 0);
      const firstError = prior.counts.failed ? prior.firstError : (report.firstError ?? prior.firstError);
      merged.set(report.file, {
        file: report.file,
        complete: true,
        ...(durationMs ? { durationMs } : {}),
        counts: { total: prior.counts.total + report.counts.total, failed },
        results: [{ name: report.file, passed: !failed }],
        ...(!failed && (prior.flaky || report.flaky) ? { flaky: true as const } : {}),
        ...(firstError ? { firstError } : {}),
      });
    }
  }
  return { reports: [...merged.values()], notes };
}

/** A fresh private report directory for one job, and its cleanup. */
export function junitDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'forge-junit-'));
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Adds JUnit records for files the check's own Forge markers did not report. */
export function mergeJunitReports(
  reader: { reports: Record<string, unknown>; timings: Record<string, number>; report(report: object): void },
  reports: readonly JunitFileReport[],
) {
  let added = 0;
  for (const report of reports) {
    if (report.file in reader.reports || report.file in reader.timings) continue;
    reader.report(report);
    added++;
  }
  return added;
}
