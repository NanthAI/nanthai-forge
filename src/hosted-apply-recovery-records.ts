// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { keptApplyRoot, keptEntrySchema } from './hosted-apply-kept.js';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { durableReplace, syncDirectory } from './state/durability.js';
import { workLocked } from './work-lock.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout, hostedLaneCheckoutMarkerSchema } from './hosted-lane-checkout-marker.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import { applySchema } from './hosted-sync-contract.js';
import { digest } from './hash.js';
import { parseNativeState } from './state/format.js';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
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
    /** Changed paths kept per round folder (keyed by its name), never a copy of the checkout. */
    rounds: z.record(z.string(), z.array(keptEntrySchema)).optional(),
    /** Epoch ms when the apply this recovery belongs to was confirmed; starts the retention clock. */
    confirmedAt: z.number().optional(),
  })
  .strict();
export function validBaseline(
  marker: Pick<z.infer<typeof hostedLaneCheckoutMarkerSchema>, 'operationId' | 'selection' | 'url'>,
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
/** Changed files only, in the outermost client cache: it outlives nested Lane eviction and sits
 * nowhere near the project root. Listed by status, removed a TTL after the apply is confirmed. */
export function recoveryDirectory(root: string, id: string) {
  return join(keptApplyRoot(root), z.uuid().parse(id));
}
export const blockedName = (id: string) => `apply-blocked-${z.uuid().parse(id)}.json`;
export const completedApplyName = (id: string) => `apply-completed-${z.uuid().parse(id)}.json`;
export const pathFor = (root: string, id: string) => join(clientCacheRoot(root), blockedName(id));
export const completedApplyPath = (root: string, id: string) =>
  join(clientCacheRoot(root), completedApplyName(id));
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
/** The checkout marker as it was when a sync or resolve retained its handoff, before any source IO.
 * If the live marker is lost before the local apply, recovery still has its exact baseline. */
const baselinePathFor = (root: string, id: string) =>
  join(clientCacheRoot(root), `apply-baseline-${z.uuid().parse(id)}.json`);
// The immutable State already lives in source storage. Scope roots are explicit inputs needed
// for later opens; a sparse checkout needs only one bit per State path to restore its selection.
const pinSchema = hostedLaneCheckoutMarkerSchema.omit({ state: true, materialized: true }).extend({
  present: z.string().nullable(),
});
const applyPinPath = (root: string, id: string) =>
  join(clientCacheRoot(root), `apply-pin-${z.uuid().parse(id)}.json`);
/** Under the caller's work lock. Keep the first baseline, including older full-copy journals. */
export function retainApplyBaseline(root: string, id: string) {
  const path = applyPinPath(root, id);
  if (checkoutPathExists(baselinePathFor(root, id)) || checkoutPathExists(path)) return;
  const marker = markerAt(root);
  if (!marker) return;
  const { state, materialized, ...metadata } = marker;
  let present: string | null = null;
  if (materialized.length < state.files.length) {
    const selected = new Set(materialized);
    const bits = Buffer.alloc(Math.ceil(state.files.length / 8));
    state.files.forEach((file, index) => {
      if (selected.has(file.path)) {
        const byte = index >> 3;
        bits.writeUInt8(bits.readUInt8(byte) | (1 << (index & 7)), byte);
      }
    });
    present = bits.toString('base64');
  }
  durableReplace(path, JSON.stringify({ ...metadata, present }));
}
/** Used only after current Lane authority has been checked and the live baseline is missing. */
export async function restoreBaselinePin(
  root: string,
  request: z.infer<typeof applySchema>,
  transport: CheckoutObjectTransport,
) {
  const path = applyPinPath(root, request.operationId);
  if (!checkoutPathExists(path)) return undefined;
  const { present, ...metadata } = pinSchema.parse(read(path));
  if (!validBaseline(metadata, request)) return undefined;
  const head = metadata.selection.head;
  const cache = new HostedCheckoutCache(clientCacheRoot(root), transport);
  const fetched = await cache.ensure(
    metadata.operationId === request.operationId ? [head] : [head, request.lane.head],
  );
  const bytes = readFileSync(join(cache.objects, head));
  invariant(digest(bytes) === head, 'INVALID_NATIVE_SOURCE', 'Recovery State bytes changed.');
  const state = parseNativeState(bytes);
  const bits = present === null ? null : Buffer.from(present, 'base64');
  invariant(
    !bits || bits.length === Math.ceil(state.files.length / 8),
    'INVALID_NATIVE_SOURCE',
    'Recovery State paths differ from the retained checkout.',
  );
  const materialized = state.files
    .filter((_, index) => !bits || (bits.readUInt8(index >> 3) & (1 << (index & 7))) !== 0)
    .map(file => file.path);
  return {
    marker: hostedLaneCheckoutMarkerSchema.parse({ ...metadata, state, materialized }),
    cache,
    fetched: fetched.includes(head) ? head : undefined,
  };
}
export function clearApplyBaseline(root: string, id: string) {
  rmSync(baselinePathFor(root, id), { force: true });
  rmSync(applyPinPath(root, id), { force: true });
}
/** Keep the original replay identity and handoff, without the now-unused State and paths. */
export function completeLocalApply(root: string, id: string) {
  const path = pathFor(root, id);
  if (!checkoutPathExists(path)) return;
  const cache = clientCacheRoot(root);
  workLocked(join(cache, 'lock'), () => {
    if (!checkoutPathExists(path)) return;
    const completed = completedApplyPath(root, id);
    if (!checkoutPathExists(completed)) {
      const { request, handoff } = savedSchema.parse(read(path));
      durableReplace(completed, JSON.stringify({ request, handoff }));
    }
    // The blocked record is the cleanup trigger, including after power loss.
    clearApplyBaseline(root, id);
    syncDirectory(cache);
    rmSync(path, { force: true });
    syncDirectory(cache);
  });
}
function retainedApplyBaseline(root: string, request: z.infer<typeof applySchema>) {
  try {
    const marker = hostedLaneCheckoutMarkerSchema.parse(read(baselinePathFor(root, request.operationId)));
    return validBaseline(marker, request) ? marker : undefined;
  } catch {
    return undefined;
  }
}
/** The live checkout already holds this apply's target pins (another command, such as `open`,
 * installed them) or a newer version of the same Lane: nothing is left to install or move. */
export function checkoutAhead(root: string, input: z.infer<typeof applySchema>): 'target' | 'newer' | null {
  const marker = markerAt(root),
    lane = input.lane;
  if (
    !marker ||
    // This apply's own install is finished by replaying it, never reported as already there.
    marker.operationId === input.operationId ||
    marker.url !== input.url ||
    marker.selection.projectId !== lane.projectId ||
    marker.selection.laneId !== lane.laneId
  )
    return null;
  const { head, version, sourceVersion } = marker.selection;
  if (head === lane.head && version === lane.version && sourceVersion === lane.sourceVersion) return 'target';
  return version > lane.version && sourceVersion >= lane.sourceVersion ? 'newer' : null;
}
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
    ...(error.recovery?.superseded ? { superseded: error.recovery.superseded } : {}),
    more: false,
    next,
    command: hostedRecoveryCommand(root, next.action, { applyOperationId: request.operationId }),
  };
  workLocked(join(cache, 'lock'), () => {
    if (checkoutPathExists(completedApplyPath(root, request.operationId))) return;
    // The copy taken at handoff stands in only for a marker that is gone or unreadable. A live
    // marker that is newer (an `open` while the sync waited) is never rolled back to it.
    const marker = markerAt(root),
      baseline =
        prior?.baseline ??
        (marker
          ? validBaseline(marker, request)
            ? marker
            : undefined
          : retainedApplyBaseline(root, request));
    durableReplace(path, JSON.stringify({ request, handoff: handoff ?? prior?.handoff ?? null, baseline }));
    const directory = recoveryDirectory(root, request.operationId),
      receiptPath = join(directory, 'receipt.json');
    if (checkoutPathExists(receiptPath)) {
      const receipt = receiptSchema.parse(read(receiptPath));
      // A new local edit during a previous recovery is another preservation round,
      // not an unchanged retry against the same persistent obstruction. A Lane that moved on is
      // not a local edit: nothing will be installed, so nothing more needs to move.
      if (receipt.restored && !error.recovery?.superseded) {
        receipt.roundBackup = join(directory, `files-${randomUUID()}`);
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
