// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot, clientCacheRoot, unfollowedClientCacheRoot, unfollowedRoot } from './root-paths.js';
import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { workLocked } from './work-lock.js';
import {
  checkoutPathExists,
  cleanHostedCheckout,
  installHostedFiles,
  flushHostedCheckoutFiles,
} from './hosted-checkout-files.js';
import { hostedLaneMarkerName } from './hosted-lane-checkout-marker.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { type LaneTransport } from './hosted-lane-checkout.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import { parseNativeStateValue } from './native-state-format.js';
import { applyHostedSync } from './hosted-sync-client.js';
import { applySchema } from './hosted-sync-contract.js';
import { withCheckoutWritePass } from './checkout-materialization.js';
import { hostedActionError } from './hosted-action-error.js';
import { retireCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { readCheckoutStatIndex } from './checkout-stat-index.js';
import type { CheckoutChange } from './hosted-checkout-clean.js';
import {
  clearKept,
  installBaseline,
  listKeptApply,
  liveState,
  misplacedCacheContent,
  preserveChanges,
  sweepKeptApply,
} from './hosted-apply-kept.js';

import {
  receiptSchema,
  validBaseline,
  recoveryDirectory,
  pathFor,
  blockedName,
  read,
  savedSchema,
  markerAt,
  localApplyBlocked,
} from './hosted-apply-recovery-records.js';
export { localApplyBlocked } from './hosted-apply-recovery-records.js';

function rootLinkBlocked(root: string, target: string, saved: z.infer<typeof savedSchema>) {
  const request = applySchema.parse(saved.request),
    next = { action: 'recover-apply', applyOperationId: request.operationId };
  return new ForgeError(
    'WORK_CONFLICT',
    `The checkout root was replaced by a link to ${target} after this apply was retained. Nothing was written there. Move the link aside, then run recover-apply again.`,
    undefined,
    {
      phase: 'local-apply',
      status: 'blocked',
      sourceCompleted: true,
      operationId: saved.handoff?.operationId ?? request.operationId,
      applyOperationId: request.operationId,
      root,
      laneId: request.lane.laneId,
      from: request.from,
      to: request.lane,
      blockers: [{ kind: 'root-link', path: root }],
      more: false,
      next,
      command: hostedRecoveryCommand(root, next.action, { applyOperationId: request.operationId }),
    },
  );
}
/** Explicit recovery keeps only the changed files of the obstructed tree (plus a receipt listing
 * deletions) in the client cache, then restores those paths to the exact baseline in place. Every
 * step is journaled and retryable; no submitted source work is replaced or cancelled. */
export async function recoverLocalApply(root: string, id: string, transport: LaneTransport) {
  const lexical = unfollowedRoot(root),
    retained = join(unfollowedClientCacheRoot(root), blockedName(id));
  root = canonicalRoot(root);
  // The journal is found where the apply was retained. A root recreated as a link afterwards is
  // never followed: recovery refuses with the same executable action instead of writing elsewhere.
  if (root !== lexical && !checkoutPathExists(pathFor(root, id)) && checkoutPathExists(retained))
    throw rootLinkBlocked(lexical, root, savedSchema.parse(read(retained)));
  invariant(
    checkoutPathExists(pathFor(root, id)),
    'NOT_FOUND',
    'No retained local apply with this applyOperationId exists for this checkout.',
  );
  const cacheRoot = clientCacheRoot(root),
    saved = savedSchema.parse(read(pathFor(root, id)));
  const request = applySchema.parse(saved.request);
  invariant(request.operationId === id, 'WORK_OPERATION_CHANGED', 'Recover the retained apply.');
  const observed = await transport.select(request.lane.laneId); // fresh authority before local writes
  invariant(
    observed.projectId === request.lane.projectId && observed.laneId === request.lane.laneId,
    'PROJECT_UNAVAILABLE',
    'Recover this project.',
  );
  try {
    try {
      sweepKeptApply(root);
    } catch {
      /* Expiry bookkeeping never fails a recovery. */
    }
    const directory = recoveryDirectory(root, id),
      backup = join(directory, 'files');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const path of [cacheRoot, directory])
      invariant(
        lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
        'UNSAFE_PATH',
        'Recovery directories must be real.',
      );
    const receiptPath = join(directory, 'receipt.json');
    const receipt = workLocked(join(cacheRoot, 'lock'), () => {
      if (checkoutPathExists(receiptPath)) return receiptSchema.parse(read(receiptPath));
      const observedMarker = markerAt(root),
        marker = saved.baseline ?? observedMarker;
      invariant(
        marker && validBaseline(marker, request),
        'WORK_STALE',
        'The local baseline changed; preserve it before recovering the retained apply.',
      );
      const value = {
        marker,
        restored: false,
        preservedAt: backup,
        baselineStage: join(directory, `baseline-${randomUUID()}`),
        undo: `Only the files your checkout changed are kept at ${backup}, with the same relative paths; files that were deleted are listed in the receipt next to it. Copy what you need back after the apply. Further rounds stay in the same folder. It is removed seven days after the apply is confirmed.`,
      };
      durableReplace(receiptPath, JSON.stringify(value));
      return receiptSchema.parse(value);
    });
    invariant(
      validBaseline(receipt.marker, request),
      'WORK_OPERATION_CHANGED',
      'Recover the original checkout baseline.',
    );
    invariant(
      receipt.preservedAt === backup,
      'WORK_OPERATION_CHANGED',
      'Retain the original recovery backup.',
    );
    const checkoutReceipt = join(cacheRoot, `${id}.json`);
    const alreadyApplied =
      checkoutPathExists(checkoutReceipt) &&
      z.object({ complete: z.boolean() }).parse(read(checkoutReceipt)).complete;
    if (!receipt.restored && !alreadyApplied) {
      const paths = new Set<string>(receipt.marker.materialized);
      const state = parseNativeStateValue(receipt.marker.state);
      const files = state.files.filter(file => paths.has(file.path));
      const byPath = new Map(files.map(file => [file.path, file]));
      const cache = new HostedCheckoutCache(cacheRoot, transport);
      const lock = join(cacheRoot, 'lock');
      const publishedBaseline = (marker: unknown) => {
        if (JSON.stringify(markerAt(root)) !== JSON.stringify(marker)) return false;
        try {
          cleanHostedCheckout(root, files, hostedLaneMarkerName, true);
          return true;
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'WORK_CONFLICT') return false;
          throw error;
        }
      };
      /** One preservation round: copy only the changed paths, set them back to the baseline in
       * place, and leave every other file (including ignored artifacts) where it is. A path edited
       * again after it was kept never gets overwritten: it starts another round instead. */
      const settle = async (): Promise<{ done: true } | { need: string[] } | { again: true }> => {
        Object.assign(receipt, receiptSchema.parse(read(receiptPath)));
        if (
          receipt.restored ||
          (checkoutPathExists(checkoutReceipt) &&
            z.object({ complete: z.boolean() }).parse(read(checkoutReceipt)).complete)
        )
          return { done: true };
        const round = receipt.roundBackup ?? backup,
          name = basename(round);
        invariant(
          dirname(round) === directory && (name === 'files' || /^files-[a-f0-9-]{36}$/.test(name)),
          'UNSAFE_PATH',
          'Recovery backup must stay in its original directory.',
        );
        const missingRoot = !checkoutPathExists(root);
        if (!receipt.rounds?.[name])
          workLocked(lock, () => {
            const current = receiptSchema.parse(read(receiptPath));
            if (current.restored || current.rounds?.[name]) return void Object.assign(receipt, current);
            const changes: CheckoutChange[] = [];
            if (!missingRoot)
              cleanHostedCheckout(root, files, hostedLaneMarkerName, true, {
                collect: changes,
                index: readCheckoutStatIndex(root),
              });
            if (!missingRoot) changes.push(...misplacedCacheContent(root, files));
            current.rounds = { ...current.rounds, [name]: preserveChanges(root, round, changes) };
            durableReplace(receiptPath, JSON.stringify(current));
            Object.assign(receipt, current);
          });
        if (receipt.restored) return { done: true };
        const entries = receipt.rounds?.[name] ?? [];
        const want = missingRoot
          ? files
          : entries.flatMap(entry => {
              const file = byPath.get(entry.path);
              return entry.kind !== 'extra' && file && liveState(root, entry, file) !== 'baseline'
                ? [file]
                : [];
            });
        const absent = want.filter(file => !checkoutPathExists(join(cache.objects, file.blob)));
        if (absent.length) return { need: absent.map(file => file.blob) };
        // Journal one private stage before creating it. A crash cannot orphan another stage,
        // and concurrent replays are serialized by the write lease.
        if (!receipt.baselineStage) {
          receipt.baselineStage = join(directory, `baseline-${randomUUID()}`);
          durableReplace(receiptPath, JSON.stringify(receipt));
        }
        const stage = receipt.baselineStage;
        invariant(
          dirname(stage) === directory && /^baseline-[a-f0-9-]{36}$/.test(basename(stage)),
          'UNSAFE_PATH',
          'The private baseline stage must stay in its recovery directory.',
        );
        if (checkoutPathExists(stage)) rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage, { mode: 0o700 });
        try {
          await installHostedFiles(stage, cache.objects, want);
          mkdirSync(join(stage, '.forge'), { mode: 0o700, recursive: true });
          if (missingRoot)
            durableReplace(join(stage, '.forge', hostedLaneMarkerName), JSON.stringify(receipt.marker));
          await flushHostedCheckoutFiles(stage, want);
          syncDirectory(directory);
          return workLocked(lock, () => {
            const current = receiptSchema.parse(read(receiptPath));
            if (current.restored) return { done: true as const };
            const another = () => {
              const next = join(directory, `files-${randomUUID()}`);
              current.roundBackup = next;
              current.additionalPreservedAt = [...(current.additionalPreservedAt ?? []), next];
              durableReplace(receiptPath, JSON.stringify(current));
              Object.assign(receipt, current);
              return { again: true as const };
            };
            if ((current.roundBackup ?? backup) !== round || checkoutPathExists(root) === missingRoot)
              return another();
            if (!missingRoot)
              for (const entry of entries)
                if (liveState(root, entry, byPath.get(entry.path)) === 'other') return another();
            try {
              if (!missingRoot) clearKept(root, entries);
            } catch (error) {
              if (error instanceof ForgeError && error.code === 'WORK_CONFLICT') return another();
              throw error;
            }
            if (missingRoot) {
              renameSync(stage, root);
            } else {
              installBaseline(root, stage, want);
              mkdirSync(join(root, '.forge'), { recursive: true, mode: 0o700 });
              durableReplace(join(root, '.forge', hostedLaneMarkerName), JSON.stringify(current.marker));
            }
            syncDirectory(root);
            // An interrupted in-place apply's journal describes bytes the baseline just replaced:
            // its moved-aside bytes move into the recovery directory.
            const displaced = retireCheckoutDelta(cacheRoot, directory);
            if (displaced && !current.additionalPreservedAt?.includes(displaced)) {
              current.additionalPreservedAt = [...(current.additionalPreservedAt ?? []), displaced];
              durableReplace(receiptPath, JSON.stringify(current));
            }
            if (!publishedBaseline(current.marker)) return another();
            const previous = join(cacheRoot, 'previous');
            if (checkoutPathExists(previous)) {
              const firstBackup = current.priorPreservedAt ?? join(directory, 'prior-checkout');
              let priorBackup = firstBackup;
              if (checkoutPathExists(firstBackup)) {
                priorBackup = current.pendingPriorPreservedAt ?? join(directory, `checkout-${randomUUID()}`);
                if (checkoutPathExists(priorBackup))
                  priorBackup = join(directory, `checkout-${randomUUID()}`);
                current.pendingPriorPreservedAt = priorBackup;
                current.additionalPreservedAt = [
                  ...new Set([...(current.additionalPreservedAt ?? []), priorBackup]),
                ];
              }
              invariant(
                dirname(priorBackup) === directory,
                'UNSAFE_PATH',
                'Keep the prior checkout in its recovery directory.',
              );
              current.priorPreservedAt = firstBackup;
              durableReplace(receiptPath, JSON.stringify(current));
              renameSync(previous, priorBackup);
            }
            syncDirectory(cacheRoot);
            syncDirectory(directory);
            syncDirectory(join(root, '..'));
            current.restored = true;
            durableReplace(receiptPath, JSON.stringify(current));
            Object.assign(receipt, current);
            return { done: true as const };
          });
        } finally {
          if (checkoutPathExists(stage)) rmSync(stage, { recursive: true, force: true });
        }
      };
      let need: string[] = [];
      for (let turn = 0; ; turn++) {
        invariant(
          turn < 5,
          'WORK_CONFLICT',
          'Local files kept changing during recovery; they are kept. Run recover-apply again.',
        );
        if (need.length) await cache.ensure(need);
        const step = await withCheckoutWritePass(cacheRoot, settle);
        if ('done' in step) break;
        need = 'need' in step ? step.need : [];
      }
    }
    // A crash after the baseline was published (or the apply finished) can leave the journaled,
    // never-consumed stage behind; a replay that finds the work done retires it. Only the exact
    // journaled stage is removed, under the same write serialization; kept user files never are.
    await withCheckoutWritePass(cacheRoot, async () =>
      workLocked(join(cacheRoot, 'lock'), () => {
        const current = receiptSchema.parse(read(receiptPath)),
          stage = current.baselineStage;
        const done =
          current.restored ||
          (checkoutPathExists(checkoutReceipt) &&
            z.object({ complete: z.boolean() }).parse(read(checkoutReceipt)).complete);
        if (!stage || !done || !checkoutPathExists(stage)) return;
        invariant(
          dirname(stage) === directory && /^baseline-[a-f0-9-]{36}$/.test(basename(stage)),
          'UNSAFE_PATH',
          'The private baseline stage must stay in its recovery directory.',
        );
        rmSync(stage, { recursive: true, force: true });
        syncDirectory(directory);
      }),
    );
    let applied;
    try {
      applied = await applyHostedSync(root, request, transport);
    } catch (error) {
      const superseded = error instanceof ForgeError ? error.recovery?.superseded : undefined;
      if (!superseded) throw error;
      // The Lane moved on before this apply's first receipt. The checkout is back at its exact
      // baseline with every local change kept; installing the newer head is a separate, explicit
      // step, so this retained apply ends here instead of repeating WORK_STALE.
      workLocked(join(cacheRoot, 'lock'), () => {
        const handoff = join(cacheRoot, 'sync-handoff.json');
        try {
          if (z.object({ applyOperationId: z.string() }).parse(read(handoff)).applyOperationId === id)
            rmSync(handoff);
        } catch {
          /* No retained handoff for this apply. */
        }
      });
      const next = { action: 'open', laneId: request.lane.laneId };
      const { action, ...command } = next;
      return {
        phase: 'local-apply',
        status: 'superseded',
        applied: null,
        sourceCompleted: true,
        operationId: saved.handoff?.operationId ?? id,
        applyOperationId: id,
        from: request.from,
        to: request.lane,
        superseded,
        note: 'The Lane changed after this sync completed, so its pinned result was not installed. Your checkout is at its previous baseline and local changes are kept; open the Lane to install its current head.',
        preservedAt: backup,
        undo: receipt.undo,
        kept: listKeptApply(root).entries.find(entry => entry.id === id),
        next,
        command: hostedRecoveryCommand(root, action, command),
      };
    }
    // The apply is confirmed: the retention clock for the kept files starts now.
    workLocked(join(cacheRoot, 'lock'), () => {
      const current = receiptSchema.parse(read(receiptPath));
      if (current.confirmedAt) return;
      current.confirmedAt = Date.now();
      durableReplace(receiptPath, JSON.stringify(current));
      receipt.confirmedAt = current.confirmedAt;
    });
    const next = saved.handoff
      ? { action: saved.handoff.action, ...saved.handoff.command }
      : { action: 'open', laneId: request.lane.laneId };
    const { action, ...command } = next;
    return {
      phase: 'local-apply',
      status: 'applied',
      applied,
      sourceCompleted: true,
      operationId: saved.handoff?.operationId ?? id,
      applyOperationId: id,
      preservedAt: backup,
      undo: receipt.undo,
      kept: listKeptApply(root).entries.find(entry => entry.id === id),
      ...(receipt.additionalPreservedAt?.length
        ? { additionalPreservedAt: receipt.additionalPreservedAt }
        : {}),
      ...(checkoutPathExists(join(directory, 'prior-checkout'))
        ? {
            priorPreservedAt: join(directory, 'prior-checkout'),
            priorUndo: `Earlier installer backup preserved at ${join(directory, 'prior-checkout')}. Copy needed files back after apply.`,
          }
        : {}),
      next,
      command: hostedRecoveryCommand(root, action, command),
    };
  } catch (error) {
    if (error instanceof ForgeError && error.recovery?.phase === 'local-apply') throw error;
    const safe = hostedActionError(error, 'local apply recovery');
    throw localApplyBlocked(
      root,
      request,
      safe.code === 'HOSTED_ACTION_FAILED'
        ? new ForgeError('LOCAL_APPLY_INTERRUPTED', 'Local apply recovery was interrupted before completion.')
        : safe,
    );
  }
}
