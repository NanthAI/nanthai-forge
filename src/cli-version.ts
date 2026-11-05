// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cliBuildCommit, cliInstallation, cliPackageRoot, retainCliRuntime } from './cli-installation.js';
import { cliLandingCommand, waitForCliMeasurement } from './cli-measurement-hold.js';
import { CLI_RUNTIME_WAIT_MS } from './cli-launcher.js';
import { ForgeError } from './errors.js';

/** Cache the promise, including failures, so concurrent callers never repeat discovery. */
export function cliVersionCheck() {
  let checked: Promise<string> | undefined;
  return (installed: string, current: () => Promise<{ head: string }>) =>
    (checked ??= current().then(release => (release.head === installed ? installed : release.head)));
}
export const checkCliVersion = cliVersionCheck();
export function cliDeferredCommand(args: string[]) {
  return ['agent', 'x', 'heavy', 'pull', 'clone'].includes(args[0]!);
}
export function cliLocalArgumentsFirst(args: string[]) {
  return !args.length || ['--help', '-h', 'help'].includes(args[0]!) || cliDeferredCommand(args);
}
export async function cliStartup(
  args = process.argv.slice(2),
  root = cliPackageRoot(),
  check = checkCliVersion,
  options: { validated?: boolean; stdin?: string } = {},
): Promise<boolean> {
  // Claim the pinned runtime before any command modules can lazy-load from it.
  // Parallel commands and an update's publication hold the lock for milliseconds: wait, never refuse.
  retainCliRuntime(root, CLI_RUNTIME_WAIT_MS);
  // Local diagnostics must remain available without discovery. These handlers
  // call back after their local argument checks and before valid work begins.
  if (!options.validated && cliLocalArgumentsFirst(args)) return true;
  if (args[0] === 'update') {
    const { cliUpdateCli } = await import('./cli-update.js');
    process.stdout.write(`${JSON.stringify(await cliUpdateCli(args.slice(1)))}\n`);
    return false;
  }
  const installation = cliInstallation(root);
  // Source checkouts remain available for development and exact-Candidate tests.
  if (!installation && existsSync(join(root, 'src', 'cli-entry.ts'))) return true;
  if (!installation)
    throw new ForgeError(
      'CLI_UPDATE_SOURCE_REQUIRED',
      'This CLI has no configured Forge release source. Next: nforge update .',
    );
  if (cliLandingCommand(args)) await waitForCliMeasurement(installation);
  const { cliReleaseSource } = await import('./cli-update-source.js');
  const { readCliSource, updateCli, cliUpdateCommand, CLI_UPDATE_WAIT_MS } = await import('./cli-update.js');
  const next = cliUpdateCommand(installation);
  try {
    const address = readCliSource(installation),
      source = cliReleaseSource(address);
    let selected: Awaited<ReturnType<typeof source.current>> | undefined;
    const installed = cliBuildCommit(root);
    const expectedCurrent = existsSync(join(installation, 'current'))
      ? cliBuildCommit(join(installation, 'current'))
      : null;
    const rollbackPath = join(installation, 'rollback.json');
    const restoreMain =
      expectedCurrent === null ||
      (existsSync(rollbackPath) && JSON.parse(readFileSync(rollbackPath, 'utf8')).head === expectedCurrent);
    const released = await check(installed, async () => (selected = await source.current()));
    if (released === installed && !restoreMain) return true;
    if (existsSync(join(installation, '.freeze')))
      throw new ForgeError(
        'CLI_UPDATE_FROZEN',
        `CLI selection ${expectedCurrent} differs from main ${released}; measurement hold ${join(installation, '.freeze')} prevents updating. Remove the hold, then run ${next}.`,
      );
    if (!selected)
      throw new ForgeError('CLI_UPDATE_REQUIRED', `CLI is behind main ${released}. Next: ${next}`);
    // stdout belongs to the command's result: every update line below goes to stderr.
    process.stderr.write(
      `Forge CLI is behind main ${released.slice(0, 8)}; installing it, then running your command.\n`,
    );
    const result = await updateCli(installation, address, selected, undefined, {
      expectedCurrent,
      lockWaitMs: CLI_UPDATE_WAIT_MS,
      onWait: () => process.stderr.write('Another Forge CLI update is installing; waiting for it.\n'),
    });
    process.stderr.write(
      `Forge CLI selected ${result.cliCommit}.${result.undo ? ` Revert: ${result.undo}` : ''}\n`,
    );
    if (released === installed) return true;
    // A fresh process uses only the completed selected runtime, with its own single freshness check.
    const code = await new Promise<number>((done, reject) => {
      const child = spawn(
        process.execPath,
        [join(installation, 'current', 'dist', 'cli-entry.js'), ...args],
        {
          stdio: options.stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
          env: childEnv({
            allow: [
              'FORGE_AUTH_TOKEN',
              'FORGE_DEPLOYMENT_URL',
              'FORGE_DEPLOYMENT',
              'FORGE_AGENT_NAME',
              'FORGE_ACTOR',
              'FORGE_LAND_CHILD',
              'FORGE_LAND_INVOKED_AT',
              'XDG_STATE_HOME',
              'FORGE_PROJECT_ID',
              'XDG_CONFIG_HOME',
              'XDG_CACHE_HOME',
              'FORGE_CLIENT_SETTINGS',
            ],
          }),
        },
      );
      if (options.stdin !== undefined) {
        child.stdin?.on('error', error => {
          if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error);
        });
        child.stdin?.end(options.stdin);
      }
      child.once('error', reject);
      child.once('exit', (status, signal) => done(status ?? (signal === 'SIGINT' ? 130 : 1)));
    });
    process.exitCode = code;
    return false;
  } catch (error) {
    if (
      error instanceof ForgeError &&
      ['CLI_UPDATE_FROZEN', 'CLI_UPDATE_SOURCE_REQUIRED'].includes(error.code)
    )
      throw error;
    const command =
      error instanceof ForgeError && ['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(error.code)
        ? `${next} --login`
        : next;
    throw new ForgeError(
      'CLI_UPDATE_REQUIRED',
      `Cannot verify or install the released Forge CLI; no command ran. Next: ${command}`,
      undefined,
      { command },
    );
  }
}
