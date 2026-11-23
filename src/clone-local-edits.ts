// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { cleanHostedCheckout } from './hosted-checkout-files.js';
import type { CheckoutChange } from './hosted-checkout-clean.js';
import { readHostedMainMarker } from './hosted-main-marker.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { readCheckoutStatIndex } from './checkout-stat-index.js';
import { safeRelative } from './files.js';
import { createHash } from 'node:crypto';
import { digest } from './hash.js';
import { shellQuote } from './shell-quote.js';
import type { readLaneEntry as ReadLane, recordLane as RecordLane } from './lane-registry.js';

/** The Lane registry functions, passed in: importing the registry here would split it out of the CLI's
 * shared chunk and add a module to every agent command's load (the weight ceilings). */
export type LaneRegistry = { read: typeof ReadLane; record: typeof RecordLane };

/* Edits made in a shared main clone instead of a Lane (Item e802a0f9): nothing tells the next agent,
 * and the next pull refuses on them. Everything here reads local files only: the clone's own manifest
 * compare, the same one pull runs. No server call. */

export const WHY_EDITS_BELONG_IN_A_LANE =
  'Edits in a shared clone are seen by no one else, block the next pull and are never saved; work in a Lane (start first).';
/** The bounded list shown to a person or agent; the count is always complete. */
export const EDIT_LIST_LIMIT = 20;

export type CloneEdit = { path: string; kind: CheckoutChange['kind']; changedAt: string | null };
export type CloneEdits = {
  count: number;
  files: CloneEdit[];
  truncated: boolean;
  changes: CheckoutChange[];
  /** The newest change time over every edit, in ms; null when only deletions. */
  newestMs: number | null;
};

const metadata = (path: string) => path === '.forge' || path.startsWith('.forge/');

/** Every edited, untracked or deleted source path of a main clone ROOT, or null for a root that is not one. */
export function cloneLocalEdits(root: string, limit = EDIT_LIST_LIMIT): CloneEdits | null {
  const marker = readHostedMainMarker(root);
  if (!marker) return null;
  const found: CheckoutChange[] = [];
  cleanHostedCheckout(root, marker.state.files, 'hosted-main.json', true, {
    collect: found,
    index: readCheckoutStatIndex(root),
  });
  const changes = found.filter(change => !metadata(change.path)).sort((a, b) => a.path.localeCompare(b.path));
  let newestMs: number | null = null;
  const timed = changes.map(change => {
    let ms: number | null = null;
    if (change.kind !== 'deleted')
      try {
        ms = lstatSync(join(root, change.path)).mtimeMs;
      } catch {
        // Gone since the scan: listed without a time.
      }
    if (ms !== null && (newestMs === null || ms > newestMs)) newestMs = ms;
    return {
      path: change.path,
      kind: change.kind,
      changedAt: ms === null ? null : new Date(ms).toISOString(),
    };
  });
  const files = timed.slice(0, limit);
  return { count: changes.length, files, truncated: changes.length > files.length, changes, newestMs };
}

/** One line per edit, bounded, for status and notices. */
export function editLines(edits: Pick<CloneEdits, 'count' | 'files' | 'truncated'>) {
  const lines = edits.files.map(
    file =>
      `  ${file.kind === 'extra' ? 'untracked' : file.kind} ${JSON.stringify(file.path)}${file.changedAt ? ` (${file.changedAt})` : ''}`,
  );
  if (edits.truncated) lines.push(`  … ${edits.count - edits.files.length} more`);
  return lines;
}

/** The start reply field naming the edits found in the clone and how to carry them. */
export function startEditsNotice(root: string, edits: CloneEdits) {
  return {
    count: edits.count,
    files: edits.files,
    ...(edits.truncated ? { truncated: true } : {}),
    note: `${WHY_EDITS_BELONG_IN_A_LANE} They stay in the clone until you carry them.`,
    carry: `nforge agent ${shellQuote(root)} start '{"outcome":"Keep local edits","carryEdits":true}' moves them into the new Lane and leaves the clone clean.`,
  };
}

export type CarryResult = {
  carried: string[];
  skipped: { path: string; reason: string }[];
};

