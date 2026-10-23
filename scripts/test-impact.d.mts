// SPDX-License-Identifier: Apache-2.0
import type { CoverageInput, CoverageShadow } from './test-coverage.mjs';
/** Installed selector contract used by native runner queue admission. */
export function standardSelection(input: {
  files: Map<string, string>;
  coverage?: CoverageInput | undefined;
  paths?: string[];
  interaction?: unknown;
  mainCheck?: unknown;
  env?: Record<string, string | undefined>;
}): { scope: string; reason: string; tests: string[]; coverage?: CoverageShadow };

export function selectionSourcePath(path: string): boolean;

export function selectTests(input: { files: Map<string, string>; paths: string[] }): {
  scope: string;
  reason: string;
  tests: string[];
};
