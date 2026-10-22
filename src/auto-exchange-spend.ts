// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { usageObservationSchema, type UsageObservation, type SpendStatus } from './auto-exchange-state.js';

export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
export type UsageContext = { projectId: string; deployment: string };
export type UsageAdapter = (context: UsageContext) => Promise<unknown>;
/** Explicit operator config hook. There is no billing endpoint/credential in the
 * repository. This module loads an absolute operator-owned ESM adapter whose
 * readUsage(context) reads its token privately. Provider text is never retained. */
export const configuredUsage: UsageAdapter = async context => {
  const path = process.env.FORGE_CONVEX_USAGE_ADAPTER;
  if (!path || !isAbsolute(path)) return undefined;
  const adapter = await import(pathToFileURL(path).href);
  return adapter.readUsage(context);
};
export async function observeSpend(
  context: UsageContext,
  previous: UsageObservation[],
  now: number,
  adapter: UsageAdapter = configuredUsage,
): Promise<{ samples: UsageObservation[]; spend: SpendStatus }> {
  const unknown = (
    reason: SpendStatus['reason'],
    availability: SpendStatus['availability'] = 'unknown',
  ): { samples: UsageObservation[]; spend: SpendStatus } => ({
    samples: previous,
    spend: {
      availability,
      deltaUsd: null,
      measuredTotalUsd: null,
      estimatedTotalUsd: null,
      windowStartedAt: null,
      observedAt: null,
      resumeAt: null,
      paused: false,
      reason,
    },
  });
  let input: unknown;
  try {
    input = await adapter(context);
  } catch {
    return unknown('unavailable');
  }
  if (input === undefined) return unknown('unconfigured');
  const parsed = usageObservationSchema.safeParse(input);
  if (!parsed.success) return unknown('unavailable');
  const sample = parsed.data;
  if (sample.projectId !== context.projectId || sample.deployment !== context.deployment)
    return unknown('unavailable');
  if (sample.observedAt > now || sample.observedAt <= now - SPEND_WINDOW_MS) return unknown('stale');
  if (sample.kind === 'estimated') {
    const result = unknown('unavailable', 'estimated');
    result.spend.estimatedTotalUsd = sample.totalUsd;
    result.spend.observedAt = sample.observedAt;
    return result;
  }
  const history = previous.filter(
    item =>
      item.kind === 'measured' &&
      item.subject === sample.subject &&
      item.projectId === sample.projectId &&
      item.deployment === sample.deployment &&
      item.observedAt > now - SPEND_WINDOW_MS,
  );
  const last = history.at(-1);
  if (last && sample.observedAt < last.observedAt) return unknown('stale');
  if (last && sample.observedAt === last.observedAt && sample.totalUsd !== last.totalUsd)
    return unknown('unavailable');
  const reset = !!last && sample.totalUsd < last.totalUsd;
  const samples = reset
    ? [sample]
    : [...history.filter(item => item.observedAt !== sample.observedAt), sample];
  const baseline = samples[0]!,
    deltaUsd = sample.totalUsd - baseline.totalUsd;
  const paused = deltaUsd > 1 + 1e-9;
  return {
    samples,
    spend: {
      availability: 'measured',
      deltaUsd,
      measuredTotalUsd: sample.totalUsd,
      estimatedTotalUsd: null,
      observedAt: sample.observedAt,
      windowStartedAt: baseline.observedAt,
      resumeAt: paused ? baseline.observedAt + SPEND_WINDOW_MS : null,
      paused,
      reason: reset ? 'reset' : paused ? 'threshold-exceeded' : 'within-window',
    },
  };
}
