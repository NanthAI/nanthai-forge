// SPDX-License-Identifier: Apache-2.0
/** Queue throughput after combined failures (51bbbd00, wave 1 2026-11-05).
 * Pure decisions shared by the landing controller, the landing-queue model map
 * and the synthetic queue harness. None of them grants publication authority:
 * every landing still needs its own exact passed proof on current main. */
import { codeFileName } from './code-files.js';

type SuspectState = {
  phase: string;
  batchDiagnostic?: { likelyCulprit: boolean } | undefined;
};

/** Retained evidence names this entry as the likely cause of a combined failure
 * and its own exact check has not passed yet. A suspect is never a speculative
 * base for later groups and never holds queue order against later entries. Its
 * own check still decides whether it lands; a pass clears suspicion. */
export function landingSuspect(state: SuspectState) {
  return (
    state.batchDiagnostic?.likelyCulprit === true &&
    (state.phase === 'composing' || state.phase === 'queued' || state.phase === 'checking')
  );
}

const codeFile = codeFileName;
/** The module a test names, in any folder and for common conventions: `x.test.ts`,
 * `x.spec.js`, `test_x.py`, `x_test.go`, `XTest.java`, `XTests.cs`,
 * `x_spec.rb`, or a dotted test class (`tests.test_x.TestY`, `com.acme.XTest`). */
export function testStem(file: string) {
  const name = file.split(/[\\/]/).pop() ?? '';
  const base = codeFile.exec(name)?.[1] ?? name;
  const stem = (part: string) =>
    /^(.+?)[._](?:test|spec)s?$/i.exec(part)?.[1] ??
    /^tests?_(.+)$/i.exec(part)?.[1] ??
    /^(.+?[a-z0-9])(?:Tests?|Spec)$/.exec(part)?.[1];
  if (codeFile.test(name) || !base.includes('.')) return stem(base)?.toLowerCase();
  for (const part of base.split('.')) {
    const found = stem(part);
    if (found) return found.toLowerCase();
  }
  return undefined;
}
/** The module stem of a changed source file in any folder; test files are not sources. */
export function sourceStem(path: string) {
  const name = path.split('/').pop() ?? '';
  const base = codeFile.exec(name)?.[1];
  return base && !testStem(name) ? base.toLowerCase() : undefined;
}
/** Generic module names say nothing about which change a test exercises. */
const genericStems = new Set(['index', 'main', 'types', 'schema', 'server', 'utils', 'errors', 'fields']);

/** How tests and stack traces name one changed path: the path itself and its
 * built `dist/` module (tests import the build). */
export function pathAliases(path: string) {
  const built = /^src\/(.+)\.ts$/.exec(path);
  return built ? [path, `dist/${built[1]}.js`] : [path];
}

/** Changed-file and one-hop import attribution of one failing test file:
 * the member changed the test itself, a declared contract test, the module
 * named by the test in any folder (x.test.mjs or test_x.py exercises any changed
 * x.ts or x.py), a changed source in the package a report names, or a module the
 * failure excerpt names (including its dist/ build). */
export function memberExplainsFailure(
  member: { paths: readonly string[]; tests: readonly string[] },
  file: string,
  firstError?: string,
) {
  if (member.tests.includes(file) || member.paths.includes(file)) return true;
  if (firstError && member.paths.some(path => pathAliases(path).some(alias => firstError.includes(alias))))
    return true;
  const stem = testStem(file);
  if (stem && !genericStems.has(stem) && stem.length >= 5)
    return member.paths.some(path => sourceStem(path) === stem);
  // A package-named report (Go: `example.com/repo/pkg/billing`) names its directory.
  if (!file.includes('/') || codeFile.test(file)) return false;
  return member.paths.some(path => {
    const directory = path.split('/').slice(0, -1).join('/');
    return Boolean(
      directory &&
      sourceStem(path) &&
      !genericStems.has(directory.split('/').pop()!) &&
      (file === directory || file.endsWith(`/${directory}`)),
    );
  });
}

/** A member whose previous combined failure failed some of the same files fails
 * them again with different peers below it: the common factor is the member. */
export function repeatOffender(previous: readonly string[] | undefined, failed: readonly string[]) {
  return Boolean(previous?.length && failed.some(file => previous.includes(file)));
}

/** What a failed combined generation does next. `unstack` is tried once per
 * member: a stacked group whose own changes explain nothing, below a predecessor
 * that has not passed, recomposes on current main without it (no one is blamed
 * without evidence). A single-member group on exact current main is its member's
 * own exact check: it settles instead of re-running the same tree alone.
 * Everything else keeps the existing attributed split. */
