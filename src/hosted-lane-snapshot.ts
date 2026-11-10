// SPDX-License-Identifier: Apache-2.0
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import type { ConvexHttpClient } from 'convex/browser';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { captureSnapshot, snapshotDirectory } from './hosted-lane-snapshot-capture.js';
import { saveBytes } from './hosted-save.js';
import { putR2 } from './exchange-blobs.js';
import { mapExchange } from './exchange-parallel.js';
import { durableReplace } from './native-durability.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { hostedActionError } from './hosted-action-error.js';
import { neverIndex } from './forge-disk.js';
import {
  snapshotPrepareResultSchema,
  snapshotPrepareSchema,
  type SnapshotPrepare,
} from './lane-snapshot-contract.js';
import { parseHostedResponse } from './hosted-response.js';
import { invariant } from './errors.js';

export type SnapshotClient = Pick<ConvexHttpClient, 'mutation' | 'query'>;
/** What the last snapshot of this checkout recorded: the tree the working files matched and the
 * objects this Lane's snapshot store already holds (so they are never sent twice). */
type Ledger = {
  laneId: string;
  tree: string | null;
  seq: number | null;
  uploaded: string[];
  refused?: string;
  /** The Lane snapshot store `uploaded` refers to (prepare names it). */
  store?: string | null;
};
const uploadedLimit = 20_000;
const ledgerPath = (root: string) => join(snapshotDirectory(root), 'ledger.json');
const pendingPath = (root: string) => join(snapshotDirectory(root), 'pending.json');
export function readSnapshotLedger(root: string, laneId: string): Ledger {
  try {
    const value = JSON.parse(readFileSync(ledgerPath(root), 'utf8')) as Ledger;
    if (value.laneId === laneId && Array.isArray(value.uploaded)) return value;
  } catch {
    /* A missing or unreadable ledger only means the next snapshot sends more. */
  }
  return { laneId, tree: null, seq: null, uploaded: [] };
}
export function writeSnapshotLedger(root: string, ledger: Ledger) {
  mkdirSync(snapshotDirectory(root), { recursive: true, mode: 0o700 });
  neverIndex(snapshotDirectory(root));
  durableReplace(
    ledgerPath(root),
    JSON.stringify({ ...ledger, uploaded: ledger.uploaded.slice(-uploadedLimit) }),
  );
}
/** One snapshot per checkout at a time: a second command skips instead of waiting. */
function exclusive<T>(root: string, run: () => Promise<T>): Promise<T | null> {
  const path = join(snapshotDirectory(root), 'lock');
  mkdirSync(snapshotDirectory(root), { recursive: true, mode: 0o700 });
  try {
    if (Date.now() - statSync(path).mtimeMs > 120_000) rmSync(path, { force: true });
  } catch {
    /* No lock. */
  }
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    return Promise.resolve(null);
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return run().finally(() => rmSync(path, { force: true }));
}
const call = async (
  client: SnapshotClient,
  kind: 'mutation' | 'query',
  name: string,
  args: Record<string, unknown>,
) => {
  try {
    const value =
      kind === 'mutation'
        ? await client.mutation(makeFunctionReference<'mutation'>(name), args)
        : await client.query(makeFunctionReference<'query'>(name), args);
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw hostedActionError(error, name);
  }
};

export type SnapshotReceipt =
  | { status: 'unchanged'; calls: number }
  | {
      status: 'saved';
      seq: number;
      changes: number;
      uploads: number;
      bytes: number;
      calls: number;
      notSaved?: { count: number; capped: string[]; held: string[] };
    }
  | { status: 'skipped'; reason: string; calls: number; code?: string };

/**
 * Snapshot a hosted Lane checkout's working files (Issue 7ac4e32f). Unchanged since the last
 * snapshot: no call. Changed: `prepare` + create-only R2 PUTs of the pages and the changed files
 * this Lane's store lacks + `commit` (one call when nothing needs uploading). Retry-safe: an
 * unfinished snapshot is finished with its original request before a new one is captured.
 * Never moves the Lane head and never throws: failures come back as `skipped`.
 */
