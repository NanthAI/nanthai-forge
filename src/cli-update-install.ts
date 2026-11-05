// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { durableReplace, syncDirectory } from './native-durability.js';
import {
  cliBuildCommit,
  permitCliRetirement,
  pruneCliBuilds,
  selectCliBuild,
  withCliLock,
} from './cli-installation.js';
import { invariant } from './errors.js';
import { shellQuote } from './shell-quote.js';
import type { CliSource } from './cli-update-source.js';

export const cliCurrentCommit = (installation: string) =>
  existsSync(join(installation, 'current')) ? cliBuildCommit(join(installation, 'current')) : null;
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
export function publishCliBuild(input: {
  installation: string;
  address: CliSource;
  head: string;
  build: string;
  stage?: string | undefined;
  expectedCurrent: string | null;
  rollback?: boolean | undefined;
  migrate(runner: string): unknown;
}) {
  const { installation, build, head, address } = input;
  const next = `nforge update --directory ${shellQuote(installation)}`;
  return withCliLock(installation, () => {
    invariant(
      !existsSync(join(installation, '.freeze')),
      'CLI_UPDATE_FROZEN',
      `Measurement hold appeared during the update. Remove ${join(installation, '.freeze')}, then run ${next}.`,
    );
    const previous = cliCurrentCommit(installation);
    invariant(
      previous === input.expectedCurrent || previous === head,
      'CLI_UPDATE_CHANGED',
      `Another update changed current while this release was being checked. Current was preserved. Next: ${next}`,
    );
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
    ensureCliManager(installation, build, !input.rollback);
    durableReplace(join(installation, 'source.json'), JSON.stringify(address));
    selectCliBuild(installation, build);
    if (input.rollback) durableReplace(join(installation, 'rollback.json'), JSON.stringify({ head }));
    else rmSync(join(installation, 'rollback.json'), { force: true });
    // Old and new runners remain valid until both client settings have migrated.
    input.migrate(join(installation, 'current', 'dist', 'agent-edit-hook.js'));
    permitCliRetirement(installation);
    const removed = pruneCliBuilds(installation);
    return {
      status: 'updated',
      cliCommit: head,
      installation,
      removed,
      ...(previous && /^[a-f0-9]{64}$/.test(previous) ? { undo: `${next} --state ${previous}` } : {}),
    };
  });
}