export function failedGroupAction(input: {
  members: number;
  suspects: number;
  semanticOrBudget: boolean;
  stacked: boolean;
  exactMain: boolean;
  predecessorPending: boolean;
  previouslyFailed: boolean;
}): 'settle' | 'unstack' | 'split' {
  // A failing step without a failing test file (build:web budget, wave 1) is
  // still the exact result of that tree: no file count is required.
  if (input.semanticOrBudget) return 'split';
  if (!input.stacked && input.members === 1 && input.exactMain) return 'settle';
  if (input.stacked && !input.suspects && input.predecessorPending && !input.previouslyFailed)
    return 'unstack';
  return 'split';
}

/** Bounded excerpt of one failed step: name, first errors and the reproducing command. */
export const stepExcerptChars = 560;
const jobLabel = (shard: number | undefined, shardCount: number | undefined) =>
  shard === undefined
    ? 'check'
    : shardCount !== undefined && shard === shardCount - 1
      ? `job ${shard} (static)`
      : `job ${shard}`;
function parseFailedStep(row: string) {
  const [name = '', command = '', ...text] = row.slice('[failed-step] '.length).split(' :: ');
  return { name, command, text: text.join(' :: ') };
}
const stepLine = /budget|error|failed|fail\b|exceed|cannot|not found|ERR!/i;
const npmTrailer = /^npm (?:ERR!|error)/i;
const thrownLine = /^(?:Uncaught )?[A-Z]\w*Error(?: \[[A-Z_]+\])?: \S/;
/** The failing step of a run whose failure names no test file, from the bounded
 * (<= 4 KiB per job) failure summaries the Actions jobs already sealed. Returns
 * the job and the most specific line, e.g. `llms-full.txt is 409868 bytes; the
 * budget is 409600` from the static build:web step. Nothing is fetched. */
export function failingStep(
  streams: readonly { descriptor: string; seal: string | null; failureExcerpt?: string | undefined }[],
  shardCount: number | undefined,
): { job: string; excerpt: string } | null {
  for (const stream of streams) {
    let summary = stream.failureExcerpt ?? '';
    let shard: number | undefined;
    try {
      const seal = stream.seal ? (JSON.parse(stream.seal) as { failureSummary?: string }) : {};
      summary = seal.failureSummary || summary;
      shard = (JSON.parse(stream.descriptor) as { shard?: number }).shard;
    } catch {
      continue;
    }
    const lines = summary
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    // verify.mjs repeats each failed step at the tail: `[failed-step] NAME :: COMMAND :: LINES`.
    const digest = lines
      .filter(text => text.startsWith('[failed-step] ') && text.includes(' :: '))
      .map(parseFailedStep);
    if (digest.length) {
      const [first, ...rest] = digest;
      const also = rest.length ? ` (also failed: ${rest.map(item => item.name).join(', ')})` : '';
      return {
        job: jobLabel(shard, shardCount),
        excerpt: `${first!.name} (reproduce: ${first!.command})${also}: ${first!.text}`.slice(
          0,
          stepExcerptChars,
        ),
      };
    }
    // npm's own trailer (`npm ERR! code 1`) names no cause; prefer the step's line.
    const matches = [...lines].reverse().filter(text => stepLine.test(text));
    // A thrown error's own line (`AssertionError [ERR_ASSERTION]: Unlisted packaged
    // document: ...`) names the cause better than a runner's later `failed` line.
    const line =
      matches.find(text => thrownLine.test(text)) ??
      matches.find(text => !npmTrailer.test(text)) ??
      matches[0] ??
      lines.at(-1)!;
    return { job: jobLabel(shard, shardCount), excerpt: line.slice(0, 240) };
  }
  return null;
}

type Diagnostic = {
  sharedRunId?: string | undefined;
  likelyCulprit: boolean;
  individualPassed: boolean;
  failedTests: string[];
  message: string;
};
/** A member that was in a failed shared run passed its own exact check: the
 * failure did not reproduce alone. When every member passes alone this is the
 * combination-only class (wave 1: build:web llms-full budget). Reported once on
 * the member with the failing files or step the shared run retained. */
export function passedAlone<T extends Diagnostic>(diagnostic: T | undefined): T | undefined {
  if (!diagnostic?.sharedRunId || diagnostic.individualPassed) return diagnostic;
  const what = diagnostic.failedTests.length ? diagnostic.failedTests.join(', ') : 'its failing step';
  return {
    ...diagnostic,
    likelyCulprit: false,
    individualPassed: true,
    message: `${diagnostic.message} Shared run ${diagnostic.sharedRunId} failed (${what}) but this member passed its own exact check: the failure needs the combination or another member.`,
  };
}