export async function snapshotLaneCheckout(
  root: string,
  projectId: string,
  client: SnapshotClient,
): Promise<SnapshotReceipt> {
  const marker = readHostedLaneCheckout(root);
  if (!marker || marker.selection.projectId !== projectId)
    return { status: 'skipped', reason: 'not a hosted Lane checkout of this project', calls: 0 };
  const laneId = marker.selection.laneId;
  let calls = 0;
  const outcome = await exclusive(root, async (): Promise<SnapshotReceipt> => {
    const ledger = readSnapshotLedger(root, laneId);
    const capture = captureSnapshot(root, marker);
    if (capture.tree === ledger.tree || capture.tree === ledger.refused)
      return { status: 'unchanged', calls: 0 };
    // Nothing to protect: a fresh checkout equal to its head.
    if (!capture.changes.length && ledger.tree === null) return { status: 'unchanged', calls: 0 };
    // An unfinished snapshot of this same tree is finished with its original request.
    let retained: SnapshotPrepare | undefined;
    try {
      retained = snapshotPrepareSchema.parse(JSON.parse(readFileSync(pendingPath(root), 'utf8')));
    } catch {
      retained = undefined;
    }
    const operationId =
      retained && retained.laneId === laneId && retained.tree === capture.tree
        ? retained.operationId
        : randomUUID();
    const sizes = new Map<string, number>([
      ...capture.pages.map(page => [page.pin.sha256, page.pin.size] as const),
      ...capture.changes.flatMap(change =>
        change.after ? [[change.after.blob, change.after.content.object.size] as const] : [],
      ),
    ]);
    let current = ledger;
    // At most two prepares: the second only when the Lane's store was dropped (expiry, purge)
    // since this checkout last uploaded, so every object is sent again.
    for (let attempt = 0; ; attempt++) {
      // Without a named store nothing is vouched for: send every changed file.
      const known = new Set(current.store ? current.uploaded : []);
      const objects = new Map<string, () => Buffer>();
      for (const page of capture.pages)
        objects.set(page.pin.sha256, () => Buffer.from(saveBytes(page.value)));
      for (const change of capture.changes)
        if (change.after && !known.has(change.after.blob) && !objects.has(change.after.blob)) {
          const blob = change.after.blob;
          objects.set(blob, () => capture.read(blob));
        }
      const request: SnapshotPrepare = snapshotPrepareSchema.parse({
        laneId,
        operationId,
        head: capture.head,
        tree: capture.tree,
        pages: capture.root,
        pageCount: capture.pages.length,
        changeCount: capture.changes.length,
        uploads: [...objects.keys()].map(sha256 => ({ sha256, size: sizes.get(sha256)! })),
        notSaved: capture.notSaved.count,
        store: current.store ?? null,
      });
      durableReplace(pendingPath(root), canonicalPayload(request));
      let prepared;
      try {
        calls++;
        prepared = parseHostedResponse(
          snapshotPrepareResultSchema,
          await call(client, 'mutation', 'projectLaneSnapshots:prepare', {
            projectId,
            request: canonicalPayload(request),
          }),
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        // A refusal stored nothing: forget the request. A limit is reported once per tree.
        if (code === 'QUOTA_EXCEEDED') writeSnapshotLedger(root, { ...current, refused: capture.tree });
        if (code && code !== 'HOSTED_ACTION_FAILED' && code !== 'HOSTED_CONFLICT')
          rmSync(pendingPath(root), { force: true });
        throw error;
      }
      if (prepared.state === 'reset') {
        invariant(attempt === 0, 'HOSTED_CONFLICT', 'The Lane snapshot store changed twice; try again.');
        current = { laneId, tree: null, seq: null, uploaded: [], store: null };
        continue;
      }
      if (prepared.state !== 'unchanged') {
        const byDigest = new Map(prepared.targets.map(target => [target.sha256, target]));
        await mapExchange([...objects.entries()], 8, async ([sha256, read]) => {
          const target = byDigest.get(sha256);
          if (target) await putR2(target, read());
        });
        if (prepared.state === 'pending') {
          calls++;
          await call(client, 'mutation', 'projectLaneSnapshots:commit', {
            projectId,
            laneId,
            operationId: request.operationId,
          });
        }
      }
      writeSnapshotLedger(root, {
        laneId,
        tree: capture.tree,
        seq: prepared.seq,
        uploaded: [...current.uploaded, ...objects.keys()],
        store: prepared.store,
      });
      rmSync(pendingPath(root), { force: true });
      if (prepared.state === 'unchanged') return { status: 'unchanged', calls };
      return {
        status: 'saved',
        seq: prepared.seq,
        changes: capture.changes.length,
        uploads: objects.size,
        bytes: request.uploads.reduce((sum, pin) => sum + pin.size, 0),
        calls,
        ...(capture.notSaved.count ? { notSaved: capture.notSaved } : {}),
      };
    }
  }).catch((error: unknown): SnapshotReceipt => {
    const code = (error as { code?: string }).code;
    return {
      status: 'skipped',
      reason: error instanceof Error ? error.message : 'snapshot failed',
      calls,
      ...(code ? { code } : {}),
    };
  });
  return outcome ?? { status: 'skipped', reason: 'another snapshot of this checkout is running', calls: 0 };
}
