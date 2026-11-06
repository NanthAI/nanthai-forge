// SPDX-License-Identifier: Apache-2.0
export const poolFraction: number;
export const poolUnitMs: number;
export const poolMinShardMs: number;
export const maxPoolUnits: number;
export function planPool(
  groups: string[][],
  durations?: Record<string, number>,
  options?: { fraction?: number; unitMs?: number; minShardMs?: number; maxUnits?: number },
): number[][] | undefined;
export function validPool(groups: string[][], pool: unknown): boolean;
export function poolUnits(
  groups: string[][],
  pool: number[][],
): { unit: number; home: number; files: string[] }[];
export function keptFiles(groups: string[][], pool: number[][], index: number): string[];
export function poolArm(mode: string | undefined, runId: string): boolean;
