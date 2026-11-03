// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot, clientCacheRoot, retainedRootSibling } from './root-paths.js';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout, hostedLaneCheckoutMarkerSchema } from './hosted-lane-checkout-marker.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import { applySchema } from './hosted-sync-contract.js';
const handoffSchema = z
  .object({
    operationId: z.uuid(),
    applyOperationId: z.uuid(),
    action: z.enum(['sync', 'resolve']),
    command: z.record(z.string(), z.unknown()),
  })
  .strict();
export const receiptSchema = z
  .object({
    marker: hostedLaneCheckoutMarkerSchema,
    restored: z.boolean(),
    preservedAt: z.string(),
    undo: z.string(),
    priorPreservedAt: z.string().optional(),
    pendingPriorPreservedAt: z.string().optional(),
    roundBackup: z.string().optional(),
    additionalPreservedAt: z.array(z.string()).optional(),
    baselineStage: z.string().optional(),
  })
  .strict();
export function validBaseline(
  marker: z.infer<typeof hostedLaneCheckoutMarkerSchema>,
  request: z.infer<typeof applySchema>,
) {
  const pins = marker.operationId === request.operationId ? request.lane : request.from;
  return (
    marker.url === request.url &&
    marker.selection.projectId === request.lane.projectId &&
    marker.selection.laneId === request.from.laneId &&
    marker.selection.head === pins.head &&
    marker.selection.version === pins.version &&
    marker.selection.sourceVersion === pins.sourceVersion
  );
}
/** Preserved user bytes must outlive GC of even the outermost nested Lane cache. */
export function recoveryDirectory(root: string, id: string) {
  return retainedRootSibling(root, `.kept-apply-${z.uuid().parse(id)}`);
}
export const pathFor = (root: string, id: string) =>
  join(clientCacheRoot(root), `apply-blocked-${z.uuid().parse(id)}.json`);
export const read = (path: string): unknown => {
  const stat = lstatSync(path);
  invariant(stat.isFile() && stat.nlink === 1, 'UNSAFE_PATH', 'Recovery receipt must be a private file.');
  return JSON.parse(readFileSync(path, 'utf8'));
};
export const savedSchema = z
  .object({
    request: applySchema,
    handoff: handoffSchema.nullable(),
    baseline: hostedLaneCheckoutMarkerSchema.optional(),
  })
  .strict();
export function markerAt(root: string) {
  try {
    return readHostedLaneCheckout(root);
  } catch {
    return null;
  }
}
/** Source-action replay can arrive while recovery has moved its local marker. */
export function retainedLocalApplyBlocked(root: string, id: string | undefined) {
  if (!id || !checkoutPathExists(pathFor(root, id))) return null;
  const saved = savedSchema.parse(read(pathFor(root, id)));
  invariant(
    saved.request.operationId === id,
    'WORK_OPERATION_CHANGED',
    'Retain the same local apply identity.',
  );
  return localApplyBlocked(
    root,
    saved.request,
    new ForgeError(
      'WORK_STALE',
      'The retained local apply is awaiting checkout baseline publication.',
      undefined,
      { obstruction: { kind: 'baseline-mismatch', path: '.forge/hosted-lane.json' } },
    ),
  );
}
export function localApplyBlocked(root: string, input: unknown, error: ForgeError) {
  root = canonicalRoot(root);
  const request = applySchema.parse(input),
    cache = clientCacheRoot(root);
  const handoffPath = join(cache, 'sync-handoff.json');
  const path = pathFor(root, request.operationId),
    prior = checkoutPathExists(path) ? savedSchema.parse(read(path)) : null,
    currentHandoff = checkoutPathExists(handoffPath) ? handoffSchema.parse(read(handoffPath)) : null,
    handoff =
      currentHandoff?.applyOperationId === request.operationId ? currentHandoff : (prior?.handoff ?? null);
  const next = { action: 'recover-apply', applyOperationId: request.operationId };
  const recovery = {
    phase: 'local-apply',
    status: 'blocked',
    sourceCompleted: true,
    operationId: handoff?.operationId ?? request.operationId,
    applyOperationId: request.operationId,
    root,
    laneId: request.lane.laneId,
    from: request.from,
    to: request.lane,
    blockers: [error.recovery?.obstruction ?? { kind: 'local-obstruction', path: null }],
    more: false,
    next,
    command: hostedRecoveryCommand(root, next.action, { applyOperationId: request.operationId }),
  };
  workLocked(join(cache, 'lock'), () => {
    const marker = markerAt(root),
      baseline = prior?.baseline ?? (marker && validBaseline(marker, request) ? marker : undefined);
    durableReplace(path, JSON.stringify({ request, handoff: handoff ?? prior?.handoff ?? null, baseline }));
    const directory = recoveryDirectory(root, request.operationId),
      receiptPath = join(directory, 'receipt.json');
    if (checkoutPathExists(receiptPath)) {
      const receipt = receiptSchema.parse(read(receiptPath));
      // A new local edit during a previous recovery is another preservation round,
      // not an unchanged retry against the same persistent obstruction.
      if (receipt.restored) {
        receipt.roundBackup = join(directory, `checkout-${randomUUID()}`);
        receipt.additionalPreservedAt = [...(receipt.additionalPreservedAt ?? []), receipt.roundBackup];
        receipt.restored = false;
        durableReplace(receiptPath, JSON.stringify(receipt));
      }
    }
  });
  return new ForgeError(
    error.code,
    `${error.message} Source already completed; only local apply is pending. Run recover-apply to preserve the checkout outside the source tree and resume this pinned apply.`,
    undefined,
    recovery,
  );
}
