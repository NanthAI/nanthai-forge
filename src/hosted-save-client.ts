// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
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
import { buildSavePages, saveRequestSchema, saveBytes } from './hosted-save.js';
import { invariant } from './errors.js';
import type { ConvexExchange } from './exchange-client.js';
import type { SaveChange, SaveRequest } from './hosted-save.js';
import type { ContentPin } from './native-exchange.js';

/** One bounded API drive. Pending jobs complete server-side; callers may read
 * progress later without keeping a tab, coding host or owner process alive. */
export async function saveHostedLane(
  root: string,
  command: { operationId: string; message: string },
  exchange: Pick<ConvexExchange, 'client' | 'projectId' | 'uploadFile' | 'upload' | 'missing'>,
) {
  z.object({ operationId: z.uuid(), message: z.string() }).strict().parse(command);
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
  const capturePath = join(directory, 'capture.json');
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
    // Reuses missing-only recipe/chunk uploads. A lost PUT/commit resumes these
    // original disk bytes, including after the working files were edited again.
    const unique = new Map(capture.files.map(file => [file.pin.sha256, file]));
    const candidates = [...unique.values()];
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const window = candidates.slice(offset, offset + 100);
      const missing = new Set(await exchange.missing(window.map(file => file.pin)));
      for (const file of window)
        if (missing.has(file.pin.sha256)) await exchange.uploadFile(file.pin, directory, file.path);
    }
    const changes: SaveChange[] = structuredClone(capture.changes);
    const replacements = changes.filter(change => change.after);
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
  const objects = hostedObjectWriter(exchange);
  const args = { projectId: exchange.projectId, operationId: command.operationId };
  const prepared = JSON.parse(
    await exchange.client.mutation(makeFunctionReference<'mutation'>('projectHostedSaves:prepare'), {
      projectId: exchange.projectId,
      request: canonicalPayload(request),
    }),
  );
  if (prepared.terminal) {
    applyHostedSaveReceipt(root, capture, request, prepared.terminal);
    return prepared.terminal;
  }
  const pages: { pin: ContentPin; value: unknown }[] = JSON.parse(
    readFileSync(join(directory, 'pages.json'), 'utf8'),
  );
  for (const [index, page] of pages.entries()) {
    await objects.put(Buffer.from(saveBytes(page.value)));
    await exchange.client.mutation(makeFunctionReference<'mutation'>('projectHostedSaves:stage'), {
      ...args,
      index,
      page: canonicalPayload(page.value),
    });
  }
  const progress = JSON.parse(
    await exchange.client.query(makeFunctionReference<'query'>('projectHostedSaves:progress'), args),
  );
  if (progress.terminal) {
    applyHostedSaveReceipt(root, capture, request, progress.terminal);
    return progress.terminal;
  }
  if (progress.input) await objects.put(Buffer.from(saveBytes(progress.input)));
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
    if (terminal.outcome.status !== 'completed') return;
    const result = saveResultSchema.parse(terminal.outcome.result),
      current = readHostedLaneCheckout(root),
      old = capture.marker;
    if (!current || canonicalPayload(current) !== canonicalPayload(old)) return;
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
  });
}
