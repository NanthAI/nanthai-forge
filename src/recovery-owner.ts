// SPDX-License-Identifier: Apache-2.0
import { existsSync, realpathSync, mkdirSync, lstatSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { recoveryPreparationSchema, recoveryRequestSchema } from './recovery-protocol.js';
import { recoveryTransport } from './recovery-transport.js';
import { recoverNativeOwner } from './recovery-native-owner.js';
import { recoverRunner } from './recovery-runner.js';
import { serverRecoveryAuthority } from './recovery-authority.js';
import { readHostState } from './host-binding.js';
import { WorkStore } from './work-store.js';
import { nativeOwner } from './native-source.js';
import type { RecoveryTransport } from './recovery-source.js';
import type { RunnerRecoveryTransport } from './recovery-runner-transport.js';

/** Discover current authority before choosing Route B. Merely being bound never
 * removes native recovery or local acceptance, including native-owner rollback. */
export async function recoverOwner(target: string, input: unknown, supplied?: RecoveryTransport) {
  const request = recoveryRequestSchema.parse(input),
    parent = realpathSync(dirname(resolve(target))),
    root = join(parent, basename(resolve(target))),
    directory = join(parent, `.forge-recovery-${digest(root).slice(0, 12)}-${request.operationId}`);
  invariant(
    !existsSync(root) ||
      existsSync(join(directory, 'state.json')) ||
      existsSync(join(directory, 'runner.json')),
    'RESTORE_TARGET_EXISTS',
    'Choose a fresh recovery destination; existing work is preserved.',
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  invariant(
    lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
    'UNSAFE_PATH',
    'Recovery staging must be a real directory.',
  );
  const prepared = recoveryPreparationSchema.parse(await (supplied ?? recoveryTransport(request)).prepare());
  const selected = prepared.selection ?? prepared.receipt?.selection;
  invariant(selected, 'SOURCE_UNAVAILABLE', 'The recovery source selection is unavailable.');
  const local =
    existsSync(root) && nativeOwner(root)
      ? readHostState(new WorkStore(root))
      : { authorityTransition: undefined };
  const server = serverRecoveryAuthority({
    binding: { sourceAuthority: prepared.authority ?? selected.authority },
    authorityTransition: local.authorityTransition,
  });
  // Existing progress pins the route, just as each restorer pins its source.
  // An authority change can fence an old route; it cannot substitute a new one.
  if (existsSync(join(directory, 'state.json'))) return recoverNativeOwner(target, input, supplied);
  if (existsSync(join(directory, 'runner.json')))
    return recoverRunner(target, input, supplied as RunnerRecoveryTransport | undefined);
  return server
    ? recoverRunner(target, input, supplied as RunnerRecoveryTransport | undefined)
    : recoverNativeOwner(target, input, supplied);
}

export { reconnectOwner } from './recovery-native-owner.js';
export { recoverRunner } from './recovery-runner.js';
