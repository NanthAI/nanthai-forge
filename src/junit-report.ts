// SPDX-License-Identifier: Apache-2.0
/** JUnit XML reports from any check command (vitest, jest-junit, pytest, Go, Maven,
 * Gradle, ...). The fixed runner gives the check a fresh, private directory in
 * `FORGE_JUNIT_DIR`; after the command exits it reads every `*.xml` file there into the
 * same per-file records Forge's own `__FORGE_TESTS__` markers produce (failed files,
 * first error, duration, tool-reported flakes). Reading never runs repository code.
 * Reports are bounded and parsed as a stream; a malformed, oversized or empty report is
 * ignored, which keeps the run's previous behaviour (exit code and log only). File
 * reading is in junit-report-files.ts. */
import { isAbsolute, relative } from 'node:path';

export const junitDirEnv = 'FORGE_JUNIT_DIR';
/** Per job: at most 32 report files, 8 MiB each, 16 MiB together, 5000 test files. */
export const junitLimits = { files: 32, fileBytes: 8 << 20, totalBytes: 16 << 20, testFiles: 5000 };
/** One unclosed tag or comment longer than this is malformed, not a reason to buffer more. */
const maxTokenChars = 1 << 20;
const errorChars = 2048;

export type JunitFileReport = {
  file: string;
  complete: true;
  durationMs?: number;
  counts: { total: number; failed: number };
  results: { name: string; passed: boolean }[];
  flaky?: true;
  firstError?: string;
};
type Attributes = Record<string, string>;
type Case = {
  attributes: Attributes;
  failed: boolean;
  skipped: boolean;
  flaky: boolean;
  error: string;
  errorFrom: 'failure' | 'retry' | null;
};
type FileTotals = { total: number; failed: number; seconds: number; flaky: boolean; firstError?: string };

const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return entities[name] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
const attributePattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
function attributes(text: string): Attributes {
  const found: Attributes = {};
  for (const match of text.matchAll(attributePattern)) found[match[1]!] = decode(match[3] ?? match[4] ?? '');
  return found;
}
const failureTags = new Set(['failure', 'error']);
/** Surefire/Gradle `flakyFailure`, `rerunFailure` and their `Error` forms: failed attempts of a test. */
const retryTags = new Set(['flakyFailure', 'flakyError', 'rerunFailure', 'rerunError']);
/** The registry's code extensions (src/ecosystems.ts), written out: this module ships self-contained in
 * the check payload (src/semantic-check-command.ts), so it imports nothing local. A test keeps it equal. */
export const JUNIT_CODE_FILE =
  /\.(?:[cm]?[jt]sx?|rs|go|py|rb|php|java|kts?|scala|cs|swift|exs?|dart|c|cc|cpp|h|hpp)$/i;
const code = JUNIT_CODE_FILE;
/** Python test modules named by dotted classname (pytest xunit2: `tests.test_api.TestUser`). */
const pythonModule = /^(?:test_\w+|\w+_test)$/;

/** The repository-relative file a test case belongs to, from the attributes reporters use. */
export function junitFile(testCase: Attributes, suite: Attributes, checkout?: string) {
  const pathLike = (value: string | undefined) =>
    value && (/[\\/]/.test(value) || code.test(value)) ? value : undefined;
  const dotted = (value: string | undefined) => {
    if (!value || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)) return undefined;
    const parts = value.split('.');
    const at = parts.findIndex(part => pythonModule.test(part));
    return at < 0 ? undefined : `${parts.slice(0, at + 1).join('/')}.py`;
  };
  const raw =
    testCase.file ||
    suite.file ||
    suite.filepath ||
    pathLike(testCase.classname) ||
    pathLike(suite.name) ||
    dotted(testCase.classname) ||
    testCase.classname ||
    suite.name ||
    'junit';
  let file = raw.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (isAbsolute(file) || /^[A-Za-z]:\//.test(file)) {
    const inside = checkout ? relative(checkout, file).replace(/\\/g, '/') : '';
    // A path outside the checkout keeps only its name: no machine paths in records.
    file = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : file.split('/').pop()!;
  }
  return file.slice(0, 1024) || 'junit';
}

/** Incremental JUnit XML reader: feed text chunks, then `finish`. Element nesting is
 * checked; DOCTYPE declarations (entity definitions) and oversized tokens are refused. */
