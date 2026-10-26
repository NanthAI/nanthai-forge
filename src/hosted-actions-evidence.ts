// SPDX-License-Identifier: Apache-2.0
import { checkPin, type HostedCheckRun } from './hosted-check.js';
import { hostedCheckCallbackSchema, type HostedCheckCallback } from './hosted-check-evidence.js';
import type { HostedActionsMapping } from './hosted-actions.js';
import { invariant } from './errors.js';

/** Stable event identity survives a lost terminal/shard acknowledgement. */
export function actionsCallback(
  run: HostedCheckRun,
  mapping: HostedActionsMapping,
  result: HostedCheckCallback['result'],
): HostedCheckCallback {
  invariant(
    run.plan && mapping.export && mapping.run !== null,
    'EVIDENCE_CHANGED',
    'Retain exact Actions execution pins.',
  );
  const hash = checkPin({ run: run.id, fence: run.fence, commit: mapping.export.commit, result });
  return hostedCheckCallbackSchema.parse({
    schema: 1,
    eventId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
    projectId: run.projectId,
    runId: run.id,
    operationId: run.request.operationId,
    authorityEpoch: run.request.authorityEpoch,
    fence: run.fence,
    provider: 'github-actions',
    executionId: String(mapping.run),
    head: run.request.expectedHead,
    definition: run.request.expectedDefinition,
    configuration: run.request.expectedConfiguration,
    environmentFingerprint: run.request.expectedEnvironment,
    runtime: run.plan.runtime,
    planDigest: run.planDigest,
    lockfile: run.plan.lockfile,
    selection: run.plan.selection,
    result,
  });
}
