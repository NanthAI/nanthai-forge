// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { NativeSource } from './native-source.js';
import { fingerprintPrivateFile } from './files.js';
import { invariant } from './errors.js';
import { validateRecoveryTables } from './recovery-hosted-validate.js';
import { recoveryObjectSchema, recoveryRowsSchema, type HostedRecovery } from './recovery-hosted-protocol.js';
import { saveObjectSchema } from './hosted-save.js';

type Pin = z.infer<typeof saveObjectSchema>;
/** Every retained object is revalidated before publication. Large blobs are
 * hashed from disk; visited identities live in disposable disk scratch, so the
 * validation heap does not grow with retained history or blob sizes. */
export async function validateRunnerRecovery(directory: string, root: string, recovery: HostedRecovery) {
  const source = new NativeSource(root);
  validateRecoveryTables(directory, source, recovery);
  const scratch = mkdtempSync(join(directory, 'cache-validation-'));
  const checked = async (pin: Pin) => {
    const observed = await fingerprintPrivateFile(join(source.directory, pin.sha256), 'INVALID_WORK_BACKUP');
    invariant(
      observed.sha256 === pin.sha256 && observed.size === pin.size,
      'INVALID_WORK_BACKUP',
      'Retained hosted cache object differs from its selected pin.',
    );
  };
  try {
    let page = recovery.pages;
    while (page) {
      await checked(page);
      page = recoveryRowsSchema.parse(JSON.parse(source.object(page.sha256).toString())).previous;
    }
    const pending = recovery.objects ? [{ ...recovery.objects, nested: true }] : [];
    while (pending.length) {
      const pin = pending.pop()!;
      // An opaque source file may have the same bytes as an inventory node.
      const marker = join(scratch, `${pin.nested ? 'inventory' : 'opaque'}-${pin.sha256}`);
      if (existsSync(marker)) continue;
      await checked(pin);
      writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
      if (!pin.nested) continue;
      const node = recoveryObjectSchema.parse(JSON.parse(source.object(pin.sha256).toString()));
      if (node.previous) pending.push({ ...node.previous, nested: true });
      pending.push({ ...node.object, nested: node.nested });
    }
    const state = source.state(recovery.main.head);
    for (const file of state.files) {
      const observed = await fingerprintPrivateFile(join(source.directory, file.blob), 'INVALID_WORK_BACKUP');
      invariant(observed.sha256 === file.blob, 'INVALID_WORK_BACKUP', 'Accepted source bytes differ.');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
