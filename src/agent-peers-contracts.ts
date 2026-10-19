// SPDX-License-Identifier: Apache-2.0
import { CODE_FILE } from './contract-exports.js';
import { contractDelta, dependentOn, type ContractChange, type ContractSource } from './contract-deps.js';
import { pathsOverlap } from './coordination-paths.js';
import type { PeersCache } from './agent-peers-cache.js';

type FileRef = { path: string; blob: string };
export type LandedContracts = { head: string; by?: string; changes: ContractChange[]; more?: number };
export type ContractDependent = {
  lane: string;
  actor?: string;
  intent?: string;
  state: string;
  uses: ContractChange[];
  more?: number;
};
/** Code files of `files` inside any scope path: the files a Lane edits or claims. */
export const scopedCode = (files: FileRef[], scope: string[]) =>
  files.filter(file => CODE_FILE.test(file.path) && scope.some(item => pathsOverlap(file.path, item)));

/** Contract delta of one accepted main move, memoized per exact source pair. */
export function moveDelta(
  source: ContractSource,
  cache: PeersCache,
  before: string,
  after: string,
  files: () => [FileRef[], FileRef[]],
): ContractChange[] {
  const key = `contract-delta-v1:${before}:${after}`;
  const known = cache.read<ContractChange[]>(key);
  if (known) return known;
  const [a, b] = files(),
    delta = contractDelta(source, a, b);
  cache.write(key, delta);
  return delta;
}
/** Contracts changed by main that this Lane's edited or claimed code uses. */
export const usedByLane = (
  source: ContractSource,
  delta: ContractChange[],
  mine: FileRef[],
  everything: FileRef[],
) => dependentOn(source, mine, everything, delta);
