import { hostedActionError } from './hosted-action-error.js';
// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { makeFunctionReference } from 'convex/server';
import { hostedObjectWriter } from './hosted-object-store.js';
import { captureHostedSave } from './hosted-save-capture.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { durableReplace } from './native-durability.js';
import { digest } from './hash.js';
import { readHostedLaneCheckout, hostedLaneCheckoutMarkerSchema } from './hosted-lane-checkout-marker.js';
import { stateSchema } from './native-state-format.js';
import { workLocked } from './work-lock.js';
import { saveResultSchema } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { buildSavePages, saveRequestSchema, saveBytes, savePin } from './hosted-save.js';
import { ForgeError, invariant } from './errors.js';
import { keepPatchCommand, pendingSavePath, rebaseHostedCheckout } from './hosted-save-rebase.js';
import type { ConvexExchange } from './exchange-client.js';
import type { SaveChange, SaveRequest } from './hosted-save.js';
import type { ContentPin } from './native-exchange.js';

type SaveExchange = Pick<ConvexExchange, 'client' | 'projectId' | 'uploadFile' | 'upload' | 'missing'> &
  Partial<Pick<ConvexExchange, 'uploadLazyBatch' | 'downloadToFile' | 'downloadBatch' | 'prepareDownloads'>>;
const saveCommandSchema = z
  .object({ operationId: z.uuid(), message: z.string(), supersedeFinish: z.boolean().optional() })
  .strict();

const blobName = /^[0-9a-f]{64}$/;
/** Remove the staged blobs of a save the server has acknowledged. Retries reuse request.json and
 * pages.json and never read these bytes again; the small JSON files stay for exact retry. */
function dropStagedBlobs(directory: string) {
  try {
    for (const name of readdirSync(directory)) if (blobName.test(name)) rmSync(join(directory, name));
  } catch {
    /* Removal only frees space; a later save retries it. */
  }
}
/** Earlier saves of this checkout keep staged blobs only while unacknowledged: acknowledged ones, and
 * prepared ones no pending baseline names (older clients kept every save's full tree). */
function dropAcknowledgedSaves(client: string, current: string) {
  const saves = join(client, 'saves');
  let names: string[];
  try {
    names = readdirSync(saves).filter(name => name !== current);
  } catch {
    return;
  }
  const pending = new Set<string>();
  for (const name of readdirSync(client))
    if (name.startsWith('save-baseline-'))
      try {
        pending.add(JSON.parse(readFileSync(join(client, name), 'utf8')).operationId);
      } catch {
        /* An unreadable baseline protects nothing it cannot name. */
      }
  for (const name of names) {
    const directory = join(saves, name);
    if (
      checkoutPathExists(join(directory, 'acknowledged')) ||
      (checkoutPathExists(join(directory, 'request.json')) && !pending.has(name))
    )
      dropStagedBlobs(directory);
  }
}
/** One bounded API drive. Pending jobs complete server-side; callers may read
 * progress later without keeping a tab, coding host or owner process alive. */
