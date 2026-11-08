// SPDX-License-Identifier: Apache-2.0
import { buildPackageGraph } from './package-graph.js';
import { packagePlacement } from './package-placement.js';

/** The selection field for one checked head (src/package-placement.ts): manifests read from the
 * verified source, no repository code. Any failure pins nothing, so every manifest stays global. */
export function checkedPackagePlacement(paths: Iterable<string>, read: (path: string) => string | undefined) {
  try {
    const pin = packagePlacement(buildPackageGraph(paths, read));
    return pin ? { packagePlacement: pin } : {};
  } catch {
    return {};
  }
}
