// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
import { checkoutPathStat, installHostedCheckout, stageHostedFiles } from './hosted-checkout-files.js';
import { stateText, textAttributeFiles } from './checkout-text.js';
import { machineObjectsDirectory } from './machine-object-store.js';
import type { NativeFile } from './state/format.js';

/** On the measured Mac path, copy straight from the machine's existing object
 * store and verify each installed inode before running the check. The private
 * object cache still supplies inputs that must be read as raw blobs. */
export async function prepareMachineCheckout(
  checkout: string,
  cache: HostedCheckoutCache,
  transport: CheckoutObjectTransport,
  files: NativeFile[],
  signal: AbortSignal,
  {
    rawBlobs = [],
    machine = process.platform === 'darwin' ? machineObjectsDirectory() : null,
  }: { rawBlobs?: string[]; machine?: string | null } = {},
) {
  const interrupt = () => signal.throwIfAborted();
  interrupt();
  const blobs = files.map(file => file.blob);
  const store = machine && checkoutPathStat(machine);
  // Direct publication renames downloaded objects into the store. A disabled,
  // missing, redirected or cross-volume store uses the ordinary private install.
  if (machine && store && store.isDirectory() && store.dev === checkoutPathStat(cache.root)?.dev) {
    try {
      // Avoid starting the transfer if the optional shared store is read-only.
      await access(machine, constants.W_OK);
      const direct = new HostedCheckoutCache(cache.root, transport, cache.objects, machine, true);
      await direct.ensure(blobs, { installVerifies: true });
      interrupt();
      // Put these few objects in the private store before using their raw bytes.
      // The direct ensure above has already made every Candidate blob available.
      const attributes = textAttributeFiles(files);
      await cache.ensure([...rawBlobs, ...attributes.map(file => file.blob)]);
      interrupt();
      const text = stateText(cache.objects, files);
      const damaged: NativeFile[] = [];
      await mkdir(checkout, { mode: 0o700 });
      await stageHostedFiles(checkout, direct.objects, files, damaged, text, interrupt);
      interrupt();
      if (!damaged.length) return;
    } catch (error) {
      interrupt();
      const code = (error as NodeJS.ErrnoException).code;
      if (
        ![
          'EACCES',
          'EPERM',
          'EROFS',
          'EXDEV',
          'ENOENT',
          'ENOTDIR',
          'EISDIR',
          'ENOSPC',
          'EDQUOT',
          'SOURCE_READ_FAILED',
          'SOURCE_CHANGED',
        ].includes(code ?? '')
      )
        throw error;
    }
    // The ordinary cache verifies reusable objects and refetches misses before
    // rebuilding the whole tree. A cache failure never publishes the partial copy.
    await rm(checkout, { recursive: true, force: true });
  }
  interrupt();
  await cache.ensure(blobs);
  interrupt();
  await mkdir(checkout, { mode: 0o700 });
  await installHostedCheckout(checkout, cache.objects, files, { interrupt, durable: false });
}
