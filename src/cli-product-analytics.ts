// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { failureCauses } from './check-failure-cause.js';
import { deploymentUrl } from './deployment-origin.js';
import { agentDeadEnd, cliTeachContext, teachingByCode, teachReceipt } from './error-teaching.js';
import type { HostedAgentAddress } from './hosted-address.js';
import { networkTimeout } from './network-fetch.js';
import { analyticsTarget, sendAnalytics, type AnalyticsEvent } from './product-analytics.js';
import { describeFailure } from './system-errors.js';
import { refuseRealUserState } from './test-isolation.js';

type Landing = {
  phase?: string;
  at?: string;
  attemptId?: string;
  firstAttemptId?: string;
  error?: { code?: string };
  observation?: { state?: string };
  timing?: { submittedAt?: string; committedAt?: string };
  acceptance?: { receiptId?: string };
};
type Result = {
  at?: string;
  lane?: unknown;
  status?: string;
  inProgress?: boolean;
  error?: { code?: string };
  submissions?: Outcome[];
} & Outcome;
type Outcome = {
  submission?: Landing;
  failureCause?: { cause?: string };
};
const causeNames: ReadonlySet<string> = new Set(failureCauses);
const safeCode = (code: string | null | undefined) =>
  typeof code === 'string' && (Object.hasOwn(teachingByCode, code) || code === 'RUNNER_UNAVAILABLE')
    ? code
    : 'unclassified';
const minutes = (from: string | undefined, to: string | undefined) => {
  const elapsed = Date.parse(to ?? '') - Date.parse(from ?? '');
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed / 60_000) : undefined;
};
const hash = (key: string, value: string) => createHmac('sha256', key).update(value).digest('hex');
const landingPhase = (landing?: Landing) => landing?.observation?.state ?? landing?.phase;
function landingFailure(landing?: Landing) {
  const code = landing?.error?.code;
  return landingPhase(landing) === 'terminal-failed' && code !== 'LANDING_CANCELLED' ? code : undefined;
}

function createOnce(path: string, value: string) {
  try {
    writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function readOptional(path: string) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/** No dependency on a live Forge record: use the command's final reply and one local installation marker. */
export async function captureCliAnalytics(
  address: HostedAgentAddress,
  command: string,
  outcome: { reply: unknown } | { error: unknown },
  env: NodeJS.ProcessEnv = process.env,
  send?: typeof fetch,
) {
  try {
    const target = analyticsTarget(env.FORGE_POSTHOG_PROJECT_TOKEN, env.FORGE_POSTHOG_REGION || undefined);
    if (!target || env.DO_NOT_TRACK === '1' || !env.FORGE_POSTHOG_DEV_DEPLOYMENT) return;
    if (deploymentUrl(env.FORGE_POSTHOG_DEV_DEPLOYMENT) !== address.url) return;
    const context = cliTeachContext(process.argv.slice(2));
    const error = 'error' in outcome ? describeFailure(outcome.error, context) : undefined;
    const result =
      'reply' in outcome ? (outcome.reply as { result?: Result } | undefined)?.result : undefined;
    const deadEnd = agentDeadEnd(error ? { error } : teachReceipt({ result }, context));
    const landingCommand = command === 'land' || command === 'wait';
    const landings = landingCommand ? (result?.submissions ?? (result ? [result] : [])) : [];
    const code = error?.code ?? result?.error?.code;
    const failure = code === 'LANDING_CANCELLED' ? undefined : code;
    const start = command === 'start' && result?.lane && result.at ? result.at : undefined;
    if (
      !start &&
      !failure &&
      !deadEnd &&
      !landings.some(entry => landingFailure(entry.submission) || entry.submission?.acceptance)
    )
      return;

    const directory = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'forge', 'analytics');
    refuseRealUserState(directory, 'product analytics');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const install = join(directory, 'installation');
    const generated = randomUUID();
    const distinctId = createOnce(install, generated) ? generated : readOptional(install);
    if (!distinctId || !uuid.test(distinctId)) return;
    const project = hash(target.token, `${address.url}\n${address.projectId}`);
    const started = join(directory, `${project}.start`);
    if (start) createOnce(started, start);

    let events: AnalyticsEvent[] = [];
    let signal: AbortSignal | undefined;
    const flush = async () => {
      if (!events.length) return;
      signal ??= networkTimeout(300);
      if (!signal.aborted) await sendAnalytics(target, distinctId, events, project, signal, send);
      events = [];
    };
    const operationFailure =
      failure ?? landingFailure(landings.find(entry => landingFailure(entry.submission))?.submission);
    if (operationFailure && (!result?.inProgress || deadEnd))
      events.push({ event: 'operation_failed', command, code: safeCode(operationFailure) });
    if (deadEnd) events.push({ event: 'dead_end', command, code: safeCode(deadEnd.code) });
    for (const entry of landings) {
      if (events.length >= 18) await flush();
      if (signal?.aborted) break;
      const submission = entry.submission;
      const phase = landingPhase(submission);
      const failed = landingFailure(submission);
      if (failed && submission) {
        const cause = entry.failureCause?.cause;
        const firstTry = submission.attemptId && submission.attemptId === submission.firstAttemptId;
        events.push({
          event: 'landing_failed',
          code: safeCode(failed),
          ...(cause && causeNames.has(cause) ? { cause } : {}),
          ...(firstTry ? { retry_count: 0 } : {}),
        });
      }
      const receipt = submission?.acceptance?.receiptId;
      if (phase !== 'landed' || !receipt || !uuid.test(receipt)) continue;
      const committed = submission?.timing?.committedAt;
      if (createOnce(join(directory, `${project}.landed`), '1')) {
        const elapsed = minutes(readOptional(started), committed);
        events.push({
          event: 'first_landing',
          ...(elapsed === undefined ? {} : { minutes_since_start: elapsed }),
        });
      }
      // Stable across retries of the same accepted landing.
      const sample = hash(distinctId, receipt);
      if (
        committed &&
        Number.isFinite(Date.parse(committed)) &&
        Number.parseInt(sample.slice(0, 8), 16) < 0x1_0000_0000 / 10
      ) {
        const elapsed = minutes(submission.timing?.submittedAt ?? submission.at, committed);
        events.push({
          event: 'landing_accepted',
          uuid: `${sample.slice(0, 8)}-${sample.slice(8, 12)}-8${sample.slice(13, 16)}-8${sample.slice(17, 20)}-${sample.slice(20, 32)}`,
          timestamp: new Date(committed).toISOString(),
          ...(elapsed === undefined ? {} : { minutes_to_main: elapsed }),
        });
      }
    }
    // Failed terminal invocations can be retried normally. Telemetry never retries its own send.
    await flush();
  } catch {
    // Local IO, configuration and vendor failures leave the Forge outcome intact.
  }
}
