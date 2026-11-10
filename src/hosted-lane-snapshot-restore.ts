// SPDX-License-Identifier: Apache-2.0
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { captureSnapshot } from './hosted-lane-snapshot-capture.js';
import { snapshotDirectory } from './lane-snapshot-hint.js';
import {
  readSnapshotLedger,
  snapshotLaneCheckout,
  writeSnapshotLedger,
  type SnapshotClient,
} from './hosted-lane-snapshot.js';
import { savePageSchema, type SaveChange } from './hosted-save.js';
import { getSigned } from './exchange-r2-read.js';
import { mapExchange } from './exchange-parallel.js';
import { machineObjectsDirectory } from './machine-object-store.js';
import { rebuildCheckoutFiles } from './hosted-checkout-files.js';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { parseHostedResponse } from './hosted-response.js';
import { makeFunctionReference } from 'convex/server';
import { hostedActionError } from './hosted-action-error.js';
import { decodeSnapshotPack, type SnapshotPackRefs } from './lane-snapshot-pack.js';
import {
  snapshotListSchema,
  snapshotTarget,
  type SnapshotEntry,
  type SnapshotsCommand,
} from './lane-snapshot-contract.js';
import type { NativeFile } from './native-state-format.js';

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

/** Fetch snapshot objects of one Lane by digest (signed GETs, sha256-verified), 100 per call. */
async function readObjects(
  client: SnapshotClient,
  projectId: string,
  laneId: string,
  pins: { sha256: string; size: number }[],
) {
  const found = new Map<string, Buffer>();
  const unique = [...new Map(pins.map(pin => [pin.sha256, pin])).values()];
  for (let at = 0; at < unique.length; at += 100) {
    const page = unique.slice(at, at + 100);
    const signed = (await call(client, 'mutation', 'projectLaneSnapshots:read', {
      projectId,
      laneId,
      digests: page.map(pin => pin.sha256),
    })) as { sha256: string; url: string }[];
    const urls = new Map(signed.map(item => [item.sha256, item.url]));
    await mapExchange(page, 8, async pin => {
      const bytes = await getSigned(urls.get(pin.sha256)!, pin);
      invariant(bytes !== 'forbidden', 'EXCHANGE_DOWNLOAD_DENIED', 'Snapshot object download was refused.');
      found.set(pin.sha256, bytes);
    });
  }
  return found;
}
/**
 * The objects of one Lane's snapshots, wherever they live: inside a snapshot pack (the entry's own,
 * or an earlier one its header points to), or loose under their own digest (snapshots taken before
 * packs). Each pack is downloaded once; every member is digest-checked as it is read.
 */
class SnapshotObjects {
  private cache = new Map<string, Buffer>();
  private refs: SnapshotPackRefs = {};
  private packs = new Set<string>();
  /** File digest to the pack it was read from. */
  private where = new Map<string, [string, number]>();
  constructor(
    private readonly client: SnapshotClient,
    private readonly projectId: string,
    private readonly laneId: string,
  ) {}
  private async pack(pin: { sha256: string; size: number }) {
    if (this.packs.has(pin.sha256)) return;
    const bytes = (await readObjects(this.client, this.projectId, this.laneId, [pin])).get(pin.sha256)!;
    const decoded = decodeSnapshotPack(bytes);
    this.packs.add(pin.sha256);
    for (const [sha256, member] of decoded.members) {
      this.cache.set(sha256, member);
      if (!this.where.has(sha256)) this.where.set(sha256, [pin.sha256, pin.size]);
    }
    for (const [blob, ref] of Object.entries(decoded.refs)) this.refs[blob] ??= ref;
  }
  /** Make an entry's own pack readable (a loose entry has none). */
  async open(entry: Pick<SnapshotEntry, 'pack'>) {
    if (entry.pack) await this.pack(entry.pack);
  }
  async many(pins: { sha256: string; size: number }[]) {
    const found = new Map<string, Buffer>(),
      loose: { sha256: string; size: number }[] = [];
    for (const pin of new Map(pins.map(pin => [pin.sha256, pin])).values()) {
      const ref = this.refs[pin.sha256];
      if (!this.cache.has(pin.sha256) && ref) await this.pack({ sha256: ref[0], size: ref[1] });
      const known = this.cache.get(pin.sha256);
      if (known) found.set(pin.sha256, known);
      else loose.push(pin);
    }
    for (const [sha256, bytes] of await readObjects(this.client, this.projectId, this.laneId, loose)) {
      this.cache.set(sha256, bytes);
      found.set(sha256, bytes);
    }
    return found;
  }
  /** Where the next snapshot may find each file: in a pack, or loose. */
  locate(blobs: string[]) {
    const located: SnapshotPackRefs = {},
      loose: string[] = [];
    for (const blob of blobs) {
      const at = this.where.get(blob) ?? this.refs[blob];
      if (at) located[blob] = at;
      else loose.push(blob);
    }
    return { located, loose };
  }
}
/** A snapshot's delta: its page chain, read from its pack or one page at a time. */
async function readDelta(objects: SnapshotObjects, entry: SnapshotEntry) {
  const changes: SaveChange[] = [];
  await objects.open(entry);
  for (let pin = entry.pages; pin;) {
    const bytes = (await objects.many([pin])).get(pin.sha256)!;
    const page = savePageSchema.parse(JSON.parse(bytes.toString('utf8')));
    changes.push(...page.changes);
    pin = page.next;
  }
  return changes;
}
/** Head blobs to put back over files the target does not change: the machine object cache first,
 * then signed source downloads (one call per 100). */