export class JunitReader {
  private pending = '';
  private readonly stack: string[] = [];
  private readonly suites: Attributes[] = [];
  private current: Case | null = null;
  private capture = false;
  private broken = false;
  private cases = 0;
  readonly files = new Map<string, FileTotals>();
  constructor(private readonly checkout?: string) {}
  accept(text: string) {
    if (this.broken) return;
    this.pending += text;
    let at = 0;
    for (;;) {
      const open = this.pending.indexOf('<', at);
      if (open < 0) {
        this.text(this.pending.slice(at));
        at = this.pending.length;
        break;
      }
      this.text(this.pending.slice(at, open));
      const end = this.tokenEnd(open);
      if (end < 0) {
        at = open;
        break;
      }
      this.token(this.pending.slice(open, end));
      at = end;
      if (this.broken) return;
    }
    this.pending = this.pending.slice(at);
    if (this.pending.length > maxTokenChars) this.broken = true;
  }
  /** Per-file reports, or null when the report is malformed or names no test case. */
  finish(): JunitFileReport[] | null {
    if (this.broken || this.stack.length || this.pending.trim() || !this.cases) return null;
    return [...this.files].map(([file, totals]) => {
      const failed = totals.failed > 0;
      return {
        file,
        complete: true,
        ...(totals.seconds > 0 ? { durationMs: Math.max(1, Math.round(totals.seconds * 1000)) } : {}),
        counts: { total: totals.total, failed: totals.failed },
        results: [{ name: file, passed: !failed }],
        ...(totals.flaky && !failed ? { flaky: true as const } : {}),
        ...(totals.firstError ? { firstError: totals.firstError } : {}),
      };
    });
  }
  private tokenEnd(open: number) {
    const rest = (prefix: string, close: string) =>
      this.pending.startsWith(prefix, open)
        ? ((index: number) => (index < 0 ? -1 : index + close.length))(
            this.pending.indexOf(close, open + prefix.length),
          )
        : undefined;
    const special = rest('<!--', '-->') ?? rest('<![CDATA[', ']]>') ?? rest('<?', '?>');
    if (special !== undefined) return special;
    let quote = '';
    for (let index = open + 1; index < this.pending.length; index++) {
      const char = this.pending[index]!;
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') return index + 1;
    }
    return -1;
  }
  private text(text: string) {
    if (!this.capture || !this.current || !text) return;
    if (this.current.error.length < errorChars) this.current.error += decode(text);
  }
  private token(token: string) {
    if (token.startsWith('<!--') || token.startsWith('<?')) return;
    if (token.startsWith('<![CDATA[')) {
      if (this.capture && this.current && this.current.error.length < errorChars)
        this.current.error += token.slice(9, -3);
      return;
    }
    if (token.startsWith('<!')) {
      this.broken = true; // DOCTYPE or another declaration: never expand entities.
      return;
    }
    const closing = token.startsWith('</');
    const selfClosing = !closing && token.endsWith('/>');
    const body = token.slice(closing ? 2 : 1, selfClosing ? -2 : -1);
    const name = /^[^\s/>]+/.exec(body)?.[0];
    if (!name) {
      this.broken = true;
      return;
    }
    if (closing) {
      if (this.stack.pop() !== name) this.broken = true;
      else this.close(name);
      return;
    }
    this.open(name, attributes(body.slice(name.length)));
    if (selfClosing) this.close(name);
    else this.stack.push(name);
  }
  private open(name: string, found: Attributes) {
    if (name === 'testsuite') this.suites.push(found);
    else if (name === 'testcase')
      this.current = {
        attributes: found,
        failed: false,
        skipped: false,
        flaky: false,
        error: '',
        errorFrom: null,
      };
    else if (this.current && this.stack.at(-1) === 'testcase') {
      const failure = failureTags.has(name);
      if (failure || retryTags.has(name)) {
        if (failure) this.current.failed = true;
        else this.current.flaky = true;
        // The first final failure's text wins over a failed attempt's.
        const from = this.current.errorFrom;
        if (failure ? from !== 'failure' : from === null) {
          this.current.errorFrom = failure ? 'failure' : 'retry';
          this.capture = true;
          this.current.error = [found.type, found.message].filter(Boolean).join(': ');
          if (this.current.error) this.current.error += '\n';
        }
      } else if (name === 'skipped') this.current.skipped = true;
    }
  }
  private close(name: string) {
    if (name === 'testsuite') this.suites.pop();
    else if (failureTags.has(name) || retryTags.has(name)) this.capture = false;
    else if (name === 'testcase' && this.current) {
      this.cases++;
      const testCase = this.current;
      this.current = null;
      if (testCase.skipped && !testCase.failed) return;
      const file = junitFile(testCase.attributes, this.suites.at(-1) ?? {}, this.checkout);
      let totals = this.files.get(file);
      if (!totals) {
        if (this.files.size >= junitLimits.testFiles) return;
        totals = { total: 0, failed: 0, seconds: 0, flaky: false };
        this.files.set(file, totals);
      }
      totals.total++;
      const seconds = Number(testCase.attributes.time);
      if (Number.isFinite(seconds) && seconds > 0) totals.seconds += seconds;
      if (testCase.flaky) totals.flaky = true;
      const error = testCase.error.replace(/\s+$/, '');
      const named = `${testCase.attributes.name ?? 'test'}${error ? `: ${error}` : ''}`.slice(0, errorChars);
      if (testCase.failed) {
        if (!totals.failed++) totals.firstError = named;
      } else if (testCase.flaky && !totals.failed && !totals.firstError) totals.firstError = named;
    }
  }
}
