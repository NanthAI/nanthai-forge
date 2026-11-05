// SPDX-License-Identifier: Apache-2.0
/** Queue throughput after combined failures (51bbbd00, wave 1 2026-11-05).
 * Pure decisions shared by the landing controller, the landing-queue model map
 * and the synthetic queue harness. None of them grants publication authority:
 * every landing still needs its own exact passed proof on current main. */

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

const testFile = /^tests\/(?:.+\/)?([^/]+)\.test\.[cm]?[jt]sx?$/;
const sourceFile = /^(?:src|convex|scripts|web\/src|netlify\/functions)\/(?:.+\/)?([^/]+)\.[cm]?[jt]sx?$/;
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
 * named by the test (tests/x.test.mjs exercises src/x.ts, convex/x.ts, ...),
 * or a module the failure excerpt names (including its dist/ build). */
export function memberExplainsFailure(
  member: { paths: readonly string[]; tests: readonly string[] },
  file: string,
  firstError?: string,
) {
  if (member.tests.includes(file) || member.paths.includes(file)) return true;
  if (firstError && member.paths.some(path => pathAliases(path).some(alias => firstError.includes(alias))))
    return true;
  const stem = testFile.exec(file)?.[1];
  if (!stem || genericStems.has(stem) || stem.length < 5) return false;
  return member.paths.some(path => sourceFile.exec(path)?.[1] === stem);
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

const stepLine = /budget|error|failed|fail\b|exceed|cannot|not found|ERR!/i;
const npmTrailer = /^npm (?:ERR!|error)/i;
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
    // npm's own trailer (`npm ERR! code 1`) names no cause; prefer the step's line.
    const matches = [...lines].reverse().filter(text => stepLine.test(text));
    const line = matches.find(text => !npmTrailer.test(text)) ?? matches[0] ?? lines.at(-1)!;
    const job =
      shard === undefined
        ? 'check'
        : shardCount !== undefined && shard === shardCount - 1
          ? `job ${shard} (static)`
          : `job ${shard}`;
    return { job, excerpt: line.slice(0, 240) };
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
