// SPDX-License-Identifier: Apache-2.0
export type CoverageArtifact = {
  version: number;
  head: string;
  full: boolean;
  digests: Record<string, string>;
  tests: Record<string, string[]>;
};
export type CoverageInput = { artifact: CoverageArtifact; head: string; age: number };
export function coverageArtifact(input: {
  head: string;
  files: Map<string, string>;
  tests: string[];
  lines: Iterable<string>;
}): CoverageArtifact | null;

export type CoverageShadow = {
  mode: 'shadow';
  head?: string;
  age?: number;
  currentCount: number;
  coverageCount: number;
  tests: string[];
  fallback: string | null;
};
