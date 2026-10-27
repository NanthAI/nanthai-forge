import { workLocked } from './work-lock.js';
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { effectivePolicy } from './autonomy-policy.js';
import { ForgeError, invariant } from './errors.js';
import { readSource } from './files.js';
import { digest } from './hash.js';
import { durableReplace } from './native-durability.js';
import { NativeSource, type NativeFile } from './native-source.js';
import { readSyncJournal } from './native-sync-journal.js';
import { syncWorkspace } from './native-sync-workspace.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z.object({ head: hash, target: hash.optional(), revision: z.number() });
const noticeSchema = z.object({
  status: z.enum(['updated', 'skipped']),
  head: hash,
  message: z.string(),
  recovery: z.string(),
  undo: z.string(),
});
const journalName = 'work/owner-root.json';
const noticeName = 'work/owner-root-notice.json';
export const ownerRootNotice = (store: WorkStore) => readSyncJournal(store.root, noticeName, noticeSchema);
function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Only inspect selected tracked paths. Untracked and ignored content is neither
 * captured nor eligible for replacement, even if its bytes equal the new file. */
function currentFiles(root: string, from: NativeFile[], to: NativeFile[]) {
  const old = new Map(from.map(file => [file.path, file]));
  const target = new Map(to.map(file => [file.path, file]));
  const current: NativeFile[] = [];
  for (const path of new Set([...old.keys(), ...target.keys()])) {
    invariant(
      path !== '.forge' && !path.startsWith('.forge/'),
      'UNSAFE_PATH',
      'Owner metadata is never source.',
    );
    let blocked = false;
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      const found = stat(join(root, parent));
      if (!found) continue;
      invariant(
        !found.isSymbolicLink(),
        'OWNER_ROOT_DIRTY',
        `Owner path has a symbolic-link parent: ${path}`,
      );
      if (!found.isDirectory()) {
        invariant(
          (old.has(parent) && !target.has(parent)) || (target.has(parent) && !old.has(parent)),
          'OWNER_ROOT_DIRTY',
          `Owner path is blocked: ${path}`,
        );
        blocked = true;
      }
    }
    if (blocked) continue;
    const found = stat(join(root, path));
    if (!found) continue;
    if (found.isDirectory()) {
      invariant(
        (!old.has(path) && target.has(path) && from.some(file => file.path.startsWith(`${path}/`))) ||
          (old.has(path) && !target.has(path) && to.some(file => file.path.startsWith(`${path}/`))),
        'OWNER_ROOT_DIRTY',
        `Untracked directory blocks ${path}`,
      );
      // File/directory transitions may contain only selected source paths.
      const inspect = (directory: string) => {
        for (const name of readdirSync(join(root, directory))) {
          const child = `${directory}/${name}`,
            entry = lstatSync(join(root, child));
          if (entry.isDirectory() && !entry.isSymbolicLink()) inspect(child);
          else
            invariant(
              (old.has(child) || target.has(child)) && entry.isFile() && !entry.isSymbolicLink(),
              'OWNER_ROOT_DIRTY',
              `Untracked owner content blocks ${path}: ${child}`,
            );
        }
      };
      inspect(path);
      continue;
    }
    invariant(
      found.isFile() && !found.isSymbolicLink(),
      'OWNER_ROOT_DIRTY',
      `Owner path is not a regular file: ${path}`,
    );
    const bytes = readSource(root, path, Number.MAX_SAFE_INTEGER);
    invariant(bytes, 'OWNER_ROOT_DIRTY', `Owner path cannot be read safely: ${path}`);
    current.push({ path, blob: digest(bytes), mode: found.mode & 0o111 ? 'executable' : 'file' });
  }
  return current;
}
/** Called under the owner-root lock, after durable Channel publication. A pending
 * target is completed before selecting a newer main; replay can never rewind it. */
export function updateOwnerRoot(store: WorkStore, data: WorkData, explicit = false) {
  invariant(
    store.native && data.nativeHead,
    'UNSUPPORTED_NATIVE_WORK',
    'Owner refresh requires native source.',
  );
  if (!explicit && !effectivePolicy(data).ownerRootUpdates) return undefined;
  const main = data.channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted').at(-1);
  const head = main?.head ?? data.nativeHead;
  const source = new NativeSource(store.root);
  let journal = readSyncJournal(store.root, journalName, journalSchema) ?? {
    head: explicit ? data.nativeHead : (main?.previous ?? data.nativeHead),
    revision: data.revision,
  };
  const recovery = `nforge owner refresh ${quote(store.root)}`;
  try {
    const apply = (target: string, resuming: boolean) => {
      const from = source.state(journal.head).files,
        to = source.state(target).files;
      const current = currentFiles(store.root, from, to);
      // Preflight before publishing a pending plan: a target-looking local edit
      // is still an edit until this operation has begun applying its own plan.
      if (!resuming) {
        const before = new Map(from.map(file => [file.path, `${file.blob}:${file.mode}`]));
        const actual = new Map(current.map(file => [file.path, `${file.blob}:${file.mode}`]));
        invariant(
          [...new Set([...before.keys(), ...actual.keys()])].every(
            path => before.get(path) === actual.get(path),
          ),
          'OWNER_ROOT_DIRTY',
          `Owner tracked files differ from the previous main ${journal.head}; local edits were preserved.`,
        );
        journal = { ...journal, target };
        durableReplace(join(store.root, '.forge', journalName), JSON.stringify(journal));
      }
      syncWorkspace(source, store.root, journal.head, from, to, { current, resuming });
      journal = { head: target, revision: data.revision };
      durableReplace(join(store.root, '.forge', journalName), JSON.stringify(journal));
    };
    if (journal.target) apply(journal.target, true);
    // Validate even an already-current root on explicit requests.
    apply(head, false);
    const notice = {
      status: 'updated' as const,
      head,
      recovery,
      message: `Owner tracked files updated to main ${head}.`,
      undo: `Disable automatic refresh with nforge set-policy ${quote(store.root)} '{"operationId":"${randomUUID()}","ownerRootUpdates":false}'. Accepted source remains retained; restore prior bytes in a Lane for a compensating change.`,
    };
    durableReplace(join(store.root, '.forge', noticeName), JSON.stringify(notice));
    return notice;
  } catch (error) {
    const notice = {
      status: 'skipped' as const,
      head,
      recovery,
      message: `${error instanceof Error ? error.message : 'Owner refresh interrupted.'} Save or move local edits and untracked path collisions, restore tracked files to the last refreshed main, then run: ${recovery}`,
      undo: 'No accepted source was changed. Pending file updates resume with the same guard.',
    };
    durableReplace(join(store.root, '.forge', noticeName), JSON.stringify(notice));
    if (explicit) throw new ForgeError('OWNER_ROOT_REFRESH_SKIPPED', notice.message);
    return notice;
  }
}
/** Workspace refresh has its own lock; file I/O never owns the Work writer lock.
 * Select current main after admission so delayed acceptance replay cannot rewind it. */
export function refreshAcceptedOwnerRoot(store: WorkStore, explicit = false) {
  const policy = effectivePolicy(store.readRecords()?.data() ?? store.load());
  if (!explicit && !policy.ownerRootUpdates) return undefined;
  return workLocked(
    join(store.directory, 'owner-root-lock'),
    () => updateOwnerRoot(store, store.load(), explicit),
    { operation: 'owner root refresh' },
  );
}
export function refreshOwnerRoot(store: WorkStore) {
  return refreshAcceptedOwnerRoot(store, true);
}
