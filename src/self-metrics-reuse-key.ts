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
/** Hosted plan key: exact tree, definition, lockfile, runtime and environment pins
 * plus the selected tests. The runtime pin includes the Node patch, so this
 * can undercount reuse opportunities but never merges different evidence. */
export function hostedRunReuseKey(
  plan:
    | {
        head: string;
        definition: string;
        lockfile: string;
        runtime: string;
        environmentFingerprint: string;
        selection: { sha256: string };
      }
    | null
    | undefined,
) {
  if (!plan) return null;
  return digest(
    canonicalPayload({
      tree: plan.head,
      definition: plan.definition,
      lockfile: plan.lockfile,
      runtime: plan.runtime,
      environment: plan.environmentFingerprint,
      selection: plan.selection.sha256,
    }),
  );
}
