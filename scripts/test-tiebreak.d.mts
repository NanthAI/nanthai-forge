// SPDX-License-Identifier: Apache-2.0
export function changeSalt(paths: string[]): string;
export function stableKey(salt: string, test: string): string;
export function relevanceFor(input: {
  files: Map<string, string>;
  changed: string[];
  recent?: Set<string>;
}): (test: string) => [number, number, number];
export function compareRelevance(a: readonly number[], b: readonly number[]): number;
