// SPDX-License-Identifier: Apache-2.0
/** Installed selector contract used by native runner queue admission. */
export function standardSelection(input: {
  files: Map<string, string>;
  paths?: string[];
  interaction?: unknown;
  mainCheck?: unknown;
  env?: Record<string, string | undefined>;
}): { scope: string; reason: string; tests: string[] };
