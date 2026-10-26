// SPDX-License-Identifier: Apache-2.0
export { selectionSourcePath } from '../scripts/test-impact.mjs';
import { standardSelection } from '../scripts/test-impact.mjs';
import { contractTestPath } from './intent-test-contract.js';
/** Same conservative selector as checks, including newly added and changed tests. */
export function intentContractSelection(files: Map<string, string>, paths: string[]) {
  const selection = standardSelection({ files, paths, env: { FORGE_CHECK_SCOPED: '1' } });
  const available = [...files.keys()].filter(path => contractTestPath.safeParse(path).success);
  const required = [
    ...new Set([...selection.tests, ...paths.filter(path => available.includes(path))]),
  ].sort();
  return { ...selection, tests: required, available };
}
