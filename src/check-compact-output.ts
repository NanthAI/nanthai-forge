// SPDX-License-Identifier: Apache-2.0
import {
  appendFileSync,
  constants,
  fstatSync,
  realpathSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { readSource } from './files.js';
import { invariant } from './errors.js';
import { summarizeCheckLines, summarizeExecutions } from './check-report-summary.js';
import { durableReplace } from './native-durability.js';

const coverageAtEnd = (text: string) =>
  text
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '')
    .trimStart()
    .startsWith('__FORGE_COVERAGE__');

/** Only structured test/coverage data and bounded diagnostic excerpts survive CI output. */
export function compactCheckText(text: string): string {
  const reports: string[] = [],
    diagnostics: string[] = [];
  let diagnosticSize = 0,
    failureLines = 0;
  for (const raw of text.split('\n')) {
    const original = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '');
    const line = original.trim();
    if (/^(?:ok |# Subtest:|\.\.\.)/.test(line)) failureLines = 0;
    if (/^not ok(?:\s|$)/.test(line)) failureLines = 13;
    const marker = /^(__FORGE_TESTS__|__FORGE_TEST_FAILURE__|__FORGE_COVERAGE__)(.*)$/.exec(line);
    if (marker) {
      try {
        const report = JSON.parse(marker[2]!);
        if (
          marker[1] === '__FORGE_COVERAGE__'
            ? typeof report.test !== 'string'
            : typeof report.file !== 'string'
        ) {
          reports.push(marker[1] + '{"complete":false}');
          continue;
        }
        const value =
          marker[1] === '__FORGE_TESTS__'
            ? {
                file: report.file,
                complete: report.complete,
                durationMs: report.durationMs,
                ...(report.retry ? { retry: report.retry } : {}),
                results: Array.isArray(report.results)
                  ? report.results.map((test: { name: string; passed: boolean; durationMs?: number }) => ({
                      name: test.name,
                      passed: test.passed,
                      ...(test.durationMs === undefined ? {} : { durationMs: test.durationMs }),
                    }))
                  : undefined,
              }
            : marker[1] === '__FORGE_TEST_FAILURE__'
              ? { file: report.file }
              : report;
        reports.push(marker[1] + JSON.stringify(value));
      } catch {
        reports.push(marker[1] + '{"complete":false}');
        // Preserve incompleteness so a TAP summary cannot manufacture passing evidence.
      }
    } else if (/^# (?:tests|pass|fail|cancelled|skipped|todo) \d+$/.test(line)) reports.push(line);
    else if (
      (failureLines-- > 0 ||
        /not ok|Error|FAIL|##\[error\]|Failed test file:|exit code 137|signal SIGKILL/i.test(line)) &&
      diagnosticSize < 4096
    ) {
      const excerpt = original.slice(-Math.max(0, 4096 - diagnosticSize));
      diagnosticSize += excerpt.length + 1;
      diagnostics.push(excerpt);
    }
  }
  return [...reports, ...diagnostics].join('\n') + (reports.length || diagnostics.length ? '\n' : '');
}
/** Streaming line framing: a report split across pipe chunks stays one report.
 * Incomplete or excessively long lines never establish complete evidence. */
export class CompactCheckWriter {
  private pending = '';
  private dropping = false;
  private diagnostics = 0;
  private failureLines = 0;
  private tail = '';
  constructor(private path: string) {
    try {
      this.tail = readFileSync(`${path}.tail`, 'utf8');
    } catch {
      /* First output. */
    }
    try {
      this.diagnostics = readFileSync(path, 'utf8')
        .split('\n')
        .filter(
          line =>
            !line.startsWith('__FORGE_') && !/^# (?:tests|pass|fail|cancelled|skipped|todo) \d+$/.test(line),
        )
        .join('\n').length;
    } catch {
      /* First output. */
    }
  }
  append(text: string) {
    this.tail = (this.tail + text).slice(-4096);
    durableReplace(`${this.path}.tail`, this.tail);
    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop()!;
    for (const line of lines) {
      if (this.dropping) {
        this.dropping = false;
        continue;
      }
      if (line.length > 1024 * 1024) continue;
      const clean = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '');
      if (/^\s*(?:ok |# Subtest:|\.\.\.)/.test(clean)) this.failureLines = 0;
      if (/^\s*not ok(?:\s|$)/.test(clean)) this.failureLines = 13;
      const compact = this.failureLines-- > 0 ? clean + '\n' : compactCheckText(line);
      if (!compact) continue;
      if (!compact.startsWith('__FORGE_') && !compact.startsWith('# ')) {
        const excerpt = compact.slice(0, Math.max(0, 4096 - this.diagnostics));
        this.diagnostics += excerpt.length;
        if (excerpt) appendFileSync(this.path, excerpt, { mode: 0o600 });
      } else appendFileSync(this.path, compact, { mode: 0o600 });
    }
    if (this.pending.length > 1024 * 1024) {
      this.pending = '';
      this.dropping = true;
    }
  }
  finish(failed: boolean) {
    if (
      this.pending &&
      !this.dropping &&
      (!this.pending.trimStart().startsWith('__FORGE_') || coverageAtEnd(this.pending))
    )
      this.append('\n');
    if (failed) this.retainFailureTail();
    rmSync(`${this.path}.tail`, { force: true });
  }
  retainFailureTail() {
    if (!this.diagnostics && this.tail) {
      const diagnostics = this.tail
        .split('\n')
        .filter(line => !line.trimStart().startsWith('__FORGE_'))
        .join('\n');
      if (diagnostics.trim()) appendFileSync(this.path, diagnostics, { mode: 0o600 });
      this.diagnostics = diagnostics.length;
    }
  }
}
export function checkEvidenceFiles(directory: string): string[] {
  const shards = join(directory, 'shards');
  if (!existsSync(shards)) return [join(directory, 'stdout.log'), join(directory, 'stderr.log')];
  const names = readdirSync(shards).filter(name => /\.(?:evidence|log)$/.test(name));
  return names
    .filter(name => !name.endsWith('.log') || !names.includes(name.replace(/\.log$/, '.evidence')))
    .sort(
      (a, b) =>
        Number(/\.attempt-(\d+)/.exec(a)?.[1] ?? 1) - Number(/\.attempt-(\d+)/.exec(b)?.[1] ?? 1) ||
        a.localeCompare(b),
    )
    .map(name => join(shards, name));
}
export function* checkEvidenceLines(directory: string, testsOnly = false): Generator<string> {
  const compact = join(directory, 'test-evidence.json');
  const retained = existsSync(compact) ? compact : join(directory, 'test-reports.json');
  if (existsSync(retained)) {
    const reports = JSON.parse(readFileSync(retained, 'utf8')) as { files: { name: string; text: string }[] };
    for (const report of reports.files)
      if (
        !testsOnly ||
        /(?:^|\/)\d+(?:\.attempt-\d+)?\.(?:evidence|log)$/.test(report.name) ||
        report.name === 'stdout.log'
      )
        yield* report.text.split('\n');
    return;
  }
  for (const path of checkEvidenceFiles(directory)) {
    if (!existsSync(path) || (testsOnly && /(?:^|\/)static\./.test(path))) continue;
    yield* boundedLines(path);
  }
}
/** Read-only projection for old owners: capture compact evidence without rewriting Work or source files. */
export function portableCheckEvidence(directory: string): Buffer | undefined {
  const read = (name: string) => {
    const bytes = readSource(directory, name, Number.MAX_SAFE_INTEGER);
    invariant(bytes, 'ARTIFACT_CHANGED', 'Check report bytes are not a contained regular file.');
    return bytes;
  };
  if (existsSync(join(directory, 'test-evidence.json'))) return read('test-evidence.json');
  const legacy = join(directory, 'test-reports.json');
  const inputs = existsSync(legacy)
    ? (JSON.parse(read('test-reports.json').toString('utf8')).files as { name: string; text: string }[])
    : checkEvidenceFiles(directory)
        .filter(existsSync)
        .map(path => {
          const name = path.slice(directory.length + 1);
          return { name, text: compactLines(boundedLines(path)) };
        });
  if (!inputs.length) return undefined;
  const files = inputs.map(file => ({ name: file.name, text: summarizeCheckLines(file.text.split('\n')) }));
  return Buffer.from(JSON.stringify({ schema: 1, files }));
}
export function retainCompactCheckReports(directory: string) {
  const compact = join(directory, 'test-evidence.json');
  const bytes = portableCheckEvidence(directory);
  if (bytes && !existsSync(compact)) durableReplace(compact, bytes);
}
/** Call after coverage, verdict and timing extraction. Retryable executions retain their input. */
export function discardFullCheckReports(directory: string) {
  retainCompactCheckReports(directory);
  rmSync(join(directory, 'test-reports.json'), { force: true });
  for (const path of checkEvidenceFiles(directory))
    if (path.endsWith('.evidence')) durableReplace(path, summarizeCheckLines(boundedLines(path)));
  const modal = join(directory, 'modal-shard-logs.json');
  if (existsSync(modal)) durableReplace(modal, summarizeExecutions(readFileSync(modal)));
}

/** Drain provider pipes without ever spooling full log bytes. */
export async function* compactProviderOutput(
  source: AsyncIterable<Uint8Array>,
  onSummary?: (summary: string) => void,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = '',
    dropping = false,
    diagnostics = 0,
    summary = '';
  const compact = (line: string) => {
    let text = summarizeCheckLines(compactCheckText(line).split('\n'));
    if (!text.startsWith('__FORGE_') && !text.startsWith('# ')) {
      text = text.slice(0, Math.max(0, 4096 - diagnostics));
      diagnostics += text.length;
    }
    if (text.startsWith('__FORGE_TESTS__')) {
      try {
        const report = JSON.parse(text.slice('__FORGE_TESTS__'.length));
        if (report.results?.some((test: { passed?: boolean }) => test.passed === false))
          summary += `Failed test file: ${report.file}\n`;
      } catch {
        /* Incomplete report. */
      }
    } else if (text && !text.startsWith('__FORGE_') && !text.startsWith('# ')) summary += text;
    summary = summary.slice(0, 4096);
    return text;
  };
  for await (const bytes of source) {
    const lines = (pending + decoder.decode(bytes, { stream: true })).split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      if (dropping) {
        dropping = false;
        continue;
      }
      if (line.length > 1024 * 1024) continue;
      const text = compact(line);
      if (text) yield Buffer.from(text);
    }
    if (pending.length > 1024 * 1024) {
      pending = '';
      dropping = true;
    }
  }
  pending += decoder.decode();
  if (
    pending &&
    !dropping &&
    pending.length <= 1024 * 1024 &&
    (!pending.trimStart().startsWith('__FORGE_') || coverageAtEnd(pending))
  ) {
    const text = compact(pending);
    if (text) yield Buffer.from(text);
  }
  onSummary?.(summary);
}

function* boundedLines(path: string) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)),
    buffer = Buffer.alloc(65536),
    decoder = new StringDecoder('utf8');
  let pending = '',
    dropping = false,
    size: number;
  try {
    const info = fstatSync(fd);
    invariant(
      info.isFile() && info.nlink === 1 && realpathSync(path) === path,
      'ARTIFACT_CHANGED',
      'Check evidence must be a contained regular file.',
    );
    while ((size = readSync(fd, buffer, 0, buffer.length, null))) {
      const lines = (pending + decoder.write(buffer.subarray(0, size))).split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        if (!dropping && line.length <= 1024 * 1024) yield line;
        dropping = false;
      }
      if (pending.length > 1024 * 1024) {
        pending = '';
        dropping = true;
      }
    }
    // Legacy coverage accepts a complete JSON record at EOF; timing reports require newline framing.
    pending += decoder.end();
    if (!dropping && pending.length <= 1024 * 1024 && coverageAtEnd(pending)) yield pending;
  } finally {
    closeSync(fd);
  }
}

export function compactFailureExcerpt(directory: string): string {
  try {
    return [...checkEvidenceLines(directory)]
      .filter(line => !line.startsWith('__FORGE_'))
      .join('\n')
      .slice(-4096);
  } catch {
    return '';
  }
}

function compactLines(lines: Iterable<string>) {
  const retained: string[] = [];
  let diagnostics = 0,
    following = 0;
  for (const line of lines) {
    if (/^\s*(?:ok |# Subtest:|\.\.\.)/.test(line)) following = 0;
    if (/^\s*not ok(?:\s|$)/.test(line)) following = 13;
    let compact = following-- > 0 ? line + '\n' : compactCheckText(line);
    if (
      !compact.startsWith('__FORGE_') &&
      !/^# (?:tests|pass|fail|cancelled|skipped|todo) \d+/.test(compact)
    ) {
      compact = compact.slice(0, Math.max(0, 4096 - diagnostics));
      diagnostics += compact.length;
    }
    if (compact) retained.push(compact);
  }
  return retained.join('');
}
