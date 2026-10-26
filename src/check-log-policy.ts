// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { CheckRun, WorkData } from './work-types.js';

export type LogRun = Pick<CheckRun, 'id' | 'backend' | 'startedAt' | 'endedAt'>;
export type LogData = Pick<WorkData, 'autonomyPolicy'> & { runs: LogRun[] };

export const DAY_MS = 86_400_000;
export const LOCAL_LOG_DAYS = 7;
export const checkLogsSchema = z.object({
  uploadLocal: z.boolean().default(false),
  retentionDays: z.number().int().min(1).max(400).default(90),
});
export const logRecordSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(['provider-held', 'local-only', 'included', 'expired']),
  providerUrl: z.string().url().optional(),
  executionIds: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});
export function providerLogUrl(run: Pick<CheckRun, 'backend'>): string | undefined {
  const backend = run.backend;
  if (!backend || backend.actual === 'local') return;
  if (backend.providerUrl) return backend.providerUrl;
  if (backend.actual === 'github-actions') {
    const repo = /(?:^|;)repo:([^;]+)/.exec(backend.runtime ?? '')?.[1];
    if (repo && backend.executionIds?.[0])
      return `https://github.com/${repo}/actions/runs/${encodeURIComponent(backend.executionIds[0])}`;
    return 'https://github.com/actions';
  }
  return 'https://modal.com/apps';
}
export function runLogRecord(data: Pick<WorkData, 'autonomyPolicy'>, run: LogRun, now = Date.now()) {
  const providerUrl = providerLogUrl(run);
  if (providerUrl)
    return {
      runId: run.id,
      status: 'provider-held' as const,
      providerUrl,
      ...(run.backend?.executionIds ? { executionIds: run.backend.executionIds } : {}),
    };
  const settings = checkLogsSchema.parse(data.autonomyPolicy?.checkLogs ?? {});
  if (!settings.uploadLocal) return { runId: run.id, status: 'local-only' as const };
  const at = Date.parse(run.endedAt ?? run.startedAt);
  const expires = at + settings.retentionDays * DAY_MS;
  return {
    runId: run.id,
    status: Number.isFinite(expires) && now < expires ? ('included' as const) : ('expired' as const),
    ...(Number.isFinite(expires) ? { expiresAt: new Date(expires).toISOString() } : {}),
  };
}
export const isCheckLogPath = (path: string) =>
  /^check-[0-9a-fA-F-]{36}\/(?:[^/]+\.log|shards\/[^/]+\.log)$/.test(path);
/** Apply even to old baseline closures: terminal Work fingerprints do not encode retention age/settings. */
export function portableCheckPath(data: LogData, path: string, now = Date.now()): boolean {
  if (!isCheckLogPath(path)) return true;
  const run = data.runs.find(run => path.startsWith(`check-${run.id}/`));
  return !!run && runLogRecord(data, run, now).status === 'included';
}
export function portableRunFiles(data: WorkData, run: CheckRun, now = Date.now()) {
  return [
    ...(runLogRecord(data, run, now).status === 'included' ? ['stdout.log', 'stderr.log'] : []),
    ...(run.endedAt ? ['result.json'] : []),
    ...(run.resourceUsage?.producer ? ['resources.txt'] : []),
  ];
}
export const checkLogCoverage =
  'Check results, failure summaries, compact test evidence and provider log links are retained. CI-provider logs stay with the provider. Local logs are included only by explicit project opt-in and within finite retention.';
