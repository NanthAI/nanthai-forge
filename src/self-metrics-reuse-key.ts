// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
/** Reporting key, not permission to reuse evidence. Restart pins and Node patches are excluded. */
export function selfMetricReuseKey(input: {
  tree?: string | undefined;
  definition?: string | undefined;
  lockfile?: string | undefined;
  node?: string | undefined;
  declaredInputs?: unknown;
}) {
  const node = /^v?(\d+\.\d+)(?:\.|$)/.exec(input.node ?? '')?.[1];
  if (!input.tree || !input.definition || !input.lockfile || !node || input.declaredInputs === undefined)
    return;
  return digest(
    canonicalPayload({
      tree: input.tree,
      definition: input.definition,
      lockfile: input.lockfile,
      node,
      declaredInputs: input.declaredInputs,
    }),
  );
}
