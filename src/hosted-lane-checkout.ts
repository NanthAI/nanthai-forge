// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { preserveMisplacedReadCaches } from './hosted-legacy-cache.js';
import { preserveLegacyCacheUse } from './client-cache-use.js';
import { planCheckoutPreservation, preserveCheckoutArtifacts } from './hosted-checkout-preserve.js';
import { sourceTree } from './source-tree.js';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { hostedLaneSelectionSchema, type HostedLaneSelection } from './hosted-lane.js';
import type { NativeFile } from './state/format.js';
import { parseNativeState } from './state/format.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { durableReplace, syncDirectory } from './state/durability.js';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { readSource } from './files.js';
import { workLocked } from './work-lock.js';
import { indexInstalledFiles, readCheckoutStatIndex, writeCheckoutStatIndex } from './checkout-stat-index.js';
import { stateText, textAttributeFiles, worktreeText } from './checkout-text.js';
import type { CheckoutChange } from './hosted-checkout-clean.js';
import {
  checkoutDelta,
  deltaDisplacement,
  deltaJournalName,
  deltaObstructed,
  deltaObstructionError,
  journalCheckoutDelta,
} from './hosted-checkout-delta.js';
import { retainedDeltaBackups, settleCheckoutDelta } from './hosted-checkout-delta-settle.js';
import { sweepCheckoutStages } from './hosted-checkout-delta-pending.js';
import { sweepKeptApply } from './hosted-apply-kept.js';
import { disposePriorCheckout } from './hosted-checkout-dispose.js';
import { refuseDeltaConflict } from './hosted-checkout-carry.js';
import { withCheckoutOpenMetrics, type CheckoutOpenMetrics } from './checkout-open-metrics.js';
import { checkoutIo } from './checkout-io.js';
import { smallCheckout } from './checkout-workload.js';
import { withCheckoutMaterialization, withCheckoutWritePass } from './checkout-materialization.js';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
import { machineObjectsDirectory } from './machine-object-store.js';
import {
  checkoutPathExists,
  cleanHostedCheckout,
  stageHostedFiles,
  flushHostedFiles,
  flushHostedCheckoutFiles,
  interruptedCheckoutDamage,
  rebuildCheckoutFiles,
} from './hosted-checkout-files.js';
import {
  hostedLaneCheckoutSchema,
  hostedLaneMarkerName,
  readHostedLaneCheckout,
  type HostedLaneCheckoutMarker,
} from './hosted-lane-checkout-marker.js';
import { parseHostedResponse } from './hosted-response.js';
import { withSubmoduleCheckouts } from './submodule-checkout.js';
import { checkoutMissing } from './checkout-missing.js';
export interface LaneTransport extends CheckoutObjectTransport {
  select(laneId: string): Promise<HostedLaneSelection>;
}
const operationSchema = z
  .object({
    request: hostedLaneCheckoutSchema,
    selection: hostedLaneSelectionSchema,
    complete: z.boolean(),
    previousMarker: z.string().nullable(),
  })
  .strict();
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
/** What a caller already holds from the server for this exact checkout (one-trip sync). */
export type CheckoutPrepared = {
  /** The Lane selection the server returned to this caller for this operation moments ago (a sync
   * result): it stands in for the opening access read. Reauthorization after a transfer stays. */
  selection?: HostedLaneSelection;
  /** The selected State's exact bytes, rebuilt and digest-checked by the caller. */
  state?: { id: string; bytes: Uint8Array };
};
/** Thin editing directory; no native Work owner, Channel writer or acceptance authority. */
async function checkout(
  root: string,
  input: unknown,
  transport: LaneTransport,
  sharedObjects: string | undefined,
  metrics: CheckoutOpenMetrics,
  prepared: CheckoutPrepared = {},
) {
  const request = hostedLaneCheckoutSchema.parse(input);
  root = canonicalRoot(root);
  const cache = new HostedCheckoutCache(
      clientCacheRoot(root),
      transport,
      sharedObjects,
      machineObjectsDirectory(),
      true,
    ),
    lock = join(cache.root, 'lock'),
    previous = join(cache.root, 'previous'),
    receiptPath = join(cache.root, `${request.operationId}.json`);
  metrics.transfer = () => ({
    downloadedObjects: cache.downloadedObjects,
    downloadedBytes: cache.downloadedBytes,
    packObjects: cache.packObjects,
    packBytes: cache.packBytes,
    downloadMs: cache.downloadMs,
    sourcePack: cache.sourcePack,
  });
  const preservationPath = join(cache.root, `preserve-${request.operationId}.json`);
  const recoveryPath = join(cache.root, `legacy-cache-recovery-${request.operationId}.json`);
  const preserveCaches = (files: readonly { path: string }[] = []) => {
    preserveMisplacedReadCaches(
      root,
      files,
      receipt => {
        const moved = (checkoutPathExists(recoveryPath) ? json(recoveryPath) : []).filter(
          (item: { preservedAt: string }) => checkoutPathExists(item.preservedAt),
        );
        if (!moved.some((item: { preservedAt: string }) => item.preservedAt === receipt.preservedAt))
          moved.push(receipt);
        else
          moved[
            moved.findIndex((item: { preservedAt: string }) => item.preservedAt === receipt.preservedAt)
          ] = receipt;
        durableReplace(recoveryPath, JSON.stringify(moved));
      },
      checkoutPathExists(recoveryPath) ? json(recoveryPath) : [],
    );
  };
  const markerDigest = () => {
    const bytes = checkoutPathExists(root)
      ? readSource(root, `.forge/${hostedLaneMarkerName}`, Number.MAX_SAFE_INTEGER)
      : null;
    return bytes ? digest(bytes) : null;
  };
  const recover = () => {
    if (checkoutPathExists(previous) && !checkoutPathExists(root)) renameSync(previous, root);
    // An interrupted in-place install finishes from its durable private stage, or rolls back.
    const settled = settleCheckoutDelta(root, cache.root);
    if (settled?.conflict) throw settled.conflict;
  };
  const identity = (selection: HostedLaneSelection) => {
    invariant(
      selection.projectId === request.projectId && selection.laneId === request.laneId,
      'PROJECT_UNAVAILABLE',
      'Select this project and Lane.',
    );
  };
  const materializedFiles = (marker: HostedLaneCheckoutMarker | null) => {
    const paths = new Set(marker?.materialized ?? []);
    return marker?.state.files.filter(file => paths.has(file.path)) ?? [];
  };
  const preserveArtifacts = (target: NativeFile[]) =>
    preserveCheckoutArtifacts(root, previous, preservationPath, () => {
      const old = readHostedLaneCheckout(previous);
      const bytes = readSource(previous, `.forge/${hostedLaneMarkerName}`, Number.MAX_SAFE_INTEGER);
      invariant(
        (bytes ? digest(bytes) : null) === operationSchema.parse(json(receiptPath)).previousMarker,
        'WORK_CONFLICT',
        'The prior checkout baseline changed; both copies are preserved.',
      );
      return cleanHostedCheckout(previous, materializedFiles(old), hostedLaneMarkerName, Boolean(old), {
        target,
      });
    });
  /** Retire the old checkout once publication is durable. Only exact baseline bytes are removed;
   * anything recreated in the old root before the rename lands is held and reported (B1). */
  const disposePrevious = (previousMarker: string | null, index = readCheckoutStatIndex(root)) => {
    if (!checkoutPathExists(previous)) return;
    const bytes = readSource(previous, `.forge/${hostedLaneMarkerName}`, Number.MAX_SAFE_INTEGER);
    // A prior marker that is not the one this operation observed vouches for nothing.
    const old = bytes && digest(bytes) === previousMarker ? readHostedLaneCheckout(previous) : null;
    disposePriorCheckout({
      root,
      cacheRoot: cache.root,
      previous,
      files: materializedFiles(old),
      markerName: hostedLaneMarkerName,
      index,
    });
  };
  const baseline = () => {
    let marker;
    try {
      marker = checkoutPathExists(root) ? readHostedLaneCheckout(root) : null;
    } catch (error) {
      if (!request.previous) throw error;
      throw new ForgeError(
        'WORK_STALE',
        'The local checkout marker changed before pinned apply.',
        undefined,
        { obstruction: { kind: 'baseline-mismatch', path: `.forge/${hostedLaneMarkerName}` } },
      );
    }
    if (marker) {
      identity(marker.selection);
      invariant(
        marker.url === request.url,
        'PROJECT_UNAVAILABLE',
        'This checkout belongs to another deployment.',
      );
    }
    return marker;
  };
  // Access is checked even on verified cache hits and completed original-operation retries.
  const observed =
    prepared.selection ??
    parseHostedResponse(hostedLaneSelectionSchema, await transport.select(request.laneId));
  identity(observed);
  let cooperative = true;
  return withCheckoutMaterialization(
    cache.root,
    async () => {
      let operation = await checkoutIo(
        async () =>
          workLocked(lock, () => {
            recover();
            if (checkoutPathExists(receiptPath)) {
              const original = operationSchema.parse(json(receiptPath));
              invariant(
                canonicalPayload(original.request) === canonicalPayload(request),
                'WORK_OPERATION_CHANGED',
                'Retry the original Lane checkout request.',
              );
              // A crash after the completion receipt can leave the old checkout behind.
              if (original.complete) disposePrevious(original.previousMarker);
              // A completed checkout replays only while this folder still holds the Lane (Issue
              // ca49dc6c). Its pins may be older than the Lane's saves, so it is never reinstalled.
              if (original.complete && !baseline()) throw checkoutMissing(root, request.laneId);
              return original;
            }
            const current = {
              head: observed.head,
              version: observed.version,
              sourceVersion: observed.sourceVersion,
            };
            if (request.expected && canonicalPayload(request.expected) !== canonicalPayload(current))
              // Nothing was applied yet. The exact pins are named so a caller can say what superseded
              // them; the checkout never switches to the newer head on its own.
              throw new ForgeError(
                'WORK_STALE',
                'The Lane changed from its expected source pins.',
                undefined,
                {
                  obstruction: { kind: 'superseded', path: null },
                  superseded: { expected: request.expected, current },
                },
              );
            const marker = baseline();
            if (
              !(
                !request.previous ||
                (marker &&
                  canonicalPayload(request.previous) ===
                    canonicalPayload({
                      head: marker.selection.head,
                      version: marker.selection.version,
                      sourceVersion: marker.selection.sourceVersion,
                    }))
              )
            )
              throw new ForgeError(
                'WORK_STALE',
                'The client baseline changed before applying the pinned sync result.',
                undefined,
                { obstruction: { kind: 'baseline-mismatch', path: `.forge/${hostedLaneMarkerName}` } },
              );
            // A sync apply onto a trusted baseline judges unsaved changes (Forge metadata included)
            // against the incoming delta at publication, under this lock, in its one tree walk (in
            // place it carries edits to paths it does not touch, as Git does). Any other checkout
            // refuses a local change now, before anything is downloaded.
            if (!(marker && request.previous))
              cleanHostedCheckout(root, materializedFiles(marker), hostedLaneMarkerName, Boolean(marker), {
                deferExtras: true,
                index: readCheckoutStatIndex(root),
              });
            const next = { request, selection: observed, complete: false, previousMarker: markerDigest() };
            durableReplace(receiptPath, JSON.stringify(next));
            return next;
          }),
        'durability',
      );
      const selection = operation.selection;
      identity(selection);
      const displaced = () => {
        const kept = retainedDeltaBackups(cache.root);
        return kept.length
          ? {
              displacedRecovery: kept,
              warning: `Local bytes that differed from the checkout baseline were moved out of the working tree during an interrupted apply and kept at ${kept.join(', ')}. Copy back what you need, then delete the folder.`,
            }
          : {};
      };
      const result = (replayed: boolean) => ({
        ...selection,
        root,
        downloadedObjects: cache.downloadedObjects,
        downloadedBytes: cache.downloadedBytes,
        ...(cache.sourcePack
          ? { sourcePack: cache.sourcePack, packObjects: cache.packObjects, packBytes: cache.packBytes }
          : {}),
        ...(cache.machineObjects ? { machineObjects: cache.machineObjects } : {}),
        replayed,
        ...(checkoutPathExists(recoveryPath) ? { localRecovery: json(recoveryPath) } : {}),
        ...displaced(),
      });
      if (operation.complete) {
        metrics.replayed = true;
        return result(true);
      }
      // Direct machine hits are verified once, where they are used: the State bytes
      // here, and every installed file as it is cloned into the stage.
      const readState = () => checkoutIo(async () => readFileSync(join(cache.objects, selection.head)));
      const held =
        prepared.state?.id === selection.head && digest(prepared.state.bytes) === selection.head
          ? prepared.state.bytes
          : null;
      if (!held)
        await metrics.measure('cacheVerify', () => cache.ensure([selection.head], { installVerifies: true }));
      let stateBytes = held ?? (await readState());
      if (digest(stateBytes) !== selection.head && cache.repairable) {
        await metrics.measure('cacheVerify', () => cache.repair([selection.head]));
        stateBytes = await readState();
      }
      invariant(
        digest(stateBytes) === selection.head,
        'INVALID_NATIVE_SOURCE',
        'Selected State bytes changed.',
      );
      const state = parseNativeState(stateBytes);
      transport.selectState?.(selection.head, state.files);
      const { before, beforeDigest } = await checkoutIo(async () =>
        workLocked(lock, () => {
          recover();
          return { before: baseline(), beforeDigest: markerDigest() };
        }),
      );
      const scope =
        request.paths === undefined || before?.scope === null
          ? null
          : [...new Set([...(before?.scope ?? []), ...request.paths])].sort();
      const retained = new Set(before?.materialized ?? []);
      const files = state.files.filter(
        file =>
          scope === null ||
          retained.has(file.path) ||
          scope.some(path => file.path === path || file.path.startsWith(`${path}/`)),
      );
      metrics.files = files.length;
      // A trusted installed baseline changes in place: only paths whose bytes or mode differ are
      // fetched, verified, staged and flushed. No baseline, a file/directory flip or a spelling-only
      // rename stages all (a private Lane directory swaps whole). An untracked obstruction refuses
      // here, before anything is fetched or staged; the clean check would refuse it after staging.
      const installedHere = before?.operationId === request.operationId;
      const delta = installedHere
        ? { install: [], remove: [] }
        : before
          ? checkoutDelta(materializedFiles(before), files)
          : null;
      const obstruction =
        delta && !installedHere ? await checkoutIo(async () => deltaObstructed(root, delta)) : null;
      if (obstruction) throw deltaObstructionError(obstruction);
      const staged = delta ? delta.install : files;
      // This operation published a first (whole-stage) tree but did not complete: files a crash tore
      // are rebuilt. An in-place delta stays durable through its journal and needs none.
      const repairs =
        installedHere && operation.previousMarker === null
          ? await checkoutIo(async () =>
              interruptedCheckoutDamage(
                root,
                files,
                readCheckoutStatIndex(root).entries,
                worktreeText(root, state.files),
              ),
            )
          : [];
      // The State's `.gitattributes` decide working line endings (44ef42b9); their blobs join this ensure.
      await metrics.measure('cacheVerify', () =>
        cache.ensure(
          [...staged, ...repairs, ...textAttributeFiles(state.files)].map(file => file.blob),
          { installVerifies: true },
        ),
      );
      const text = await checkoutIo(async () => stateText(cache.objects, state.files));
      cooperative = !(await checkoutIo(async () => smallCheckout(staged, cache.objects)));
      // Reauthorize after a transfer, before writing. Bytes all from this machine's verified cache
      // arrived before this operation's access check, so a second read adds only a round trip.
      if (cache.downloadedObjects > 0)
        identity(parseHostedResponse(hostedLaneSelectionSchema, await transport.select(request.laneId)));
      await withCheckoutWritePass(
        cache.root,
        async () => {
          const stage = await checkoutIo(async () =>
            mkdtempSync(join(cache.root, delta ? 'delta-' : 'checkout-')),
          );
          try {
            const installed = await (async () => {
              const damaged: NativeFile[] = [];
              await metrics.measure('copyHash', () =>
                stageHostedFiles(stage, cache.objects, staged, cache.repairable ? damaged : undefined, text),
              );
              if (damaged.length) {
                await metrics.measure('cacheVerify', () => cache.repair(damaged.map(file => file.blob)));
                await metrics.measure('copyHash', () =>
                  stageHostedFiles(stage, cache.objects, damaged, undefined, text),
                );
              }
              await checkoutIo(async () => mkdirSync(join(stage, '.forge'), { mode: 0o700 }));
              const marker: HostedLaneCheckoutMarker = {
                schema: 1,
                kind: 'forge-hosted-lane-checkout',
                url: request.url,
                operationId: request.operationId,
                selection,
                state,
                tree: sourceTree(state.files),
                scope,
                materialized: files.map(file => file.path),
              };
              await checkoutIo(
                async () =>
                  durableReplace(join(stage, '.forge', hostedLaneMarkerName), JSON.stringify(marker)),
                'durability',
              );
              if (delta) {
                // An in-place delta rolls forward from its journaled stage after a crash, so that
                // stage stays durable. Drain both barriers even on failure before removing it.
                const flushed = await metrics.measure('durability', () =>
                  Promise.allSettled([
                    flushHostedFiles(stage, staged),
                    flushHostedCheckoutFiles(stage, staged),
                  ]),
                );
                for (const result of flushed) if (result.status === 'rejected') throw result.reason;
              } else {
                // A whole new tree follows git: no fsync per file. Its marker (fsynced above) is
                // reachable once the stage directory is; one rename then publishes both.
                await checkoutIo(async () => syncDirectory(stage), 'durability');
              }
              // Stats of the private stage carry over the rename, so the first save reads only edited files.
              return metrics.measure('index', () =>
                checkoutIo(async () => indexInstalledFiles(stage, staged), 'durability'),
              );
            })();
            await metrics.measure('publish', () =>
              checkoutIo(
                async () =>
                  workLocked(lock, () => {
                    operation = operationSchema.parse(json(receiptPath));
                    if (operation.complete) return;
                    recover();
                    const current = baseline();
                    if (
                      !(
                        markerDigest() === operation.previousMarker ||
                        current?.operationId === request.operationId
                      )
                    )
                      throw new ForgeError(
                        'WORK_STALE',
                        'Another checkout updated this client while source was downloading.',
                        undefined,
                        {
                          obstruction: { kind: 'baseline-mismatch', path: `.forge/${hostedLaneMarkerName}` },
                        },
                      );
                    if (repairs.length) rebuildCheckoutFiles(root, cache.objects, repairs, text);
                    if (current?.operationId === request.operationId) preserveArtifacts(files);
                    preserveCaches([...(current?.state.files ?? []), ...state.files]);
                    const index = readCheckoutStatIndex(root);
                    const inPlace =
                      Boolean(delta && request.previous) && current?.operationId !== request.operationId;
                    const changes: CheckoutChange[] = [];
                    const artifacts = cleanHostedCheckout(
                      root,
                      materializedFiles(current),
                      hostedLaneMarkerName,
                      Boolean(current),
                      { target: files, index, ...(inPlace ? { collect: changes } : {}) },
                    );
                    // In place, only paths the delta touches move; unsaved changes elsewhere stay
                    // exactly where they are under the new baseline. One that meets the delta (or
                    // any Forge metadata change) refuses before anything is installed.
                    // Nothing is installed yet, so the pending receipt goes too: a retry starts
                    // fresh and re-checks its expected pins, exactly as an early refusal does.
                    if (inPlace)
                      try {
                        refuseDeltaConflict(root, changes, delta!, materializedFiles(current), files);
                      } catch (error) {
                        rmSync(receiptPath, { force: true });
                        syncDirectory(cache.root);
                        throw error;
                      }
                    // An interrupted post-rename install already has the original marker. Reconcile it.
                    if (current?.operationId !== request.operationId) {
                      invariant(
                        !checkoutPathExists(previous),
                        'WORK_CONFLICT',
                        'An earlier checkout backup is preserved.',
                      );
                    }
                    if (current?.operationId !== request.operationId && delta) {
                      invariant(
                        markerDigest() === beforeDigest,
                        'WORK_STALE',
                        'Another checkout updated this client while source was downloading.',
                      );
                      const obstruction = deltaObstructed(root, delta);
                      if (obstruction) throw deltaObstructionError(obstruction);
                      // Ignored artifacts stay where they are; only changed paths move.
                      const pin = ({ path, blob, mode }: NativeFile) => ({ path, blob, mode });
                      sweepCheckoutStages(cache.root);
                      try {
                        sweepKeptApply(root);
                      } catch {
                        /* Expiry bookkeeping never fails an apply. */
                      }
                      journalCheckoutDelta(cache.root, {
                        operationId: request.operationId,
                        stage: basename(stage),
                        marker: hostedLaneMarkerName,
                        priorMarker: beforeDigest,
                        targetMarker: digest(readFileSync(join(stage, '.forge', hostedLaneMarkerName))),
                        install: delta.install.map(pin),
                        displace: deltaDisplacement(root, delta, materializedFiles(current)),
                        targetFiles: files,
                      });
                      const settled = settleCheckoutDelta(root, cache.root);
                      if (settled?.conflict) throw settled.conflict;
                      // A full install replaces `.forge`; in place, retire the persisted legacy record.
                      const legacyUse = join(root, '.forge', 'cache-use.json');
                      if (checkoutPathExists(legacyUse) && preserveLegacyCacheUse(root)) {
                        rmSync(legacyUse);
                        syncDirectory(join(root, '.forge'));
                      }
                    } else if (current?.operationId !== request.operationId) {
                      planCheckoutPreservation(preservationPath, artifacts);
                      if (checkoutPathExists(root)) renameSync(root, previous);
                      renameSync(stage, root);
                      syncDirectory(dirname(root));
                      syncDirectory(cache.root);
                      preserveArtifacts(files);
                      writeCheckoutStatIndex(root, installed.since, installed.entries);
                    }
                    // Nested Lanes share their caller's immutable objects. Retain that local
                    // cache location so saves can derive baseline evidence only when needed.
                    durableReplace(join(cache.root, 'overlap-objects.json'), JSON.stringify(cache.objects));
                    operation.complete = true;
                    durableReplace(receiptPath, JSON.stringify(operation));
                    disposePrevious(operation.previousMarker, index);
                  }),
                'durability',
              ),
            );
          } finally {
            // A journaled in-place install still owns its stage until it rolls forward.
            const owned = () => {
              try {
                return json(join(cache.root, deltaJournalName)).stage === basename(stage);
              } catch {
                return false; // No journal (or another process just finished it).
              }
            };
            if (checkoutPathExists(stage) && !owned())
              await checkoutIo(async () => rmSync(stage, { recursive: true, force: true }));
          }
        },
        {
          waited: ms => {
            metrics.phasesMs.slotWait += ms;
            metrics.writePassWaitMs += ms;
          },
        },
      );
      return result(false);
    },
    {
      paths: cache.ioPaths,
      cooperative: () => cooperative,
      budget: selected => {
        metrics.ioBudget = selected;
      },
      waited: ms => {
        metrics.phasesMs.slotWait += ms;
      },
    },
  );
}

export async function checkoutHostedLane(
  root: string,
  input: unknown,
  transport: LaneTransport,
  sharedObjects?: string,
  prepared?: CheckoutPrepared,
) {
  const request = hostedLaneCheckoutSchema.parse(input);
  return withSubmoduleCheckouts(root, () =>
    withCheckoutOpenMetrics(resolve(root), request, metrics =>
      checkout(root, request, transport, sharedObjects, metrics, prepared),
    ),
  );
}