const inside = (root: string, path: string) => {
  const at = resolve(root, path);
  return at.startsWith(resolve(root) + sep) ? at : null;
};
/** The nearest existing ancestor of PATH resolves inside ROOT: no symlinked folder leads out of the Lane. */
function realInside(root: string, path: string) {
  const base = realpathSync(root);
  let at = dirname(path);
  while (!existsSync(at)) at = dirname(at);
  const real = realpathSync(at);
  return real === base || real.startsWith(base + sep);
}
const regular = (path: string) => {
  const stat = lstatSync(path);
  return stat.isFile() && stat.nlink === 1 ? stat : null;
};

type Move = {
  path: string;
  kind: CheckoutChange['kind'];
  from: string;
  to: string;
  bytes: Buffer;
  mode: number;
  baseline: Buffer | null;
  baselineMode: number;
};

/** Move the clone's edits into a freshly opened Lane, then put the clone back at its baseline.
 * All or nothing before any write: every path is checked first (the Lane holds the clone's baseline file
 * byte for byte, nothing leads out of the Lane, no clone file is a link), and one failing path moves
 * nothing and is named. The Lane copy is written before the clone is restored, and a clone file that
 * changed meanwhile is left as it is (named as skipped), so an edit is never lost. */
export function carryCloneEdits(
  cloneRoot: string,
  laneRoot: string,
  edits: CloneEdits,
  lane: { path: string; blob: string }[] | null,
): CarryResult {
  const clone = readHostedMainMarker(cloneRoot);
  const result: CarryResult = { carried: [], skipped: [] };
  if (!clone || !lane) {
    for (const { path } of edits.changes)
      result.skipped.push({ path, reason: 'the Lane checkout is not ready' });
    return result;
  }
  const cloneBlob = new Map(clone.state.files.map(file => [file.path, file.blob]));
  const laneBlob = new Map(lane.map(file => [file.path, file.blob]));
  const moves: Move[] = [];
  for (const { path, kind } of edits.changes) {
    const from = inside(cloneRoot, path),
      to = inside(laneRoot, path);
    const refuse = (reason: string) => result.skipped.push({ path, reason });
    try {
      if (!from || !to || !safeRelative(path)) throw new Error('unsafe path');
      if (!realInside(laneRoot, to)) throw new Error('the Lane path leads outside the Lane');
      let bytes = Buffer.alloc(0),
        mode = 0;
      if (kind !== 'deleted') {
        const stat = regular(from);
        if (!stat) throw new Error('not a regular file');
        bytes = readFileSync(from);
        mode = stat.mode & 0o777;
      }
      if (kind === 'extra') {
        if (laneBlob.has(path) || existsSync(to)) throw new Error('the Lane already has this path');
        moves.push({ path, kind, from, to, bytes, mode, baseline: null, baselineMode: 0 });
        continue;
      }
      if (!cloneBlob.has(path) || cloneBlob.get(path) !== laneBlob.get(path))
        throw new Error('the Lane starts from a different version of this file');
      const stat = regular(to);
      if (!stat) throw new Error('the Lane does not hold this file as a regular file');
      const baseline = readFileSync(to);
      if (digest(baseline) !== cloneBlob.get(path)) throw new Error('the Lane file is not the baseline');
      moves.push({ path, kind, from, to, bytes, mode, baseline, baselineMode: stat.mode & 0o777 });
    } catch (error) {
      refuse(error instanceof Error ? error.message.slice(0, 120) : 'could not be checked');
    }
  }
  if (result.skipped.length) return result;
  for (const move of moves) {
    const { path, kind, from, to } = move;
    try {
      if (kind === 'deleted') {
        mkdirSync(dirname(from), { recursive: true });
        rmSync(to);
        writeFileSync(from, move.baseline!);
        chmodSync(from, move.baselineMode);
        result.carried.push(path);
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      if (!realInside(laneRoot, to)) throw new Error('the Lane path leads outside the Lane');
      writeFileSync(to, move.bytes);
      chmodSync(to, move.mode);
      // Only a clone file still holding the copied bytes is restored or removed.
      if (!readFileSync(from).equals(move.bytes))
        throw new Error('changed in the clone while it was moved; left as is');
      if (kind === 'edited') {
        writeFileSync(from, move.baseline!);
        chmodSync(from, move.baselineMode);
      } else {
        rmSync(from);
        for (
          let dir = dirname(from);
          dir !== resolve(cloneRoot) && dir.startsWith(resolve(cloneRoot));
          dir = dirname(dir)
        ) {
          try {
            if (readdirSync(dir).length) break;
            rmdirSync(dir);
          } catch {
            break;
          }
        }
      }
      result.carried.push(path);
    } catch (error) {
      result.skipped.push({
        path,
        reason: error instanceof Error ? error.message.slice(0, 120) : 'could not be moved',
      });
    }
  }
  return result;
}

const isMainClone = (root: string) =>
  existsSync(join(root, '.forge', 'hosted-main.json')) &&
  !existsSync(join(root, '.forge', 'hosted-lane.json'));

/** After a start from a shared main clone: remember the clone for later notices, then either carry the
 * clone's edits into the new Lane (carry) or name them. Never fails the start. */
export function noteCloneEdits(
  root: string,
  laneId: string,
  result: unknown,
  carry: boolean,
  registry: Pick<LaneRegistry, 'record'>,
): unknown {
  try {
    if (!isMainClone(root)) return result;
    registry.record({ laneId, cloneRoot: resolve(root) });
    const edits = cloneLocalEdits(root);
    if (!edits?.count) return result;
    const reply = result as { path?: string; checkout?: { status?: string } };
    if (!carry || !reply.path || reply.checkout?.status === 'incomplete')
      return {
        ...(result as object),
        localEdits: startEditsNotice(root, edits),
        ...(carry
          ? {
              carriedEdits: {
                carried: 0,
                note: 'The Lane checkout is not ready; run start again with carryEdits once it is.',
              },
            }
          : {}),
      };
    const moved = carryCloneEdits(
      root,
      reply.path,
      edits,
      readHostedLaneCheckout(reply.path)?.state.files ?? null,
    );
    const left = edits.count - moved.carried.length;
    return {
      ...(result as object),
      carriedEdits: {
        carried: moved.carried.length,
        files: moved.carried.slice(0, EDIT_LIST_LIMIT),
        ...(moved.carried.length > EDIT_LIST_LIMIT ? { truncated: true } : {}),
        ...(moved.skipped.length
          ? {
              skipped: moved.skipped.slice(0, EDIT_LIST_LIMIT),
              note: `${left} path${left === 1 ? '' : 's'} stay in the clone, untouched.`,
            }
          : { note: 'The clone is clean again.' }),
      },
    };
  } catch {
    return result;
  }
}

const signatureOf = (edits: CloneEdits) =>
  createHash('sha256')
    .update(edits.changes.map(change => `${change.kind}:${change.path}`).join('\n'))
    .digest('hex')
    .slice(0, 16);

/** A save or land from a Lane: when its clone holds edits newer than the Lane's start, one line, once per
 * set (and at most one scan a minute). Whoever made them may be this agent. Null otherwise. */
export function cloneEditsHeadsUp(
  laneId: string | undefined,
  registry: LaneRegistry,
  now = Date.now(),
): string | null {
  try {
    const entry = laneId ? registry.read(laneId) : null;
    if (!laneId || !entry?.cloneRoot || !isMainClone(entry.cloneRoot)) return null;
    if (entry.editsNoticed && now - entry.editsNoticed.at < 60_000) return null;
    const edits = cloneLocalEdits(entry.cloneRoot);
    const signature = edits?.count ? signatureOf(edits) : '';
    if (!edits?.count || edits.newestMs === null || edits.newestMs <= entry.openedAt) {
      if (entry.editsNoticed) registry.record({ laneId, editsNoticed: { at: now, signature } });
      return null;
    }
    const same = entry.editsNoticed?.signature === signature;
    registry.record({ laneId, editsNoticed: { at: now, signature } });
    if (same) return null;
    const names = edits.files
      .slice(0, 5)
      .map(file => JSON.stringify(file.path))
      .join(', ');
    return `${edits.count} edit${edits.count === 1 ? '' : 's'} in the shared clone ${JSON.stringify(entry.cloneRoot)} are newer than this Lane's start (${names}${edits.count > 5 ? ', …' : ''}). ${WHY_EDITS_BELONG_IN_A_LANE} They may be yours: carry them with nforge agent ${shellQuote(entry.cloneRoot)} start '{"outcome":"Keep local edits","carryEdits":true}'.`;
  } catch {
    return null;
  }
}
