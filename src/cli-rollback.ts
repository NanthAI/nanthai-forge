// SPDX-License-Identifier: Apache-2.0
import { existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  cliBuildCommit,
  cliInstallation,
  cliSelectedBuild,
  permitCliRetirement,
} from './cli-installation.js';
import { selectCliBuild, unretireCliBuild, withCliLock } from './cli-installation.js';
import { canManageCli, ensureCliManager } from './cli-update-install.js';
import { CLI_UPDATE_WAIT_MS, defaultCliInstallation, updateLock } from './cli-update.js';
import { clearCliCanaryRefusal, readCliCanaryRefusal, writeCliCanaryRefusal } from './cli-canary.js';
import { migrateEditHookRunner } from './agent-install-hooks.js';
import { invariant } from './errors.js';
import { shellQuote } from './shell-quote.js';

/** `nforge cli rollback`: atomically select the one retained previous build as current (and
 * manager), keep the build it replaced as the new previous, and hold main's head off until main
 * moves, so the next call does not install the same build again. No network, no release read. */
export async function cliRollback(
  installation: string,
  options: { migrate?: (runner: string) => unknown; lockWaitMs?: number } = {},
) {
  const migrate = options.migrate ?? ((runner: string) => migrateEditHookRunner(runner));
  invariant(
    !existsSync(join(installation, '.freeze')),
    'CLI_UPDATE_FROZEN',
    `CLI selection is held by ${join(installation, '.freeze')}. Remove that measurement hold, then retry.`,
  );
  const { lock } = await updateLock(installation, options.lockWaitMs ?? CLI_UPDATE_WAIT_MS);
  invariant(
    lock,
    'CLI_UPDATE_BUSY',
    'Another CLI update is running; retry nforge cli rollback when it ends.',
  );
  try {
    return withCliLock(installation, () => {
      const current = cliSelectedBuild(installation);
      const previous = cliSelectedBuild(installation, 'previous');
      invariant(
        current && previous,
        'CLI_ROLLBACK_UNAVAILABLE',
        'No previous CLI build is retained. The next successful update keeps one.',
      );
      const target = cliBuildCommit(previous),
        from = cliBuildCommit(current);
      invariant(
        existsSync(join(previous, '.managed-cli')) && existsSync(join(previous, 'dist', 'cli-entry.js')),
        'CLI_ROLLBACK_UNAVAILABLE',
        `The retained previous build ${target.slice(0, 8)} is incomplete.`,
      );
      invariant(target !== from, 'CLI_ROLLBACK_UNAVAILABLE', 'The previous build is the current build.');
      unretireCliBuild(previous);
      // Current moves with one atomic symlink rename; the build being left becomes the previous.
      if (canManageCli(previous)) ensureCliManager(installation, previous, true);
      selectCliBuild(installation, previous);
      selectCliBuild(installation, current, 'previous');
      rmSync(join(installation, 'rollback.json'), { force: true });
      migrate(join(installation, 'current', 'dist', 'agent-edit-hook.js'));
      permitCliRetirement(installation);
      // Hold the head that was left until main moves; going back to it clears the hold.
      const held = readCliCanaryRefusal(installation);
      if (held?.head === target) clearCliCanaryRefusal(installation);
      else
        writeCliCanaryRefusal(installation, {
          head: from,
          at: new Date().toISOString(),
          step: 'rollback',
          reason: 'rolled back by `nforge cli rollback`',
          attempts: 1,
          nextRetryAt: Number.MAX_SAFE_INTEGER,
          hold: true,
          alerted: true,
        });
      return {
        status: 'rolled-back',
        cliCommit: target,
        from,
        installation,
        undo: `nforge cli rollback --directory ${shellQuote(installation)}`,
        notice: `Main ${from.slice(0, 8)} stays off this machine until main moves; nforge update installs it explicitly.`,
      };
    });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
export async function cliManageCli(args: string[]) {
  if (
    !args.length ||
    args.includes('--help') ||
    !['rollback', 'release-key', 'release-sign'].includes(args[0]!)
  )
    return {
      usage:
        'nforge cli rollback [--directory DIR]\nSwitches atomically to the one retained previous CLI build; run it again to switch back.\n' +
        'nforge cli release-key --out FILE\nOwner: creates an Ed25519 release key (mode 0600) and prints its public key.\n' +
        'nforge cli release-sign --key FILE [--state STATE --release N] [--directory DIR]\nOwner: signs released main (or STATE) with its release number and stores the signature.',
    };
  if (args[0] !== 'rollback') {
    const { cliReleaseCommand } = await import('./cli-release-sign.js');
    return cliReleaseCommand(args[0] as 'release-key' | 'release-sign', args.slice(1));
  }
  const flags = args.slice(1);
  let installation = cliInstallation() ?? defaultCliInstallation();
  while (flags.length) {
    const flag = flags.shift()!;
    invariant(flag === '--directory' && flags.length, 'BAD_ARGUMENT', 'Use nforge cli --help.');
    installation = resolve(flags.shift()!);
  }
  return cliRollback(installation);
}
