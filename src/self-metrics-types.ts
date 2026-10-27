// SPDX-License-Identifier: Apache-2.0
import type { DiskSample } from './self-metrics-disk.js';
import type { MetricObservation } from './self-metrics-observations.js';
import type { SelfMetricReceipt } from './self-metrics-journal.js';
export type MetricInput = {
  laneId: string;
  head: string;
  intentId: string;
  savedAt?: string | undefined;
  compensating?: boolean;
};
export type MetricMove = {
  id: string;
  at: string;
  head: string;
  inputs: MetricInput[];
  kind: 'landing' | 'revert' | 'compensating';
  ancestorHeads?: string[];
};
export type MetricSubmission = {
  id: string;
  entryId: string;
  entryAt?: string | undefined;
  entryStatus?: string | undefined;
  retryCause?: import('./first-attempt-land-rate.js').LandRateEntry['cause'];
  at: string;
  inputs: MetricInput[];
  status: string;
  endedAt?: string | undefined;
  progressAt: string[];
  runIds: string[];
  delivered?: 'landed' | 'terminal-failed';
  noOwner?: boolean | undefined;
};
export type MetricRun = {
  head?: string;
  fullSuite?: boolean;
  id: string;
  at: string;
  endedAt?: string | undefined;
  status: string;
  inputs: MetricInput[];
  wallMinutes?: number | undefined;
  runnerMinutes?: number | undefined;
  /** Physical execution identities deduplicate adopted shards, including retries. */
  executions?: { id: string; minutes: number }[];
  reusedFrom?: string | undefined;
  reuseKey?: string | undefined;
  started?: boolean | undefined;
};
export type MetricRecords = {
  surfaceGaps?: string[];
  observations?: MetricObservation[];
  diskSamples?: DiskSample[];
  moves: MetricMove[];
  submissions: MetricSubmission[];
  runs: MetricRun[];
  receipts: SelfMetricReceipt[];
  incompleteReceiptRecords?: number;
  checkRequests?: { id: string; at: string; runId: string; reused: boolean; reuseKey?: string | undefined }[];
  /** Earliest instant for which the producer guarantees complete collection. */
  coverage?: {
    overlaps?: string | undefined;
    overlapAnswers?: string | undefined;
    authority?: string | undefined;
    surfaces?: string | undefined;
    fullResults?: string | undefined;
    mirrorResults?: string | undefined;
    lifecycle?: string | undefined;
    mutations?: string | undefined;
    deliveries?: string | undefined;
    checkRequests?: string | undefined;
  };
  gaps: string[];
  landingKindsComplete?: boolean;
  lifecycleCoverageGaps?: string[];
  mutationCoverageGaps?: string[];
  source?: {
    kind: 'native' | 'hosted';
    revision?: number | string | undefined;
    collections?: Record<string, number>;
  };
};
/** Readers must pin their source revision and return records without writes or recovery. */
export interface SelfMetricsReader {
  read(): MetricRecords | Promise<MetricRecords>;
}
export type MetricPeriod = { from: string; to: string; asOf?: string | undefined };
export const minutesBetween = (start: string, end?: string) => {
  const duration = Date.parse(end ?? '') - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration / 60_000 : undefined;
};
