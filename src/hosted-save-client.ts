// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ConflictContinuation } from './hosted-conflict-precheck.js';
import { clientCacheRoot } from './root-paths.js';
import { sourceTree } from './source-tree.js';
import { hostedActionError } from './hosted-action-error.js';
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
import { makeFunctionReference } from 'convex/server';
import { hostedObjectWriter } from './hosted-object-store.js';
import { captureHostedSave } from './hosted-save-capture.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { durableReplace } from './native-durability.js';
import { digest } from './hash.js';
import { readHostedLaneCheckout, hostedLaneCheckoutMarkerSchema } from './hosted-lane-checkout-marker.js';
import { stateSchema } from './native-state-format.js';
import { workLocked } from './work-lock.js';
import { settlePendingCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { saveResultSchema, type SaveThen } from './hosted-save.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { buildSavePages, saveRequestSchema, saveBytes, savePin } from './hosted-save.js';
import { ForgeError, invariant } from './errors.js';
import { keepPatchCommand, rebaseHostedCheckout } from './hosted-save-rebase.js';
import {
  backgroundSaveName,
  backgroundSaveOperation,
  pendingSavePath,
  saveCommandSchema,
} from './hosted-save-pending.js';
export { backgroundSaveOperation };
import type { ConvexExchange } from './exchange-client.js';
import type { SaveChange, SaveRequest } from './hosted-save.js';
import type { ContentPin } from './native-exchange.js';
import { markLandStep, saveTimingMs } from './land-timing.js';
import { buildUploadPack, uploadPackMembers } from './object-pack-upload.js';
import type { StepTimer } from './sync-timing.js';
import { operationWait } from './agent-operation-wait.js';
import { parseHostedResponse } from './hosted-response.js';

type SaveExchange = Pick<ConvexExchange, 'client' | 'projectId' | 'uploadFile' | 'upload' | 'missing'> &
  Partial<
    Pick<
      ConvexExchange,
      | 'uploadLazyBatch'
      | 'commitObjects'
      | 'uploadPrepared'
      | 'downloadToFile'
      | 'downloadBatch'
      | 'prepareDownloads'
    >
  >;
/** What the server's strict save pages accept: nothing, ranges, or ranges plus cross-file facts. */
type OverlapEvidenceLevel = boolean | 'symbol-links';
export const overlapEvidenceLevel = (capabilities: {
  overlapEvidenceVersion?: 1 | undefined;
  features?: readonly string[] | undefined;
}): OverlapEvidenceLevel =>
  capabilities.overlapEvidenceVersion !== 1
    ? false
    : capabilities.features?.includes('overlap-symbol-links')
      ? 'symbol-links'
      : true;
/** What the server's save calls accept, from the capability read the session already made. */
export type SaveContract = {
  overlapEvidence: OverlapEvidenceLevel;
  submitPage: boolean;
  durations?: boolean;
  submitRun?: boolean;
  /** prepare-upload-targets: prepare takes the save's uploads and returns their targets. */
  prepareTargets?: boolean;
  /** source-run-publish: the submit action replies with the published outcome when its step finished. */
  runPublish?: boolean;
  /** The resolve the server chains after this save (save-then-resolve); only a new request takes it. */
  then?: SaveThen;
  /** Split save (save-settle-background, fea47345 C): return once the upload is in and the save is
   * submitted; the server settles it and the caller's next command reports the outcome. Only the
   * plain agent save asks for it: land, finish and lifecycle saves need their settled head. */
  settleBackground?: boolean;
  /** upload-packs: several new small objects go up as one pack (one PUT). */
  uploadPacks?: boolean;
};
export const saveContract = (capabilities: {
  overlapEvidenceVersion?: 1 | undefined;
  features?: readonly string[] | undefined;
}): SaveContract => ({
  overlapEvidence: overlapEvidenceLevel(capabilities),
  submitPage: capabilities.features?.includes('save-submit-page') ?? false,
  durations: capabilities.features?.includes('save-preflight-timing') ?? false,
  submitRun: capabilities.features?.includes('source-submit-run') ?? false,
  prepareTargets: capabilities.features?.includes('prepare-upload-targets') ?? false,
  runPublish: capabilities.features?.includes('source-run-publish') ?? false,
  uploadPacks: capabilities.features?.includes('upload-packs') ?? false,
});

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
  /** Server save features: a SaveContract, or only the overlap evidence level (older callers). */
  contract: OverlapEvidenceLevel | SaveContract = false,
  preserveConflicts = false,
  continuation: ConflictContinuation = { action: 'save', parameters: command },
  /** Wait on an earlier unfinished save of this checkout instead of refusing SAVE_PENDING. */
  waitPrior?: (operationId: string, pending: unknown) => Promise<unknown>,
  /** The receipt's phase split (friction f15db544): clock reads only. */
  timing?: StepTimer,
  /** Sees the submit action's published reply (`{terminal, state, chain?}`, source-run-publish). */
  observe?: (reply: unknown) => void,
) {
  const features = typeof contract === 'object' ? contract : { overlapEvidence: contract, submitPage: false };
  const once = (repair: boolean) =>
    saveOnce(
      root,
      command,
      exchange,
      repair,
      features,
      preserveConflicts,
      continuation,
      waitPrior,
      timing,
      observe,
    );
  // A direct save refused for a recipe-only blob rebuilt its request the described way: once more.
  let result = await once(true);
  if (result === described) result = await once(true);
  if (result === rebased) result = await once(false);
  if (result === described) result = await once(false);
  return result;
}
/** Direct saves (prepare-upload-targets) send these many uploads to prepare at most; the input is the 100th. */
const directUploads = 99;
const rawLimit = 2 * 1024 * 1024;
const rebased = Symbol('rebased');
const described = Symbol('described');
async function saveOnce(
  root: string,
  command: { operationId: string; message: string; supersedeFinish?: boolean },
  exchange: SaveExchange,
  repair: boolean,
  contract: SaveContract,
  preserveConflicts: boolean,
  continuation: ConflictContinuation,
  waitPrior?: (operationId: string, pending: unknown) => Promise<unknown>,
  timing?: StepTimer,
  observe?: (reply: unknown) => void,
) {
  const started = performance.now();
  const { overlapEvidence, submitPage, submitRun, then, prepareTargets, runPublish } = contract,
    pack = contract.uploadPacks === true;
  saveCommandSchema.parse(command);
  invariant(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Checkout directory must be real.');
  root = realpathSync(root);
  const directory = join(clientCacheRoot(root), `saves/${command.operationId}`);
  for (const path of [clientCacheRoot(root), join(clientCacheRoot(root), `saves`), directory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    invariant(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      'UNSAFE_PATH',
      'Save cache directory must be real.',
    );
  }
  workLocked(join(clientCacheRoot(root), 'lock'), () =>
    dropAcknowledgedSaves(clientCacheRoot(root), command.operationId),
  );
  const original = join(directory, 'command.json'),
    identity = { root, projectId: exchange.projectId, ...command };
  workLocked(join(clientCacheRoot(root), 'lock'), () => {
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
  if (!checkoutPathExists(capturePath))
    await settlePriorHostedSave(root, command.operationId, exchange, waitPrior);
  timing?.mark('settle');
  const capture: Awaited<ReturnType<typeof captureHostedSave>> = checkoutPathExists(capturePath)
    ? JSON.parse(readFileSync(capturePath, 'utf8'))
    : await captureHostedSave(root, directory, preserveConflicts, continuation);
  markLandStep('captured');
  timing?.mark('capture');
  invariant(
    capture.marker.selection.projectId === exchange.projectId,
    'WORK_OPERATION_CHANGED',
    'Save project differs from checkout.',
  );
  const requestPath = join(directory, 'request.json'),
    acknowledged = join(directory, 'acknowledged');
  // Raw small uploads are PUT now and committed once, with the save's metadata pages below, so a
  // save makes one verifying commit action instead of two. Nothing reads them before that commit:
  // preparation names only their pins, and staging checks their committed bindings.
  const deferred = exchange.uploadLazyBatch && exchange.commitObjects ? ([] as { id: string }[]) : undefined;
  // A direct save (prepare-upload-targets) names every captured raw blob as `{object, recipe: null}`
  // without asking first, and its one prepare returns the targets of those blobs, its pages and its
  // input, so the uploads go in one PUT wave. The server refuses (before any operation) a blob stored
  // only as a recipe; the `describe` marker then sends this save the original way.
  const files = [...new Map(capture.files.map(file => [file.pin.sha256, file])).values()],
    describeMarker = join(directory, 'describe');
  let direct =
    !!prepareTargets &&
    !!deferred &&
    !!exchange.uploadPrepared &&
    !checkoutPathExists(describeMarker) &&
    files.every(file => file.pin.size <= rawLimit);
  let request: SaveRequest;
  if (checkoutPathExists(requestPath)) {
    request = saveRequestSchema.parse(JSON.parse(readFileSync(requestPath, 'utf8')));
    direct &&=
      files.length + JSON.parse(readFileSync(join(directory, 'pages.json'), 'utf8')).length <= directUploads;
    // A retry before the commit below re-sends the staged bytes it still holds: stored members are
    // skipped, and an uncommitted one is prepared again under its create-only key.
    if (deferred && !direct && !checkoutPathExists(acknowledged))
      await uploadCapturedFiles(capture, directory, exchange, new Set(), deferred, pack);
  } else {
    const changes: SaveChange[] = structuredClone(capture.changes);
    if (direct && files.length + buildSavePages(changes).pages.length > directUploads) direct = false;
    const raw = new Set<string>(direct ? files.map(file => file.pin.sha256) : []);
    if (!direct) await uploadCapturedFiles(capture, directory, exchange, raw, deferred, pack);
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
    // Older servers validate delta pages strictly. Reuse capability discovery; never probe per save.
    if (!overlapEvidence) for (const change of changes) delete change.evidence;
    else if (overlapEvidence !== 'symbol-links')
      for (const change of changes) delete change.evidence?.symbolLinks;
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
      ...(then ? { then } : {}),
    });
    request = workLocked(join(clientCacheRoot(root), 'lock'), () => {
      if (checkoutPathExists(requestPath))
        return saveRequestSchema.parse(JSON.parse(readFileSync(requestPath, 'utf8')));
      durableReplace(join(directory, 'pages.json'), JSON.stringify(built.pages));
      durableReplace(requestPath, canonicalPayload(request));
      return request;
    });
  }
  markLandStep('uploaded');
  const pending = pendingSavePath(root, capture.marker);
  workLocked(join(clientCacheRoot(root), 'lock'), () => {
    if (!checkoutPathExists(pending)) durableReplace(pending, canonicalPayload(command));
  });
  const objects = hostedObjectWriter(exchange);
  const args = { projectId: exchange.projectId, operationId: command.operationId };
  const pages: { pin: ContentPin; value: unknown }[] = JSON.parse(
    readFileSync(join(directory, 'pages.json'), 'utf8'),
  );
  const uploads = direct
    ? [
        ...files.map(file => ({ pin: file.pin, read: () => readFileSync(join(directory, file.path)) })),
        ...pages.map(page => ({ pin: page.pin, read: () => Buffer.from(saveBytes(page.value)) })),
      ]
    : null;
  // upload-packs: the changed blobs and pages go up as one pack, named before the prepare signs it.
  const built =
    uploads && pack ? await buildUploadPack(uploads, uploadPackMembers(uploads.map(({ pin }) => pin))) : null;
  let prepared;
  try {
    prepared = JSON.parse(
      await exchange.client.mutation(makeFunctionReference<'mutation'>('projectHostedSaves:prepare'), {
        projectId: exchange.projectId,
        request: canonicalPayload(request),
        ...(uploads ? { uploads: uploads.map(({ pin }) => ({ digest: pin.sha256, size: pin.size })) } : {}),
        ...(built ? { uploadPack: built.proposal } : {}),
      }),
    );
  } catch (error) {
    const refused = hostedActionError(error, 'save');
    if (refused.code === 'SAVE_CONTENT_RECIPE' && direct) {
      // Nothing began on the server: rebuild this request with described blobs, the original way.
      workLocked(join(clientCacheRoot(root), 'lock'), () => {
        for (const name of ['request.json', 'pages.json']) rmSync(join(directory, name), { force: true });
        durableReplace(describeMarker, '');
      });
      return described;
    }
    // A refusal began no server operation. Drop the retained capture so a later
    // save reads the working files again instead of resuming these stale bytes.
    if (refused.code === 'LANE_FINISH_ACTIVE' || refused.code === 'WORK_STALE') {
      workLocked(join(clientCacheRoot(root), 'lock'), () => {
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
  timing?.mark('prepare');
  if (prepared.terminal) {
    writeFileSync(acknowledged, '', { mode: 0o600 });
    dropStagedBlobs(directory);
    applyHostedSaveReceipt(root, capture, request, prepared.terminal);
    return prepared.terminal;
  }
  if (uploads && prepared.targets && prepared.input) {
    // One PUT wave: the changed blobs, the delta pages and the input, all prepared by that call.
    const input = prepared.input;
    await exchange.uploadPrepared!(
      [...uploads, { pin: savePin(input), read: () => Buffer.from(saveBytes(input)) }],
      prepared.targets,
      deferred!,
      ...(built ? [{ digest: built.proposal.digest, bytes: built.bytes }] : []),
    );
  } else if (exchange.uploadLazyBatch && prepared.input) {
    const metadata = [...pages.map(page => page.value), prepared.input];
    await exchange.uploadLazyBatch(
      metadata.map(value => ({
        pin: savePin(value),
        read: () => Buffer.from(saveBytes(value)),
      })),
      { batchSize: 100, ...(deferred ? { deferCommit: deferred } : {}), ...(pack ? { pack } : {}) },
    );
  }
  // A server with save-submit-page stages the last page inside submit: one call fewer per save.
  const lazy = !!exchange.uploadLazyBatch && !!prepared.input,
    last = lazy && submitPage && pages.length ? pages.length - 1 : null,
    // With source-submit-run one action commits, submits and runs the first step. Staging a page
    // first needs committed objects, so only a save with no separate stage call takes it.
    run = lazy && !!submitRun && submitPage && pages.length <= 1 && !!exchange.client.action,
    background = run && contract.settleBackground === true,
    // The action commits one page of uploads; a larger save commits the rest first, as before.
    committedInRun = run && deferred && deferred.length <= 100 ? deferred : [];
  if (deferred?.length && committedInRun !== deferred) await exchange.commitObjects!(deferred);
  if (!run) {
    // The server holds the request and every staged blob it names.
    writeFileSync(acknowledged, '', { mode: 0o600 });
    dropStagedBlobs(directory);
  }
  timing?.mark('upload');
  const measured = () => {
    if (!contract.durations) return {};
    const path = join(directory, 'submit-timing.json');
    if (!checkoutPathExists(path))
      durableReplace(
        path,
        JSON.stringify(saveTimingMs() ?? Math.max(0, Math.round(performance.now() - started))),
      );
    return {
      clientMs: z
        .number()
        .int()
        .nonnegative()
        .parse(JSON.parse(readFileSync(path, 'utf8'))),
    };
  };
  if (run) {
    // Recorded before the call: a save whose reply is lost is still reported by the next command.
    if (background) durableReplace(join(directory, backgroundSaveName), '');
    const inputText = canonicalPayload(prepared.input);
    const reply = JSON.parse(
      await exchange.client.action(makeFunctionReference<'action'>('projectSourceRun:submit'), {
        ...args,
        kind: 'save',
        ...measured(),
        ...(committedInRun.length ? { objects: committedInRun } : {}),
        ...(last === null ? {} : { index: last, page: canonicalPayload(pages[last]!.value) }),
        ...(background ? { settle: 'background' } : {}),
        // source-run-publish: the outcome in the reply when the step finished, and the input inline.
        ...(runPublish && !background
          ? {
              progress: true,
              ...(Buffer.byteLength(inputText) <= 64 * 1024 ? { input: inputText } : {}),
            }
          : {}),
      }),
    );
    writeFileSync(acknowledged, '', { mode: 0o600 });
    dropStagedBlobs(directory);
    markLandStep('saveSubmitted');
    timing?.mark('submit');
    const result = reply?.terminal?.outcome ? reply.terminal : reply;
    if (result !== reply) {
      timing?.server(reply);
      observe?.(reply);
    }
    if (result.outcome) {
      applyHostedSaveReceipt(root, capture, request, result);
      // Settled already (a retry): this command reports the outcome itself.
      if (background) rmSync(join(directory, backgroundSaveName), { force: true });
    }
    return result;
  }
  for (const [index, page] of pages.entries()) {
    if (!lazy) await objects.put(Buffer.from(saveBytes(page.value)));
    if (index === last) break;
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
    await exchange.client.mutation(makeFunctionReference<'mutation'>('projectHostedSaveJobs:submit'), {
      ...args,
      ...measured(),
      ...(last === null ? {} : { index: last, page: canonicalPayload(pages[last]!.value) }),
    }),
  );
  markLandStep('saveSubmitted');
  timing?.mark('submit');
  if (result.outcome) applyHostedSaveReceipt(root, capture, request, result);
  return result;
}

/** Send the captured changed files. Raw small files share preparation windows (and, with `deferred`,
 * leave their commit to the caller); large files keep the bounded recipe/chunk path, which commits
 * itself. A lost PUT/commit resumes these original disk bytes, including after the working files
 * were edited again. `raw` gains the files this call sent as raw objects. */
async function uploadCapturedFiles(
  capture: Awaited<ReturnType<typeof captureHostedSave>>,
  directory: string,
  exchange: SaveExchange,
  raw: Set<string>,
  deferred: { id: string }[] | undefined,
  pack = false,
) {
  const unique = new Map(capture.files.map(file => [file.pin.sha256, file]));
  const candidates = [...unique.values()];
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const window = candidates.slice(offset, offset + 100);
    // Lazy authoritative preparation skips stored raw bytes without a separate
    // missing query. File-backed recipes still need missing-only discovery.
    const small = exchange.uploadLazyBatch ? window.filter(file => file.pin.size <= 2 * 1024 * 1024) : [];
    if (small.length)
      // Only exact raw members this save sent omit descriptor IO. Reused objects
      // still need current descriptors, including after an unknown reply.
      await exchange.uploadLazyBatch!(
        small.map(file => ({
          pin: file.pin,
          read: () => readFileSync(join(directory, file.path)),
        })),
        {
          batchSize: 100,
          onRaw: id => raw.add(id),
          ...(deferred ? { deferCommit: deferred } : {}),
          ...(pack ? { pack } : {}),
        },
      );
    const large = window.filter(file => !exchange.uploadLazyBatch || file.pin.size > 2 * 1024 * 1024);
    if (large.length) {
      const missing = new Set(await exchange.missing(large.map(file => file.pin)));
      for (const file of large)
        if (missing.has(file.pin.sha256)) await exchange.uploadFile(file.pin, directory, file.path);
    }
  }
}
/** Advance only the matching baseline marker; working bytes (including newer
 * local edits) are never installed or overwritten by save reconciliation. */
function applyHostedSaveReceipt(
  root: string,
  capture: Awaited<ReturnType<typeof captureHostedSave>>,
  request: SaveRequest,
  terminal: { outcome: { status: string; result?: unknown } },
) {
  workLocked(join(clientCacheRoot(root), 'lock'), () => {
    // A sync interrupted since capture finishes first, so its marker never moves backwards.
    settlePendingCheckoutDelta(root);
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
    const result = parseHostedResponse(saveResultSchema, terminal.outcome.result),
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
      tree: sourceTree(state.files),
      materialized: [...materialized].sort(),
      selection: {
        ...old.selection,
        head: result.head,
        version: result.version,
        sourceVersion: result.sourceVersion,
      },
    });
    durableReplace(join(root, '.forge/hosted-lane.json'), JSON.stringify(marker));
    if (result.durationMs !== undefined)
      durableReplace(
        join(clientCacheRoot(root), 'save-timing.json'),
        JSON.stringify({ laneId: result.laneId, head: result.head, saveMs: result.durationMs }),
      );
    clearPending();
  });
  settleSave(root, request.operationId, terminal);
}
/** Apply a save outcome observed after this client returned `submitted` (its own progress
 * subscription delivered it): advance the matching marker from the retained capture and request,
 * with no further call. A save already settled here, or never prepared here, changes nothing. */
export function applyObservedSaveOutcome(
  root: string,
  operationId: string,
  terminal: { outcome: { status: string; result?: unknown } },
) {
  root = realpathSync(root);
  const directory = join(clientCacheRoot(root), `saves/${operationId}`);
  if (checkoutPathExists(join(directory, 'terminal.json'))) return;
  const capturePath = join(directory, 'capture.json'),
    requestPath = join(directory, 'request.json');
  if (!checkoutPathExists(capturePath) || !checkoutPathExists(requestPath)) return;
  applyHostedSaveReceipt(
    root,
    JSON.parse(readFileSync(capturePath, 'utf8')),
    saveRequestSchema.parse(JSON.parse(readFileSync(requestPath, 'utf8'))),
    terminal,
  );
}
/** Once its outcome is applied, a save keeps only its command, request and outcome: the capture
 * (a full baseline copy, ~400 KB for 3,000 files) and pages are never read again. */
function settleSave(root: string, operationId: string, terminal: unknown) {
  const directory = join(clientCacheRoot(root), `saves/${operationId}`);
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
  const directory = join(clientCacheRoot(root), `saves/${command.operationId}`);
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
  /** Callers that pin the marker (sync) wait on the earlier save's own progress instead of refusing. */
  wait?: (operationId: string, pending: unknown) => Promise<unknown>,
): Promise<void> {
  const marker = readHostedLaneCheckout(root);
  if (!marker) return;
  const pending = pendingSavePath(root, marker);
  if (!checkoutPathExists(pending)) return;
  const prior = saveCommandSchema.parse(JSON.parse(readFileSync(pending, 'utf8')));
  if (prior.operationId === operationId) return;
  const directory = join(clientCacheRoot(root), `saves/${prior.operationId}`);
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
    workLocked(join(clientCacheRoot(root), 'lock'), () => {
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
    reportBackgroundSave(root, prior.operationId, progress.terminal);
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
  if (resumed.outcome) {
    reportBackgroundSave(root, prior.operationId, resumed);
    return;
  }
  const observed = (wait ? await wait(prior.operationId, resumed) : undefined) as
    | { outcome?: { status: string; result?: unknown } }
    | undefined;
  if (observed?.outcome) {
    applyObservedSaveOutcome(root, prior.operationId, observed as { outcome: { status: string } });
    reportBackgroundSave(root, prior.operationId, observed as { outcome: { status: string } });
    return;
  }
  throw new ForgeError(
    'SAVE_PENDING',
    `The earlier save ${prior.operationId} is still publishing. Nothing new was captured. Wait for it with ${operationWait(root, { operationIds: [prior.operationId] }).waitCommand}, then retry this same command; it then works on top of it.`,
  );
}

/** Apply the outcome of the save that returned before its settle and, when it did not complete,
 * report that once as SAVE_SETTLE_FAILED: the command that reads it does nothing else, so the agent
 * sees the failure and runs the command again (its edits are still in the checkout). */
function reportBackgroundSave(
  root: string,
  operationId: string,
  terminal: { outcome: { status: string; error?: { code?: string; message?: string } } },
) {
  const flag = join(clientCacheRoot(root), `saves/${operationId}`, backgroundSaveName);
  if (!checkoutPathExists(flag)) return;
  rmSync(flag, { force: true });
  if (terminal.outcome.status === 'completed') return;
  const error = terminal.outcome.error;
  throw new ForgeError(
    'SAVE_SETTLE_FAILED',
    `Your earlier save ${operationId} returned before the server finished it, and the server could not finish it (${error?.code ?? terminal.outcome.status}: ${error?.message ?? 'no detail'}). Nothing from that save is on the Lane; your edits are still in this checkout. This command did nothing: run it again (a save captures those edits again).`,
    undefined,
    { failedSave: operationId, ...(error?.code ? { cause: error.code } : {}) },
  );
}
/** Before any agent command (fea47345 C): when this checkout's pending save returned before its
 * settle, read its outcome (one query; none when no such save is pending, so idle costs nothing).
 * A completed save advances the marker; a failed one is reported (SAVE_SETTLE_FAILED); one still
 * settling is left to the command (save and sync wait on it, reads go on). */
export async function settleBackgroundSave(
  root: string,
  exchange: Pick<SaveExchange, 'client' | 'projectId'>,
  /** The outcome capability discovery already read for this save (`settling`): no extra call. */
  known?: { operationId: string; terminal: unknown },
) {
  const prior = backgroundSaveOperation(root);
  if (!prior) return;
  const directory = join(clientCacheRoot(root), `saves/${prior}`);
  type Terminal = { outcome: { status: string; result?: unknown } };
  let terminal: Terminal | null | undefined;
  if (known?.operationId === prior) terminal = known.terminal as Terminal | null;
  else
    try {
      terminal = (
        JSON.parse(
          await exchange.client.query(makeFunctionReference<'query'>('projectHostedSaves:progress'), {
            projectId: exchange.projectId,
            operationId: prior,
          }),
        ) as { terminal?: Terminal | null }
      ).terminal;
    } catch (error) {
      // An unknown save is the existing reconciliation's case (it drops it); other errors surface.
      if (hostedActionError(error, 'save reconciliation').code === 'NOT_FOUND') return;
      throw error;
    }
  if (!terminal) return;
  applyHostedSaveReceipt(
    root,
    JSON.parse(readFileSync(join(directory, 'capture.json'), 'utf8')),
    saveRequestSchema.parse(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'))),
    terminal,
  );
  reportBackgroundSave(root, prior, terminal);
}