async function headObjects(client: SnapshotClient, projectId: string, blobs: string[], stage: string) {
  const machine = machineObjectsDirectory();
  const missing: string[] = [];
  for (const blob of new Set(blobs)) {
    const cached = machine ? join(machine, blob) : null;
    if (cached && existsSync(cached) && digest(readFileSync(cached)) === blob)
      copyFileSync(cached, join(stage, blob));
    else missing.push(blob);
  }
  for (let at = 0; at < missing.length; at += 100) {
    const signed = (await call(client, 'mutation', 'projectObjectDownloads:signDownloads', {
      projectId,
      digests: missing.slice(at, at + 100),
    })) as { digest: string; size: number; url: string; range?: never }[];
    invariant(
      signed.length === missing.slice(at, at + 100).length,
      'SOURCE_UNAVAILABLE',
      'A saved file needed for this restore is unavailable. Nothing was changed.',
    );
    await mapExchange(signed, 8, async object => {
      const bytes = await getSigned(
        object.url,
        { sha256: object.digest, size: object.size },
        4,
        undefined,
        undefined,
        object.range,
      );
      invariant(bytes !== 'forbidden', 'EXCHANGE_DOWNLOAD_DENIED', 'Source download was refused.');
      writeFileSync(join(stage, object.digest), bytes, { mode: 0o600 });
    });
  }
}

/**
 * `x snapshots` (Issue 7ac4e32f): list the Lane's operation log; undo, redo or restore its
 * working files to a snapshot; or purge the Lane's snapshots for real. A move first snapshots
 * the current files (and refuses if it cannot), then writes the target's files over the
 * checkout's saved head and records the move as a new entry, so every move can be undone.
 * Nothing is saved and the Lane head never moves.
 */
