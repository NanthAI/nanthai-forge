// SPDX-License-Identifier: Apache-2.0
import type { CoverageInput, CoverageShadow } from './test-coverage.mjs';
export type SelectionReason = {
  kind: string;
  changedPath?: string;
  chain?: string[];
  edges?: string[];
  detail?: string;
};
export type TestSelection = {
  scope: string;
  reason: string;
  tests: string[];
  affectedTests?: string[];
  reasons?: Record<string, SelectionReason>;
  coverage?: CoverageShadow;
};
/** Installed selector contract used by native runner queue admission. */
export function standardSelection(input: {
  files: Map<string, string>;
  coverage?: CoverageInput | undefined;
  paths?: string[];
  semanticTests?: string[];
  interaction?: unknown;
  mainCheck?: unknown;
  env?: Record<string, string | undefined>;
}): TestSelection;

export function selectionSourcePath(path: string): boolean;

export function selectTests(input: { files: Map<string, string>; paths: string[] }): TestSelection;
export function selectImpactPair(files: Map<string, string>, comparisons: string[][]): TestSelection[];
export const smokeTests: string[];
export function documentation(path: string): boolean;
