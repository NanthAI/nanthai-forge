// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { NativeSource } from './native-source.js';
import { WorkStore } from './work-store.js';
import { restoreNativeWork } from './native-backup.js';
import { withWorkArchive } from './work-backup-archive.js';
import { workSourcePins } from './work-archive-metadata.js';
import { startNativeContribution, registerNativeContribution } from './native-contribution-register.js';
import {
  nativeContributionCommandSchema,
  type NativeContributionCommand,
} from './native-contribution-types.js';

const request = (c: NativeContributionCommand) =>
  digest(
    JSON.stringify({
      action: c.action,
      intentId: c.intentId,
      expectedBase: c.expectedBase,
      expectedHead: c.expectedHead,
      archiveSha256: c.archiveSha256,
      name: c.name,
      ...(c.claim ? { claim: c.claim } : {}),
    }),
  );

export async function importNativeContribution(store: WorkStore, input: unknown, revision: number) {
  const parsed = nativeContributionCommandSchema.safeParse(input);
  invariant(
    parsed.success && Number.isSafeInteger(revision) && revision >= 0,
    'BAD_ARGUMENT',
    'Select exact native archive, base and candidate pins.',
  );
  invariant(store.native, 'UNSUPPORTED_NATIVE_WORK', 'Native source contributions need a native Work owner.');
  const command = parsed.data;
  const initial = startNativeContribution(
    store,
    {
      id: command.operationId,
      request: request(command),
      intentId: command.intentId,
      base: command.expectedBase,
      provenance: 'unverified-native-archive',
    },
    revision,
  );
  if (initial.original) return initial.original;
  invariant(isAbsolute(command.archivePath), 'BAD_ARGUMENT', 'Choose an absolute local native archive path.');
  const use = async (directory: string, archive: { sha256: string; size: number }) => {
    invariant(
      archive.sha256 === command.archiveSha256,
      'INVALID_CONTRIBUTION',
      'The native archive differs from its selected digest.',
    );
    const scratch = mkdtempSync(join(tmpdir(), 'forge-contribution-'));
    try {
      // Full existing restore validates manifest bytes and complete reachable
      // source/evidence closure. Its Work lives only in temporary storage.
      const owner = join(scratch, 'owner');
      await restoreNativeWork(directory, owner);
      const incoming = new WorkStore(owner),
        original = incoming.load(),
        source = new NativeSource(owner),
        ancestry = source.ancestry();
      invariant(
        workSourcePins(original).includes(command.expectedHead) &&
          ancestry.contains(command.expectedHead, command.expectedBase),
        'CONTRIBUTION_CHANGED',
        'The selected candidate must be retained and descend from this Intent’s original base.',
      );
      if (command.claim)
        invariant(
          original.views.some(
            view =>
              view.id === command.claim!.viewId &&
              view.intentId === command.intentId &&
              view.base === command.expectedBase &&
              view.head === command.expectedHead &&
              view.status === 'clean',
          ),
          'CONTRIBUTION_CHANGED',
          'The selected proposal View differs from its original native candidate.',
        );
      const ids = new Set<string>();
      for (const id of ancestry.ancestors(command.expectedHead)) {
        ids.add(id);
        const state = source.state(id);
        for (const file of state.files) {
          source.object(file.blob);
          ids.add(file.blob);
        }
        if (state.git) {
          source.object(state.git.bundle);
          ids.add(state.git.bundle);
        }
      }
      const receipt = {
        id: command.operationId,
        request: request(command),
        intentId: command.intentId,
        base: command.expectedBase,
        head: command.expectedHead,
        archiveSha256: archive.sha256,
        size: archive.size,
        at: new Date().toISOString(),
        provenance: 'unverified-native-archive' as const,
        ...(command.claim ? { claim: command.claim } : {}),
      };
      return registerNativeContribution(
        store,
        initial.current!,
        revision,
        receipt,
        command.name,
        source,
        ids,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const manifestPath = join(command.archivePath, 'manifest.json');
  if (existsSync(manifestPath)) {
    const bytes = readFileSync(manifestPath);
    return use(realpathSync(command.archivePath), { sha256: digest(bytes), size: bytes.length });
  }
  return withWorkArchive(command.archivePath, use);
}