export async function executeSnapshots(
  root: string,
  projectId: string,
  client: SnapshotClient,
  command: SnapshotsCommand,
) {
  const marker = readHostedLaneCheckout(root);
  const laneId = command.laneId ?? marker?.selection.laneId;
  invariant(laneId, 'BAD_ARGUMENT', 'Select laneId or run this in a hosted Lane checkout.');
  if (command.purge) {
    const result = await call(client, 'mutation', 'projectLaneSnapshots:purge', { projectId, laneId });
    if (marker?.selection.laneId === laneId)
      rmSync(snapshotDirectory(root), { recursive: true, force: true });
    return {
      phase: 'purge',
      ...result,
      next: 'Every snapshot of this Lane is being deleted from storage; new snapshots wait until it finishes.',
    };
  }
  const listed = () =>
    call(client, 'query', 'projectLaneSnapshots:list', { projectId, laneId }).then(value =>
      parseHostedResponse(snapshotListSchema, value),
    );
  const move = command.undo
    ? 'undo'
    : command.redo
      ? 'redo'
      : command.restore !== undefined
        ? 'restore'
        : null;
  if (!move) {
    const log = await listed();
    return {
      phase: 'list',
      ...log,
      next: log.entries.length
        ? 'Undo with x snapshots {"undo":1}, redo with {"redo":1}, or restore one with {"restore":SEQ|"latest"} in the Lane checkout.'
        : 'No snapshots yet: one is taken at each Forge command when files changed (policy autoSnapshot).',
    };
  }
  invariant(
    marker && marker.selection.laneId === laneId && marker.selection.projectId === projectId,
    'HOSTED_CHECKOUT_REQUIRED',
    'Run undo, redo or restore with the Lane checkout as ROOT (start --open {laneId} opens one).',
  );
  root = realpathSync(root);
  // The current files first: the move itself must be undoable.
  const before = await snapshotLaneCheckout(root, projectId, client);
  if (before.status === 'skipped')
    throw new ForgeError(
      before.code ?? 'WORK_BUSY',
      `Could not snapshot the current files before moving them (${before.reason}). Nothing was changed.`,
    );
  const log = await listed();
  let seq = snapshotTarget(log.entries, {
    ...(command.undo ? { undo: command.undo } : {}),
    ...(command.redo ? { redo: command.redo } : {}),
    ...(command.restore !== undefined ? { restore: command.restore } : {}),
  });
  invariant(
    seq !== null,
    'NOT_FOUND',
    `Nothing to ${move}: the operation log has no such snapshot. List it with nforge x ROOT snapshots '{}'.`,
  );
  const objects = new SnapshotObjects(client, projectId, laneId);
  let target = log.entries.find(entry => entry.seq === seq && entry.kind === 'snapshot')!;
  let delta: SaveChange[];
  const skipped: number[] = [];
  for (;;) {
    try {
      delta = await readDelta(objects, target);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'R2_OBJECT_MISSING') throw error;
      // A snapshot is recorded by the call that signs its upload, so one whose machine stopped
      // mid-upload has a row and no object. `latest` falls back to the newest one that has bytes.
      const failed = target.seq;
      const older = log.entries
        .filter(entry => entry.kind === 'snapshot' && entry.seq < failed)
        .sort((a, b) => b.seq - a.seq)[0];
      if (command.restore !== 'latest' || !older)
        throw new ForgeError(
          'R2_OBJECT_MISSING',
          `Snapshot ${failed} has no stored files: the machine stopped before its upload finished. Nothing was changed.${
            command.restore === 'latest' ? '' : ' Pick an earlier one with x snapshots {"restore":SEQ}.'
          }`,
        );
      skipped.push(failed);
      target = older;
      seq = older.seq;
    }
  }
  invariant(
    delta.every(change => change.after?.mode !== 'gitlink'),
    'BAD_ARGUMENT',
    'This snapshot changes a submodule pointer; restore it with a sync instead.',
  );
  const head = new Map<string, NativeFile>(marker.state.files.map(file => [file.path, file]));
  const desired = new Map<string, NativeFile | null>();
  // Files edited now but unchanged in the target go back to the saved head.
  for (const change of captureSnapshot(root, marker).changes)
    desired.set(change.path, head.get(change.path) ?? null);
  for (const change of delta)
    desired.set(
      change.path,
      change.after ? { path: change.path, blob: change.after.blob, mode: change.after.mode } : null,
    );
  const stage = join(snapshotDirectory(root), `restore-${randomUUID()}`);
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const fromSnapshot = delta.flatMap(change =>
      change.after ? [{ sha256: change.after.blob, size: change.after.content.object.size }] : [],
    );
    for (const [blob, bytes] of await objects.many(fromSnapshot))
      writeFileSync(join(stage, blob), bytes, { mode: 0o600 });
    const staged = new Set(fromSnapshot.map(pin => pin.sha256));
    await headObjects(
      client,
      projectId,
      [...desired.values()].flatMap(file => (file && !staged.has(file.blob) ? [file.blob] : [])),
      stage,
    );
    const writes = [...desired.values()].filter((file): file is NativeFile => file !== null);
    const removals = [...desired.entries()].filter(([, file]) => file === null).map(([path]) => path);
    for (const path of removals) rmSync(join(root, path), { force: true });
    for (const file of writes) mkdirSync(dirname(join(root, file.path)), { recursive: true });
    rebuildCheckoutFiles(root, stage, writes);
    await call(client, 'mutation', 'projectLaneSnapshots:restore', {
      projectId,
      laneId,
      operationId: randomUUID(),
      target: seq,
      head: marker.selection.head,
      move,
    });
    const after = captureSnapshot(root, marker);
    const ledger = readSnapshotLedger(root, laneId);
    const found = objects.locate([...staged]);
    writeSnapshotLedger(root, {
      laneId,
      tree: after.tree === target.tree ? target.tree : null,
      seq,
      uploaded: [
        ...ledger.uploaded,
        ...found.loose,
        ...(target.pages && !target.pack ? [target.pages.sha256] : []),
      ],
      located: { ...ledger.located, ...found.located },
      store: ledger.store ?? null,
    });
    const headDiffers = target.head !== marker.selection.head;
    return {
      phase: move,
      laneId,
      target: seq,
      written: writes.length,
      removed: removals.length,
      headDiffers,
      ...(skipped.length ? { skipped } : {}),
      next: `${headDiffers ? 'This snapshot was taken on an earlier saved head; its changed files were written over the current head. ' : ''}Your files were snapshotted before the move: x snapshots {"undo":1} goes back. Nothing was saved; save when you want to keep this.`,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
