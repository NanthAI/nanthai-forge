// SPDX-License-Identifier: Apache-2.0
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
};
export type MetricSubmission = {
  id: string;
  entryId: string;
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
  moves: MetricMove[];
  submissions: MetricSubmission[];
  runs: MetricRun[];
  receipts: SelfMetricReceipt[];
  incompleteReceiptRecords?: number;
  checkRequests?: { id: string; at: string; runId: string; reused: boolean; reuseKey?: string | undefined }[];
  /** Earliest instant for which the producer guarantees complete collection. */
  coverage?: {
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
