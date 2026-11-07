// SPDX-License-Identifier: Apache-2.0
import { retainedRootSibling } from './root-paths.js';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  renameSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { createHash } from 'node:crypto';
import { durableReplace, syncDirectory } from './native-durability.js';

function verifiedObject(path: string, id: string) {
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) return false;
    const hash = createHash('sha256'),
      buffer = Buffer.allocUnsafe(128 * 1024);
    let bytes;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, bytes));
    const after = fstatSync(descriptor),
      current = lstatSync(path);
    return (
      hash.digest('hex') === id &&
      before.ino === current.ino &&
      before.dev === current.dev &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs
    );
  } finally {
    closeSync(descriptor);
  }
}

/** true: a verified disposable cache. false: not one. 'unreadable': permissions hide its
 * contents, so nothing about it can be proven and it is never treated as disposable. */
function verifiedLayout(path: string): boolean | 'unreadable' {
  try {
    const directory = lstatSync(path);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    if (readdirSync(path).some(entry => entry !== 'objects')) return false;
    const objects = join(path, 'objects'),
      stat = lstatSync(objects);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    for (const id of readdirSync(objects)) {
      const object = lstatSync(join(objects, id));
      if (
        !/^[a-f0-9]{64}$/.test(id) ||
        !object.isFile() ||
        object.nlink !== 1 ||
        !verifiedObject(join(objects, id), id)
      )
        return false;
    }
    const after = lstatSync(path),
      afterObjects = lstatSync(objects);
    return (
      directory.dev === after.dev &&
      directory.ino === after.ino &&
      directory.mtimeMs === after.mtimeMs &&
      stat.dev === afterObjects.dev &&
      stat.ino === afterObjects.ino &&
      stat.mtimeMs === afterObjects.mtimeMs
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
    throw error;
  }
}
/** A moved directory is never disposable: open editor handles can still change it.
 * Re-verify in private quarantine and restore unexpected bytes without overwriting
 * a recreated source path. The pending receipt makes both renames replayable. */
export type LegacyCacheRecovery = {
  from: string;
  preservedAt: string;
  undo: string;
  status?: 'pending' | 'verified' | 'restored' | 'unexpected';
};
export function preserveMisplacedReadCaches(
  root: string,
  sourceFiles: readonly { path: string }[] = [],
  retain: (receipt: LegacyCacheRecovery) => void = () => {},
  previous: LegacyCacheRecovery[] = [],
) {
  const receipts: LegacyCacheRecovery[] = [];
  const reconcile = (receipt: LegacyCacheRecovery, identity?: { dev: number; ino: number }) => {
    const destination = receipt.preservedAt;
    const moved = lstatSync(destination);
    const layout =
      !identity || (identity.dev === moved.dev && identity.ino === moved.ino)
        ? verifiedLayout(destination)
        : false;
    if (layout === true) {
      receipt.status = 'verified';
    } else {
      // The source can have been recreated by an editor. Never replace it.
      let occupied = false;
      try {
        lstatSync(receipt.from);
        occupied = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      receipt.status = 'unexpected';
      // An unreadable candidate stays in quarantine, outside the checkout: put back, every later
      // check of the tree would fail on it again. Its bytes are retained either way.
      if (!occupied && layout !== 'unreadable') {
        renameSync(destination, receipt.from);
        syncDirectory(root);
        receipt.status = 'restored';
      }
      durableReplace(destination + '.json', JSON.stringify(receipt));
      retain(receipt);
      throw new ForgeError(
        'WORK_CONFLICT',
        layout === 'unreadable'
          ? 'A legacy-cache candidate became unreadable after it was set aside; it is kept outside the checkout at its preservedAt path.'
          : 'Changed legacy-cache candidate contains local content; its bytes are preserved.',
        undefined,
        {
          obstruction: {
            kind: 'extra-source',
            path: receipt.from,
            preservedAt: receipt.status === 'restored' ? receipt.from : destination,
            undo: receipt.undo,
          },
        },
      );
    }
    syncDirectory(root);
    syncDirectory(dirname(destination));
    durableReplace(destination + '.json', JSON.stringify(receipt));
    retain(receipt);
    receipts.push(receipt);
  };
  for (const receipt of previous)
    if (receipt.status === 'pending') {
      try {
        reconcile(receipt);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  for (const name of ['.forge-client', '..forge-client']) {
    const from = join(root, name);
    try {
      const directory = lstatSync(from);
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      if (sourceFiles.some(file => file.path === name || file.path.startsWith(name + '/'))) continue;
      if (verifiedLayout(from) !== true) continue;
      const parent = retainedRootSibling(root, '.kept-read-caches');
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      invariant(
        lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(),
        'UNSAFE_PATH',
        'Legacy cache quarantine must be a real preservation directory.',
      );
      const destination = join(mkdtempSync(join(parent, 'preserved-')), name);
      const receipt: LegacyCacheRecovery = {
        from,
        preservedAt: destination,
        undo: `Move ${destination} back to ${from} when no checkout apply is running.`,
        status: 'pending',
      };
      durableReplace(destination + '.json', JSON.stringify(receipt));
      retain(receipt);
      renameSync(from, destination);
      syncDirectory(parent);
      reconcile(receipt, directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return receipts;
}
