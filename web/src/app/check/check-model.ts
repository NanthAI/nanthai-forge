// SPDX-License-Identifier: Apache-2.0
// The Failed check screen's words (Item b030c3c5), from the failure-cause contract (src/check-failure-cause.ts) and the
// landing state (src/landing-state.ts). Pure: the screen renders what this returns and adds nothing of its own.
import type {
  FailureCause,
  FailureRecovery,
  FailureSuspect,
  SuspectVerdict,
} from '../../../../src/check-failure-cause';
import { failureCauseField } from '../../../../src/check-failure-cause';
import type { LandingStateName } from '../../../../src/landing-state';
import type { StateKind } from '../../ds';

export type CheckRead = {
  laneId: string;
  title: string | null;
  candidateId: string | null;
  landing: {
    submissionId: string;
    operationId: string;
    phase: string;
    state: LandingStateName;
    label: string;
    nextStep: string;
    at: string;
    retryReason: string | null;
    error: { code: string; message: string } | null;
    receiptId: string | null;
  } | null;
  run: {
    runId: string;
    status: string;
    files: { total: number; failed: number; flaky: number };
    failed: { file: string; firstError?: string }[];
    flaky: string[];
    timings: { wallSeconds: number | null; shards: number | null };
    cost: { seconds: number; usd: number } | null;
    failureReason?: string;
  } | null;
  cause: FailureCause | null;
  main: { result: string | null; redSince: string | null } | null;
  lane: { count: number; complete: boolean } | null;
};

export const suspectNames: Record<FailureSuspect, string> = {
  change: 'The change',
  test: 'The test',
  main: 'main',
  ci: 'Your CI',
};
export const verdictWords: Record<SuspectVerdict, string> = {
  yes: 'Yes',
  likely: 'Likely',
  unlikely: 'Unlikely',
  no: 'No',
  'not-judged': 'Not judged',
  'not-reported': 'Not reported',
};

/** The head's state: glyph, word and colour for where this landing is. */
export function verdictState(read: CheckRead): { st: StateKind; word: string } {
  const state = read.landing?.state;
  if (!read.landing) return { st: 'stale', word: 'No landing yet' };
  if (state === 'landed') return { st: 'passed', word: 'Landed' };
  if (state === 'checking' || state === 'landing') return { st: 'active', word: read.landing.label };
  if (state === 'queued' || state === 'held-review' || state === 'held-dependency')
    return { st: 'waiting', word: read.landing.label };
  if (state === 'held-main-red') return { st: 'waiting', word: 'Held: main is failing' };
  if (state === 'waiting-for-runner') return { st: 'stale', word: 'Not started' };
  if (state === 'check-failed') {
    const files = read.run?.files;
    return {
      st: 'failed',
      word: files?.failed ? `Check failed, ${plural(files.failed, 'file')}` : 'Check failed',
    };
  }
  if (state === 'conflict') return { st: 'conflict', word: 'Conflict' };
  return { st: 'stale', word: read.landing.label };
}

/** The page sentence: the cause in one line, or the landing's own next step when there is nothing to explain. */
export function checkSentence(
  read: CheckRead,
  time: (iso: string) => string,
): { lead: string; rest: string } {
  const cause = read.cause;
  if (cause) {
    const since = cause.mainFailingSince
      ? ` main has been failing since ${time(cause.mainFailingSince)}.`
      : '';
    return { lead: cause.sentence, rest: `${since} ${nextLine(cause.next.recovery)}`.trim() };
  }
  if (!read.landing)
    return { lead: 'This Lane has not asked to land yet.', rest: 'Its check runs when it does.' };
  if (read.landing.state === 'landed')
    return {
      lead: 'Passed and on main.',
      rest: read.run?.timings.shards
        ? `It checked the exact result that landed, in ${plural(read.run.timings.shards, 'shard')}.`
        : '',
    };
  return { lead: `${read.landing.label}.`, rest: read.landing.nextStep };
}

const nextLines: Record<FailureRecovery, string> = {
  'fix-in-lane': 'Fix it in this Lane and land again.',
  retry: 'Retry the check; the code does not change.',
  'wait-for-main': 'Nothing to do in this Lane; it is checked again when main passes.',
  wait: 'Nothing to do yet; Forge checks again by itself.',
  'read-log': 'Read the log to decide: fix it in this Lane, or retry.',
};
export const nextLine = (recovery: FailureRecovery) => nextLines[recovery];

/** The prompt "Give this to your agent" copies: the cause and where to start, never a log or a secret. */
export function agentPrompt(read: CheckRead, project: string) {
  const title = read.title ? `“${read.title}”` : read.laneId.slice(0, 8);
  const cause = read.cause;
  return [
    `The landing check of Lane ${title} in ${project} did not pass.`,
    cause ? `Forge says: ${cause.sentence}` : '',
    cause ? cause.next.agent : '',
    `Read it: nforge agent . status '{"laneId":"${read.laneId}"}'`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** What an agent's reply carries for this page: the same cause, suspects and next step, as the chip's output. */
export function agentReply(read: CheckRead) {
  const field = failureCauseField(read.cause);
  const lines = [`$ nforge agent . status '{"laneId":"${read.laneId}"}'`];
  if (read.landing) lines.push(`state     ${read.landing.state}   ${read.landing.label}`);
  if (field) {
    lines.push(`cause     ${field.cause}   ${field.sentence}`);
    lines.push(
      `suspects  ${Object.entries(field.suspects)
        .map(([name, verdict]) => `${name} ${verdict}`)
        .join(', ')}`,
    );
    lines.push(`next      ${field.recovery}   ${field.next}`);
    if (field.retryReason)
      lines.push(
        `retry     nforge agent . land --save '{"laneId":"…","retry":true,"reason":"${field.retryReason}"}'`,
      );
  } else if (read.landing) lines.push(`next      ${read.landing.nextStep}`);
  if (read.run)
    lines.push(`log       nforge agent . status '{"runId":"${read.run.runId}","reports":"failed"}'`);
  return lines.join('\n');
}

export function plural(count: number, noun: string) {
  return `${count.toLocaleString('en')} ${noun}${count === 1 ? '' : 's'}`;
}
export function duration(seconds: number | null | undefined) {
  if (seconds == null) return 'not reported';
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)} min ${whole % 60} s`;
}
