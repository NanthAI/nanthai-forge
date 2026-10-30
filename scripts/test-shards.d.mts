// SPDX-License-Identifier: Apache-2.0
export type TimingHistory = {
  version: number;
  files: Record<string, { durationMs: number; updatedAt: string }>;
  runs: string[];
};
export const timingHistoryLimits: { files: number; bytes: number; runs: number };
export function parseTimingHistory(text: string): TimingHistory;
export function emptyHistory(): TimingHistory;
export function timingDurations(history: TimingHistory): Record<string, number>;
export function updateTimingHistory(
  history: TimingHistory,
  input: {
    runId: string;
    endedAt: string;
    files: string[];
    durations: Record<string, number>;
  },
): TimingHistory;
export function testDuration(file: string, durations?: Record<string, number>): number;
export function shardDuration(files: string[], durations?: Record<string, number>, workers?: number): number;
export function partitionTests(
  files: string[],
  count: number,
  durations?: Record<string, number>,
  workers?: number,
): string[][];
export const shardJobOverheadMs: number;
export function timedShards(
  files: string[],
  durations?: Record<string, number>,
  options?: { full?: boolean; concurrencyBudget?: number; activeChecks?: number; jobCap?: number },
): string[][];