export async function saveHostedLane(
  root: string,
  command: { operationId: string; message: string; supersedeFinish?: boolean },
  exchange: SaveExchange,
) {
  const first = await saveOnce(root, command, exchange, true);
  return first === rebased ? saveOnce(root, command, exchange, false) : first;
}
const rebased = Symbol('rebased');
async function saveOnce(
  root: string,
  command: { operationId: string; message: string; supersedeFinish?: boolean },
  exchange: SaveExchange,
  repair: boolean,
) {
  saveCommandSchema.parse(command);
  invariant(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Checkout directory must be real.');
  root = realpathSync(root);
  const directory = `${root}.forge-client/saves/${command.operationId}`;
  for (const path of [`${root}.forge-client`, `${root}.forge-client/saves`, directory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    invariant(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      'UNSAFE_PATH',
      'Save cache directory must be real.',
    );
  }
  workLocked(join(`${root}.forge-client`, 'lock'), () =>
    dropAcknowledgedSaves(`${root}.forge-client`, command.operationId),
  );
  const original = join(directory, 'command.json'),
    identity = { root, projectId: exchange.projectId, ...command };
  workLocked(join(`${root}.forge-client`, 'lock'), () => {
    if (checkoutPathExists(original))
      invariant(
        canonicalPayload(JSON.parse(readFileSync(original, 'utf8'))) === canonicalPayload(identity),
        'WORK_OPERATION_CHANGED',
        'Retry the original save command.',
      );
    else durableReplace(original, canonicalPayload(identity));
  });
  // A settled save answers its retry from the receipt it already applied.
  const settled = join(directory, 'terminal.json');
  if (checkoutPathExists(settled)) return JSON.parse(readFileSync(settled, 'utf8'));
  const capturePath = join(directory, 'capture.json');
  // An earlier save whose reply was not seen pins this baseline. Settle it first,
  // or every new save captures against the old head and the server refuses it.
  if (!checkoutPathExists(capturePath)) await settlePriorHostedSave(root, command.operationId, exchange);
  const capture: Awaited<ReturnType<typeof captureHostedSave>> = checkoutPathExists(capturePath)
    ? JSON.parse(readFileSync(capturePath, 'utf8'))
    : await captureHostedSave(root, directory);
  invariant(
    capture.marker.selection.projectId === exchange.projectId,
    'WORK_OPERATION_CHANGED',
    'Save project differs from checkout.',
  );
  const requestPath = join(directory, 'request.json');
  let request: SaveRequest;
  if (checkoutPathExists(requestPath))
    request = saveRequestSchema.parse(JSON.parse(readFileSync(requestPath, 'utf8')));
  else {
    // Raw small files share preparation/commit windows; large files retain the
    // bounded recipe/chunk path. A lost PUT/commit resumes these
    // original disk bytes, including after the working files were edited again.
    const unique = new Map(capture.files.map(file => [file.pin.sha256, file]));
    const candidates = [...unique.values()],
      raw = new Set<string>();
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const window = candidates.slice(offset, offset + 100);
      // Lazy authoritative preparation skips stored raw bytes without a separate
      // missing query. File-backed recipes still need missing-only discovery.
      const small = exchange.uploadLazyBatch ? window.filter(file => file.pin.size <= 2 * 1024 * 1024) : [];
      if (small.length) {
        await exchange.uploadLazyBatch!(
          small.map(file => ({
            pin: file.pin,
            read: () => readFileSync(join(directory, file.path)),
          })),
          { batchSize: 100, onRaw: id => raw.add(id) },
        );
        // Only exact committed raw members omit descriptor IO. Reused objects
        // still need current descriptors, including after an unknown reply.
      }
      const large = window.filter(file => !exchange.uploadLazyBatch || file.pin.size > 2 * 1024 * 1024);
      if (large.length) {
        const missing = new Set(await exchange.missing(large.map(file => file.pin)));
        for (const file of large)
          if (missing.has(file.pin.sha256)) await exchange.uploadFile(file.pin, directory, file.path);
      }
    }
    const changes: SaveChange[] = structuredClone(capture.changes);
    const replacements = changes.filter(change => change.after && !raw.has(change.after.blob));
    for (let offset = 0; offset < replacements.length; offset += 100) {
      const window = replacements.slice(offset, offset + 100);
      const rows: {
        digest: string;
        size: number;
        location: string;
        recipe?: { digest: string; size: number };
      }[] = await exchange.client.mutation(
        makeFunctionReference<'mutation'>('projectObjectDownloads:describe'),
        { projectId: exchange.projectId, digests: window.map(change => change.after!.blob) },
      );
      const byDigest = new Map(rows.map(row => [row.digest, row]));
      for (const change of window) {
        const row = byDigest.get(change.after!.blob);
        invariant(row, 'SOURCE_UNAVAILABLE', 'Commit every original delta blob before staging.');
        change.after!.content = {
          object: { sha256: row.digest, size: row.size },
          recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
        };
      }
    }
    const built = buildSavePages(changes),
      selection = capture.marker.selection;
    request = saveRequestSchema.parse({
      operationId: command.operationId,
      laneId: selection.laneId,
      authorityEpoch: selection.authority.epoch,
      expected: {
        head: selection.head,
        version: selection.version,
        sourceVersion: selection.sourceVersion,
        lifecycleVersion: selection.lifecycleVersion,
      },
      message: command.message,
      ...(command.supersedeFinish ? { supersedeFinish: true } : {}),
      pages: built.root,
      pageCount: built.pages.length,
      changeCount: changes.length,
    });
    request = workLocked(join(`${root}.forge-client`, 'lock'), () => {
      if (checkoutPathExists(requestPath))
        return saveRequestSchema.parse(JSON.parse(readFileSync(requestPath, 'utf8')));
      durableReplace(join(directory, 'pages.json'), JSON.stringify(built.pages));
      durableReplace(requestPath, canonicalPayload(request));
      return request;
    });
  }
  const pending = pendingSavePath(root, capture.marker);
  workLocked(join(`${root}.forge-client`, 'lock'), () => {
    if (!checkoutPathExists(pending)) durableReplace(pending, canonicalPayload(command));
  });
  const objects = hostedObjectWriter(exchange);
  const args = { projectId: exchange.projectId, operationId: command.operationId };
  let prepared;
  try {
    prepared = JSON.parse(
      await exchange.client.mutation(makeFunctionReference<'mutation'>('projectHostedSaves:prepare'), {
        projectId: exchange.projectId,
        request: canonicalPayload(request),
      }),
    );
  } catch (error) {
    const refused = hostedActionError(error, 'save');
    // A refusal began no server operation. Drop the retained capture so a later
    // save reads the working files again instead of resuming these stale bytes.
    if (refused.code === 'LANE_FINISH_ACTIVE' || refused.code === 'WORK_STALE') {
      workLocked(join(`${root}.forge-client`, 'lock'), () => {
        if (
          checkoutPathExists(pending) &&
          JSON.parse(readFileSync(pending, 'utf8')).operationId === command.operationId
        )
          rmSync(pending);
        rmSync(directory, { recursive: true, force: true });
      });
      if (refused.code === 'WORK_STALE') {
        // The server Lane moved past this checkout. Rebase once onto it, keeping
        // every local edit, and save the same operation from the new baseline.
        const laneId = capture.marker.selection.laneId;
        invariant(
          repair && exchange.downloadBatch && exchange.downloadToFile && exchange.prepareDownloads,
          'WORK_STALE',
          `The Lane moved past this checkout again while the save was repaired. Nothing was saved. Retry the same save; if it repeats, keep your edits and abandon this checkout: ${keepPatchCommand(root, laneId)}`,
        );
        await rebaseHostedCheckout(root, exchange as Parameters<typeof rebaseHostedCheckout>[1]);
        return rebased;
      }
      throw refused;
    }
    throw error;
  }
  // The server holds the request and every staged blob it names.
  writeFileSync(join(directory, 'acknowledged'), '', { mode: 0o600 });
  dropStagedBlobs(directory);
  if (prepared.terminal) {
    applyHostedSaveReceipt(root, capture, request, prepared.terminal);
    return prepared.terminal;
  }
  const pages: { pin: ContentPin; value: unknown }[] = JSON.parse(
    readFileSync(join(directory, 'pages.json'), 'utf8'),
  );
  if (exchange.uploadLazyBatch && prepared.input) {
    const metadata = [...pages.map(page => page.value), prepared.input];
    await exchange.uploadLazyBatch(
      metadata.map(value => ({
        pin: savePin(value),
        read: () => Buffer.from(saveBytes(value)),
      })),
      { batchSize: 100 },
    );
  }
  for (const [index, page] of pages.entries()) {
    if (!exchange.uploadLazyBatch || !prepared.input) await objects.put(Buffer.from(saveBytes(page.value)));
    await exchange.client.mutation(makeFunctionReference<'mutation'>('projectHostedSaves:stage'), {
      ...args,
      index,
      page: canonicalPayload(page.value),
    });
  }
  if (request.pages && (!exchange.uploadLazyBatch || !prepared.input)) {
    const progress = JSON.parse(
      await exchange.client.query(makeFunctionReference<'query'>('projectHostedSaves:progress'), args),
    );
    if (progress.terminal) {
      applyHostedSaveReceipt(root, capture, request, progress.terminal);
      return progress.terminal;
    }
    if (progress.input) await objects.put(Buffer.from(saveBytes(progress.input)));
  }
  const result = JSON.parse(
    await exchange.client.mutation(makeFunctionReference<'mutation'>('projectHostedSaveJobs:submit'), args),
  );
  if (result.outcome) applyHostedSaveReceipt(root, capture, request, result);
  return result;
}

/** Advance only the matching baseline marker; working bytes (including newer
 * local edits) are never installed or overwritten by save reconciliation. */
function applyHostedSaveReceipt(
  root: string,
  capture: Awaited<ReturnType<typeof captureHostedSave>>,
  request: SaveRequest,
  terminal: { outcome: { status: string; result?: unknown } },
) {
  workLocked(join(`${root}.forge-client`, 'lock'), () => {
    const pending = pendingSavePath(root, capture.marker);
    const clearPending = () => {
      if (
        checkoutPathExists(pending) &&
        JSON.parse(readFileSync(pending, 'utf8')).operationId === request.operationId
      )
        rmSync(pending);
    };
    if (terminal.outcome.status !== 'completed') {
      clearPending();
      return;
    }
    const result = saveResultSchema.parse(terminal.outcome.result),
      current = readHostedLaneCheckout(root),
      old = capture.marker;
    if (!current || canonicalPayload(current) !== canonicalPayload(old)) {
      clearPending();
      return;
    }
    const files = new Map(old.state.files.map(file => [file.path, file]));
    for (const change of capture.changes) {
      if (change.after)
        files.set(change.path, { path: change.path, blob: change.after.blob, mode: change.after.mode });
      else files.delete(change.path);
    }
    const state = result.unchanged
      ? old.state
      : stateSchema.parse({
          schema: 1,
          kind: 'forge-source-state',
          parents: [old.selection.head],
          files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
          message: request.message,
          at: result.at,
        });
    invariant(
      result.unchanged || digest(JSON.stringify(state)) === result.head,
      'SOURCE_HASH_MISMATCH',
      'Save receipt differs from the prepared source delta.',
    );
    const materialized = new Set(old.materialized);
    for (const change of capture.changes) {
      if (change.after) materialized.add(change.path);
      else materialized.delete(change.path);
    }
    const marker = hostedLaneCheckoutMarkerSchema.parse({
      ...old,
      state,
      materialized: [...materialized].sort(),
      selection: {
        ...old.selection,
        head: result.head,
        version: result.version,
        sourceVersion: result.sourceVersion,
      },
    });
    durableReplace(join(root, '.forge/hosted-lane.json'), JSON.stringify(marker));
    clearPending();
  });
  settleSave(root, request.operationId, terminal);
}
/** Once its outcome is applied, a save keeps only its command, request and outcome: the capture
 * (a full baseline copy, ~400 KB for 3,000 files) and pages are never read again. */
function settleSave(root: string, operationId: string, terminal: unknown) {
  const directory = `${root}.forge-client/saves/${operationId}`;
  try {
    durableReplace(join(directory, 'terminal.json'), JSON.stringify(terminal));
    for (const name of ['capture.json', 'pages.json']) rmSync(join(directory, name), { force: true });
    dropStagedBlobs(directory);
  } catch {
    /* Space only; the retained files still answer a retry. */
  }
}

/** Reconcile the one save pinned to this marker without scanning history or
 * installing working files. Unknown preparation/submission replies resume the
 * original operation; completed async checkpoints only advance their marker. */
export async function reconcileHostedSave(root: string, exchange: Parameters<typeof saveHostedLane>[2]) {
  const marker = readHostedLaneCheckout(root);
  if (!marker) return null;
  const pending = pendingSavePath(root, marker);
  if (!checkoutPathExists(pending)) return null;
  const command = saveCommandSchema.parse(JSON.parse(readFileSync(pending, 'utf8')));
  const directory = `${root}.forge-client/saves/${command.operationId}`;
  const capture = JSON.parse(readFileSync(join(directory, 'capture.json'), 'utf8'));
  const request = saveRequestSchema.parse(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')));
  let progress: { terminal?: { outcome: { status: string; result?: unknown } } };
  try {
    progress = JSON.parse(
      await exchange.client.query(makeFunctionReference<'query'>('projectHostedSaves:progress'), {
        projectId: exchange.projectId,
        operationId: command.operationId,
      }),
    );
  } catch (error) {
    if (hostedActionError(error, 'checkpoint reconciliation').code !== 'NOT_FOUND') throw error;
    progress = {};
  }
  if (progress.terminal) {
    applyHostedSaveReceipt(root, capture, request, progress.terminal);
    return null;
  }
  // The checkpoint may have stopped before preparation or job submission.
  // Resume its retained bytes and operation rather than waiting for an unscheduled job.
  const resumed = await saveHostedLane(
    root,
    {
      operationId: command.operationId,
      message: command.message,
      ...(command.supersedeFinish ? { supersedeFinish: true } : {}),
    },
    exchange,
  );
  if (resumed.outcome) return null;
  return { phase: 'save', saveOperationId: command.operationId, progress: resumed };
}

/** Before a new save or abandon captures: settle the earlier save pinned to this
 * baseline. No pending file means no call (the normal path). Otherwise one
 * progress read: a completed save advances the marker, a refused or never-started
 * one is dropped (the new capture supersedes its bytes), and one still
 * publishing is resumed by its original operation. */
export async function settlePriorHostedSave(
  root: string,
  operationId: string | null,
  exchange: SaveExchange,
): Promise<void> {
  const marker = readHostedLaneCheckout(root);
  if (!marker) return;
  const pending = pendingSavePath(root, marker);
  if (!checkoutPathExists(pending)) return;
  const prior = saveCommandSchema.parse(JSON.parse(readFileSync(pending, 'utf8')));
  if (prior.operationId === operationId) return;
  const directory = `${root}.forge-client/saves/${prior.operationId}`;
  let progress: { terminal?: { outcome: { status: string; result?: unknown } } | null };
  try {
    progress = JSON.parse(
      await exchange.client.query(makeFunctionReference<'query'>('projectHostedSaves:progress'), {
        projectId: exchange.projectId,
        operationId: prior.operationId,
      }),
    );
  } catch (error) {
    if (hostedActionError(error, 'save reconciliation').code !== 'NOT_FOUND') throw error;
    workLocked(join(`${root}.forge-client`, 'lock'), () => {
      if (
        checkoutPathExists(pending) &&
        JSON.parse(readFileSync(pending, 'utf8')).operationId === prior.operationId
      )
        rmSync(pending);
      rmSync(directory, { recursive: true, force: true });
    });
    return;
  }
  const capture = JSON.parse(readFileSync(join(directory, 'capture.json'), 'utf8'));
  const request = saveRequestSchema.parse(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8')));
  if (progress.terminal) {
    applyHostedSaveReceipt(root, capture, request, progress.terminal);
    return;
  }
  const resumed = await saveHostedLane(
    root,
    {
      operationId: prior.operationId,
      message: prior.message,
      ...(prior.supersedeFinish ? { supersedeFinish: true } : {}),
    },
    exchange,
  );
  if (resumed.outcome) return;
  throw new ForgeError(
    'SAVE_PENDING',
    `The earlier save ${prior.operationId} is still publishing. Nothing new was captured. Retry this same save in a few seconds; it then saves on top of it.`,
  );
}
