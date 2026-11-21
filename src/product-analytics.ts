// SPDX-License-Identifier: Apache-2.0
import { networkFetch } from './network-fetch.js';

export type AnalyticsEvent = (
  | { event: 'landing_failed'; code: string; cause?: string; retry_count?: number }
  | { event: 'operation_failed' | 'dead_end'; command: string; code: string }
  | { event: 'first_landing'; minutes_since_start?: number }
  | { event: 'landing_accepted'; minutes_to_main?: number; checks_reused?: boolean }
  | { event: 'screen_opened'; screen: string }
  | { event: 'screen_error'; screen: string; code: 'render' }
) & { uuid?: string; timestamp?: string };

/** A PostHog project token is public ingestion configuration. Never accept a personal API key or arbitrary host. */
export function analyticsTarget(token: string | undefined, region: string | undefined) {
  if (!token || !/^phc_[A-Za-z0-9]{12,128}$/.test(token)) return undefined;
  if (region !== undefined && region !== 'us' && region !== 'eu') return undefined;
  return { token, url: `https://${region ?? 'us'}.i.posthog.com/batch/` };
}

/** Optional, best effort. The caller chooses when to send and supplies only the fields on AnalyticsEvent. */
export async function sendAnalytics(
  target: NonNullable<ReturnType<typeof analyticsTarget>>,
  distinctId: string,
  events: readonly AnalyticsEvent[],
  project?: string,
  signal?: AbortSignal,
  request?: typeof fetch,
) {
  if (!events.length) return;
  try {
    const response = await networkFetch(
      target.url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: target.token,
          batch: events.map(({ event, uuid, timestamp, ...properties }) => ({
            event,
            ...(uuid ? { uuid } : {}),
            ...(timestamp ? { timestamp } : {}),
            properties: {
              ...properties,
              distinct_id: distinctId,
              ...(project ? { project } : {}),
              $process_person_profile: false,
              $geoip_disable: true,
            },
          })),
        }),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        keepalive: true,
        ...(signal ? { signal } : {}),
      },
      { retries: 0, request, ...(signal ? {} : { totalTimeoutMs: 3000, headerTimeoutMs: 3000 }) },
    );
    await response.body?.cancel();
  } catch {
    // Analytics never changes the user's command, navigation or error reply.
  }
}
