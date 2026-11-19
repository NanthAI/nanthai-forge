// SPDX-License-Identifier: Apache-2.0
export const browserTests: string[];
export function isBrowserTest(file: string): boolean;
export function browserFiles(files: Map<string, string> | Set<string> | string[]): string[];
export function browserChange(
  paths: string[] | undefined,
  files?: Map<string, string>,
  graphCache?: object,
): boolean;
export function browserSelection<T extends { tests: string[] }>(
  selection: T,
  paths: string[] | undefined,
  files: Map<string, string>,
  graphCache?: object,
): T & { browser?: boolean };
export function browserGroups(
  groups: string[][],
  enabled: boolean,
  durations?: Record<string, number>,
): string[][];
export function browserShard(groups: string[][], enabled: boolean): number;
