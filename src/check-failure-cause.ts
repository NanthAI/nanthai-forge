// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the CLI, the web and the Convex non-Node runtime.
/**
 * The failure-cause contract (Item 2c420916): one reading of why a landing check did not pass, for the
 * Failed check screen, Needs me, run evidence and agent replies. It names one cause, the four suspects
 * in a fixed order (the change, the test, main, the CI provider) and one next recovery, from evidence
 * Forge already retained: the run summary, the Lane's changed paths, main's audit and the landing
 * state. It never fetches a log, reads source or runs anything. A cause the evidence cannot establish
 * is `unknown`; a fact that was not retained is `not-reported`, never a guess.
 */
import { memberExplainsFailure } from './hosted-landing-suspect.js';
import type { LandingStateName } from './landing-state.js';
import { checkFailedOrInfrastructure, checkNeverRan } from './check-run-state.js';

export const FAILURE_CAUSE_SCHEMA = 1;
/** The four suspects, always all four and always in this order. */
export const failureSuspects = ['change', 'test', 'main', 'ci'] as const;
export type FailureSuspect = (typeof failureSuspects)[number];
export const failureCauses = [
  'change',
  'flaky-test',
  'main-failing',
  'main-moved',
  'ci-not-started',
  'ci-stopped',
  'unknown',
] as const;
export type FailureCauseKind = (typeof failureCauses)[number];
/** What the evidence says about one suspect. `not-judged`: nothing ran that could judge it. */
export type SuspectVerdict = 'yes' | 'likely' | 'unlikely' | 'no' | 'not-judged' | 'not-reported';
/** One recovery vocabulary for web buttons and agent replies. */
export const failureRecoveries = ['fix-in-lane', 'retry', 'wait-for-main', 'wait', 'read-log'] as const;
export type FailureRecovery = (typeof failureRecoveries)[number];
/** The retry reason a recovery records (src/hosted-landing.ts finishRetryReasonSchema), so agents never pick one. */
export type RetryReason = 'flake' | 'main-moved' | 'infra';

export type FailedFile = { file: string; firstError?: string | undefined };
export type FailureEvidence = {
  /** The landing's state from `landingStateOf` (src/landing-state.ts), when a landing is known. */
  landing?: { state: LandingStateName; code?: string | undefined } | null | undefined;
  /** The run's bounded summary (src/hosted-check-summary.ts) or the same fields. */
  run?:
    | {
        status: string;
        failed?: readonly FailedFile[] | undefined;
        /** Failed file count when `failed` is clipped. */
        failedCount?: number | undefined;
        /** Files that failed then passed on retry inside this run. */
        flaky?: readonly string[] | undefined;
        /** Failing job step of a run that names no test file (convex/projectHostedCheckFailure.ts). */
        step?: { job: string; excerpt: string } | null | undefined;
        /** Tests with retained `flake` verdicts: failed before on unchanged or unrelated source. */
        knownFlaky?: readonly string[] | undefined;
      }
    | null
    | undefined;
  /** The Lane's changed paths and declared tests; absent when not retained. */
  lane?: { paths: readonly string[]; tests?: readonly string[] | undefined } | null | undefined;
  /** main's audit (convex/projectHostedMainAuditState.ts mainAuditStatus subset). */
  main?: { result: string | null; redSince: string | null } | null | undefined;
};
export type SuspectReading = { suspect: FailureSuspect; verdict: SuspectVerdict; evidence: string[] };
export type FailureCause = {
  schema: typeof FAILURE_CAUSE_SCHEMA;
  cause: FailureCauseKind;
  /** One plain line: the cause. Times are left to the reader (`mainFailingSince`). */
  sentence: string;
  next: {
    recovery: FailureRecovery;
    /** The button or reply label, the same words everywhere. */
    label: string;
    /** What the agent does, in one line. */
    agent: string;
    retryReason?: RetryReason;
  };
  suspects: SuspectReading[];
  /** When main's audit turned red, if it is red now. */
  mainFailingSince: string | null;
  /** The failing files the cause rests on, at most FAILURE_FILES. */
  failing: FailedFile[];
  failingCount: number;
};

export const FAILURE_FILES = 20;
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export const recoveryText: Record<FailureRecovery, { label: string; agent: string }> = {
  'fix-in-lane': {
    label: 'Fix it in this Lane',
    agent: 'Fix it in this Lane, save, then land --save again; do not abandon or re-create the Lane.',
  },
  retry: {
    label: 'Retry the check',
    agent: 'Run land --save again with "retry":true and the recorded reason; the code does not change.',
  },
  'wait-for-main': {
    label: 'Keep waiting',
    // Until fix D (Item 687d1eda) parks failed landings, only a main-red hold continues by itself.
    agent:
      "Do not change your code: a landing that fails only on main's failing tests is not at fault. A held landing continues once main passes; a failed one needs land --save again once main passes.",
  },
  wait: { label: 'Keep waiting', agent: 'Wait; Forge checks again by itself.' },
  'read-log': {
    label: 'Read the log',
    agent:
      'Forge could not tell the cause; read the check log, then fix in this Lane or retry with a reason.',
  },
};

