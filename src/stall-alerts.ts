// SPDX-License-Identifier: Apache-2.0
import type { HostedLandingState } from './hosted-landing.js';
import type { EffectiveAgentDefaults } from './agent-parallel-defaults.js';

/** Stall alerts ride the landing stall alarm: tier 1 notifies, tier 2 repeats once with a diagnosis.
 * Secrets (webhook URL, email token) come only from deployment env vars and never enter text. */
export const STALL_ALERT_ENV = {
  webhookUrl: 'FORGE_ALERT_WEBHOOK_URL',
  emailToken: 'FORGE_ALERT_EMAIL_TOKEN',
  emailAccount: 'FORGE_ALERT_EMAIL_ACCOUNT_ID',
  emailFrom: 'FORGE_ALERT_EMAIL_FROM',
} as const;
export const DEFAULT_ALERT_SENDER = 'support@nanthai.tech';
export type StallAlertTier = 1 | 2;
export type StallAlert = {
  tier: StallAlertTier;
  submissionId: string;
  operationId: string;
  subject: string;
  text: string;
  repair: string;
  at: string;
};

const minutes = (from: string, now: number) => Math.max(0, Math.round((now - Date.parse(from)) / 60_000));

/** What, why, the repair command and what was already retried; tier 2 adds the diagnosis. */
export function stallAlert(
  state: HostedLandingState,
  tier: StallAlertTier,
  input: { project: string; queuedBehind?: number; now?: number },
): StallAlert {
  const now = input.now ?? Date.now(),
    stall = state.observation.stall;
  const step = stall?.step ?? state.phase,
    since = stall?.lastProgressAt ?? state.at;
  const repair =
    `nforge agent ROOT landing '{"operationId":"${state.operationId}"}' to read it; ` +
    `replay the same land operationId to resume. If ${stall?.missingOwner ?? 'the controller'} is down, fix that first.`;
  const retried = [
    'stall alarm re-woke the landing queue at 15 min',
    ...(state.supersedes ? [`resubmission of ${state.supersedes} (${state.retryReason ?? 'retry'})`] : []),
  ];
  const lines = [
    `${tier === 1 ? 'Landing stalled' : 'Still stalled'}: ${input.project}, submission ${state.id} by ${state.actor}, ${minutes(since, now)} min without progress at ${step}.`,
    `Why: ${stall?.message ?? 'no landing progress'}`,
    `Already tried: ${retried.join('; ')}.`,
    `Repair: ${repair}`,
  ];
  if (tier === 2) {
    const timing: NonNullable<HostedLandingState['timing']> = state.timing ?? { submittedAt: state.at };
    const runnerDone = timing.ciEndedAt && !timing.settlementStartedAt;
    lines.push(
      `Diagnosis: dead step ${step}` +
        (runnerDone ? ` (runner finished at ${timing.ciEndedAt} but no result was recorded)` : '') +
        `; last progress ${since}; error ${state.error ? `${state.error.code}: ${state.error.message.slice(0, 200)}` : 'none recorded'}` +
        `; waiting: ${state.actor}${input.queuedBehind ? ` and ${input.queuedBehind} queued behind` : ''}.`,
    );
  }
  return {
    tier,
    submissionId: state.id,
    operationId: state.operationId,
    subject: `[Forge] ${tier === 1 ? 'Landing stalled' : 'Still stalled'}: ${input.project} ${step}`,
    text: lines.join('\n'),
    repair,
    at: new Date(now).toISOString(),
  };
}

export type AlertRequest = { channel: 'email' | 'webhook'; url: string; init: RequestInit };
type Env = Record<string, string | undefined>;

/** Provider requests for one alert. Missing env leaves that channel out; nothing is sent. */
export function stallAlertRequests(
  alert: Pick<StallAlert, 'subject' | 'text'>,
  settings: EffectiveAgentDefaults['stallAlerts'],
  env: Env,
): AlertRequest[] {
  const requests: AlertRequest[] = [];
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const token = env[STALL_ALERT_ENV.emailToken],
    account = env[STALL_ALERT_ENV.emailAccount];
  if (settings.email.length && token && account && /^[0-9a-f]{32}$/i.test(account))
    for (const to of settings.email)
      requests.push({
        channel: 'email',
        url: `https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`,
        init: json(
          {
            from: env[STALL_ALERT_ENV.emailFrom] || DEFAULT_ALERT_SENDER,
            to,
            subject: alert.subject,
            text: alert.text,
          },
          { authorization: `Bearer ${token}` },
        ),
      });
  const url = env[STALL_ALERT_ENV.webhookUrl];
  if (settings.webhook !== 'off' && url && /^https:\/\//.test(url)) {
    const preset = settings.webhook;
    const init =
      preset === 'ntfy'
        ? {
            method: 'POST',
            headers: { title: alert.subject.replace(/[^\x20-\x7e]/g, ''), priority: 'high', tags: 'warning' },
            body: alert.text,
          }
        : preset === 'slack'
          ? json({ text: `*${alert.subject}*\n${alert.text}` })
          : preset === 'discord'
            ? json({ content: `**${alert.subject}**\n${alert.text}`.slice(0, 2000) })
            : preset === 'telegram'
              ? json({ text: `${alert.subject}\n${alert.text}`.slice(0, 4096) })
              : json({ subject: alert.subject, text: alert.text });
    requests.push({ channel: 'webhook', url, init });
  }
  return requests;
}

/** Sends every request once; reports channel and HTTP status only, never URLs, tokens or bodies. */
export async function deliverStallAlert(
  alert: Pick<StallAlert, 'subject' | 'text'>,
  settings: EffectiveAgentDefaults['stallAlerts'],
  env: Env,
  send: typeof fetch = fetch,
) {
  const results: { channel: AlertRequest['channel']; status: number | 'failed' }[] = [];
  for (const request of stallAlertRequests(alert, settings, env)) {
    try {
      const response = await send(request.url, { ...request.init, signal: AbortSignal.timeout(10_000) });
      results.push({ channel: request.channel, status: response.status });
    } catch {
      results.push({ channel: request.channel, status: 'failed' });
    }
  }
  return results;
}
