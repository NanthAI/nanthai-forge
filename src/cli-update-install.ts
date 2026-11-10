// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { durableReplace, syncDirectory } from './state/durability.js';
import {
  CLI_RETIRE_GRACE_MS,
  cliBuildCommit,
  cliSelectedBuild,
  permitCliRetirement,
  pruneCliBuilds,
  selectCliBuild,
  unretireCliBuild,
  withCliLock,
} from './cli-installation.js';
import { invariant } from './errors.js';
import { canonicalRoot } from './root-paths.js';
import { shellQuote } from './shell-quote.js';
import type { CliSource } from './cli-update-source.js';

export const cliCurrentCommit = (installation: string) => {
  const current = cliSelectedBuild(installation);
  return current ? cliBuildCommit(current) : null;
};
export const canManageCli = (build: string) =>
  existsSync(join(build, 'dist', 'cli-version.js')) && existsSync(join(build, 'dist', 'cli-launcher.js'));
export function ensureCliManager(installation: string, build: string, promote = true) {
  if (promote && canManageCli(build)) selectCliBuild(installation, build, 'manager');
  const pointer = join(installation, 'manager');
  invariant(
    existsSync(pointer),
    'CLI_UPDATE_MANAGER_REQUIRED',
    'Initialize the updater from Forge main before selecting this runtime.',
  );
  const bytes = readFileSync(join(pointer, 'dist', 'cli-launcher.js'));
  const launcher = join(installation, 'launcher.mjs');
  if (!existsSync(launcher) || !readFileSync(launcher).equals(bytes)) durableReplace(launcher, bytes);
}
type PublishInput = {
  installation: string;
  address: CliSource;
  head: string;
  build: string;
  stage?: string | undefined;
  expectedCurrent: string | null;
  rollback?: boolean | undefined;
  migrate(runner: string): unknown;
  /** How long replaced builds stay on disk; see CLI_RETIRE_GRACE_MS. */
  retireGraceMs?: number | undefined;
};
/** Step 1 of 2: make a complete, smoke-checked stage an installed build at `builds/HEAD`.
 * INSTALLED BUT NOT ACTIVE: nothing selects it yet, every running and new CLI keeps using
 * `current`. A pre-switch check (canary, ac9c4ed4) runs between this and activateCliBuild. */
export function installCliBuild(input: Pick<PublishInput, 'installation' | 'head' | 'build' | 'stage'>) {
  const { installation, build, head } = input;
  withCliLock(installation, () => {
    if (existsSync(build))
      invariant(
        cliBuildCommit(build) === head && existsSync(join(build, '.managed-cli')),
        'CLI_UPDATE_BUILD_OBSTRUCTED',
        'Preserve the obstructing build directory.',
      );
    else {
      invariant(input.stage, 'CLI_UPDATE_BUILD_FAILED', 'The selected build is unavailable.');
      renameSync(input.stage, build);
      syncDirectory(join(installation, 'builds'));
    }
    unretireCliBuild(build);
  });
  return build;
}
/** Step 2 of 2, the one switch: atomically select an installed build as manager and current,
 * migrate hooks, then retire older builds after the grace. In-flight processes keep the build
 * they started on (leases + grace). */
export function activateCliBuild(input: PublishInput) {
  const { installation, build, head, address } = input;
  const next = `nforge update --directory ${shellQuote(installation)}`;
  // Selection is atomic and short under the runtime lock; pruning runs afterwards with its own
  // brief fence, so concurrent CLI starts never wait behind process inspection or deletion.
  const published = withCliLock(installation, () => {
    invariant(
      !existsSync(join(installation, '.freeze')),
      'CLI_UPDATE_FROZEN',
      `Measurement hold appeared during the update. Remove ${join(installation, '.freeze')}, then run ${next}.`,
    );
    const previous = cliCurrentCommit(installation);
    const previousBuild = cliSelectedBuild(installation);
    invariant(
      previous === input.expectedCurrent || previous === head,
      'CLI_UPDATE_CHANGED',
      `Another update changed current while this release was being checked. Current was preserved. Next: ${next}`,
    );
    invariant(
      cliBuildCommit(build) === head && existsSync(join(build, '.managed-cli')),
      'CLI_UPDATE_BUILD_FAILED',
      'Install the build before activating it.',
    );
    unretireCliBuild(build);
    ensureCliManager(installation, build, !input.rollback);
    durableReplace(join(installation, 'source.json'), JSON.stringify(address));
    selectCliBuild(installation, build);
    // Exactly one previous build is kept for `nforge cli rollback` (exempt from pruning).
    if (previousBuild && canonicalRoot(previousBuild) !== canonicalRoot(build))
      selectCliBuild(installation, previousBuild, 'previous');
    if (input.rollback) durableReplace(join(installation, 'rollback.json'), JSON.stringify({ head }));
    else rmSync(join(installation, 'rollback.json'), { force: true });
    // Old and new runners remain valid until both client settings have migrated.
    input.migrate(join(installation, 'current', 'dist', 'agent-edit-hook.js'));
    permitCliRetirement(installation);
    return previous;
  });
  let removed: string[] = [];
  try {
    removed = pruneCliBuilds(installation, undefined, input.retireGraceMs ?? CLI_RETIRE_GRACE_MS);
  } catch {
    /* Selection already succeeded; unremoved builds are retried by the next update. */
  }
  return {
    status: 'updated',
    cliCommit: head,
    installation,
    removed,
    ...(published && /^[a-f0-9]{64}$/.test(published) ? { undo: `${next} --state ${published}` } : {}),
  };
}
/** Install then activate with no check in between (explicit selection and tests). */
export function publishCliBuild(input: PublishInput) {
  installCliBuild(input);
  return activateCliBuild(input);
}