const notFailure = new Set<LandingStateName>([
  'queued',
  'checking',
  'landing',
  'held-review',
  'held-dependency',
  'landed',
  'conflict',
  'cancelled',
  'rejected',
  // "Can't confirm" is not a failure; the reader shows the landing state instead.
  'unknown',
]);

/** The one cause of a check that did not pass, or null when there is nothing to explain (running,
 * passed, landed, a conflict or a person's cancel). Bounded: at most FAILURE_FILES files are read. */
export function failureCause(evidence: FailureEvidence): FailureCause | null {
  const { run, lane, main } = evidence;
  const landing = evidence.landing?.state;
  if (landing && notFailure.has(landing)) return null;
  const status = run?.status;
  if (!landing && (!status || status === 'passed' || !checkFailedOrInfrastructure(status))) return null;
  const mainRed = main?.result === 'failed' || Boolean(main?.redSince);
  const mainSince = mainRed ? (main?.redSince ?? null) : null;
  const failed = (run?.failed ?? []).slice(0, FAILURE_FILES);
  const failingCount = Math.max(failed.length, run?.failedCount ?? 0);
  const mainReading = (): SuspectReading =>
    main == null
      ? { suspect: 'main', verdict: 'not-reported', evidence: ["main's audit was not reported"] }
      : mainRed
        ? { suspect: 'main', verdict: 'likely', evidence: ["main's full check is failing"] }
        : main.result === 'passed'
          ? { suspect: 'main', verdict: 'no', evidence: ['main passed its last audit'] }
          : { suspect: 'main', verdict: 'not-reported', evidence: ['main has no audit result yet'] };
  const ciFine = (): SuspectReading =>
    status && !checkNeverRan(status) && status !== 'interrupted'
      ? { suspect: 'ci', verdict: 'no', evidence: ['the CI ran the check to a result'] }
      : { suspect: 'ci', verdict: 'not-reported', evidence: ['no run was reported'] };
  const notJudged = (suspect: FailureSuspect, why: string): SuspectReading => ({
    suspect,
    verdict: 'not-judged',
    evidence: [why],
  });
  const build = (
    cause: FailureCauseKind,
    sentence: string,
    recovery: FailureRecovery,
    suspects: SuspectReading[],
    retryReason?: RetryReason,
  ): FailureCause => ({
    schema: FAILURE_CAUSE_SCHEMA,
    cause,
    sentence,
    next: { recovery, ...recoveryText[recovery], ...(retryReason ? { retryReason } : {}) },
    suspects: failureSuspects.map(name => suspects.find(item => item.suspect === name)!),
    mainFailingSince: mainSince,
    failing: failed.map(item => ({
      file: clip(item.file, 300),
      ...(item.firstError ? { firstError: clip(item.firstError, 240) } : {}),
    })),
    failingCount,
  });

  // main moved under the check: not a failure of anything.
  if (landing === 'stale-head' || landing === 'superseded')
    return build(
      'main-moved',
      'Not a failure: main moved while this was checking, so the result no longer describes main.',
      'retry',
      [
        notJudged('change', 'the check did not judge the change on the new main'),
        notJudged('test', 'no test result counts'),
        { suspect: 'main', verdict: 'yes', evidence: ['main moved after this landing was submitted'] },
        ciFine(),
      ],
      'main-moved',
    );
  // The CI never started it, or stopped it: the code was not judged.
  if (landing === 'waiting-for-runner' || landing === 'not-run' || (status && checkNeverRan(status)))
    return build(
      'ci-not-started',
      'Your CI has not started this check, so the change was not judged.',
      landing === 'waiting-for-runner' ? 'wait' : 'retry',
      [
        notJudged('change', 'no shard has run'),
        notJudged('test', 'no shard has run'),
        mainReading(),
        { suspect: 'ci', verdict: 'yes', evidence: ['no runner took the check'] },
      ],
      landing === 'waiting-for-runner' ? undefined : 'infra',
    );
  if (status === 'interrupted')
    return build(
      'ci-stopped',
      'Your CI stopped the check before it finished, so the change was not judged.',
      'retry',
      [
        notJudged('change', 'the check stopped before a verdict'),
        notJudged('test', 'the check stopped before a verdict'),
        mainReading(),
        { suspect: 'ci', verdict: 'yes', evidence: ['the runner stopped mid-run'] },
      ],
      'infra',
    );
  // main is red and parks this landing.
  if (landing === 'held-main-red')
    return build(
      'main-failing',
      'Not this change: main is failing, so this landing waits until main passes.',
      'wait-for-main',
      [
        notJudged('change', 'this landing waits for main'),
        notJudged('test', 'this landing waits for main'),
        { suspect: 'main', verdict: 'yes', evidence: ["main's full check is failing"] },
        ciFine(),
      ],
    );

  // A failed run: attribute the failing files.
  const member = lane ? { paths: lane.paths, tests: lane.tests ?? [] } : null;
  const explained = member
    ? failed.filter(item => memberExplainsFailure(member, item.file, item.firstError))
    : [];
  const stepExplained =
    member && !failed.length && run?.step ? memberExplainsFailure(member, '', run.step.excerpt) : false;
  const known = new Set(run?.knownFlaky ?? []);
  const flakyBefore = failed.filter(item => known.has(item.file));
  const first = failed[0];
  // The sentence names the file; its error is in `failing`, so the line stays one line.
  const firstLine = first
    ? `${first.file} fails`
    : run?.step
      ? `${run.step.job}: ${clip(run.step.excerpt, 120)}`
      : 'no failing test or step was reported';
  const more = failingCount > 1 ? `; ${plural(failingCount - 1, 'more failing file')}` : '';

  if (explained.length || stepExplained) {
    const sentence = stepExplained
      ? `Your change: ${firstLine}, which names a file this Lane changed.`
      : `Your change: ${explained[0]!.file} fails and covers files this Lane changed${more}.`;
    return build('change', sentence, 'fix-in-lane', [
      {
        suspect: 'change',
        verdict: 'yes',
        evidence: [
          stepExplained
            ? 'the failing step names a file this Lane changed'
            : `${plural(explained.length, 'failing file')} cover${explained.length === 1 ? 's' : ''} this Lane's changes`,
        ],
      },
      flakyBefore.length
        ? { suspect: 'test', verdict: 'unlikely', evidence: ['it failed before, but this Lane changes it'] }
        : { suspect: 'test', verdict: 'unlikely', evidence: ['no earlier flaky failure is recorded'] },
      mainReading(),
      ciFine(),
    ]);
  }
  if (mainRed && failed.length)
    return build(
      'main-failing',
      `Not this change: main is failing too, and ${first!.file} does not cover this Lane's files.`,
      'wait-for-main',
      [
        {
          suspect: 'change',
          verdict: member ? 'unlikely' : 'not-reported',
          evidence: [
            member ? 'no failing file covers this Lane' : "the Lane's changed files were not reported",
          ],
        },
        { suspect: 'test', verdict: 'unlikely', evidence: ['main fails without this Lane'] },
        { suspect: 'main', verdict: 'yes', evidence: ["main's full check is failing"] },
        ciFine(),
      ],
    );
  if (member && failed.length && flakyBefore.length === failed.length)
    return build(
      'flaky-test',
      `Probably a flaky test, not the change: ${first!.file} failed before on code that did not change${more}.`,
      'retry',
      [
        { suspect: 'change', verdict: 'unlikely', evidence: ["no failing file covers this Lane's changes"] },
        {
          suspect: 'test',
          verdict: 'likely',
          evidence: [`${plural(flakyBefore.length, 'failing file')} failed before on unchanged code`],
        },
        mainReading(),
        ciFine(),
      ],
      'flake',
    );
  return build('unknown', `Forge could not tell the cause: ${firstLine}${more}.`, 'read-log', [
    member
      ? {
          suspect: 'change',
          verdict: failed.length ? 'unlikely' : 'not-reported',
          evidence: [
            failed.length
              ? "no failing file covers this Lane's changes"
              : 'the failure names no file to compare with the change',
          ],
        }
      : {
          suspect: 'change',
          verdict: 'not-reported',
          evidence: ["the Lane's changed files were not reported"],
        },
    flakyBefore.length
      ? {
          suspect: 'test',
          verdict: 'likely',
          evidence: ['some failing files failed before on unchanged code'],
        }
      : {
          suspect: 'test',
          verdict: 'not-reported',
          evidence: ['no earlier failure of these tests is recorded'],
        },
    mainReading(),
    ciFine(),
  ]);
}

/** The agent reply field: the same cause and next recovery the web shows, in a few short lines. */
export function failureCauseField(cause: FailureCause | null) {
  if (!cause) return null;
  return {
    cause: cause.cause,
    sentence: cause.sentence,
    recovery: cause.next.recovery,
    next: cause.next.agent,
    ...(cause.next.retryReason ? { retryReason: cause.next.retryReason } : {}),
    ...(cause.mainFailingSince ? { mainFailingSince: cause.mainFailingSince } : {}),
    suspects: Object.fromEntries(cause.suspects.map(item => [item.suspect, item.verdict])),
  };
}
