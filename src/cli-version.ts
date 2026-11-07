// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  cliBuildCommit,
  cliInstallation,
  cliPackageRoot,
  cliSelectedBuild,
  retainCliRuntime,
} from './cli-installation.js';
import { cliLandingCommand, waitForCliMeasurement } from './cli-measurement-hold.js';
import { CLI_RUNTIME_WAIT_MS, resolveCliPointer } from './cli-launcher.js';
import { ForgeError } from './errors.js';
import {
  activeCliCanaryRefusal,
  readCliCanaryRefusal,
  canaryCloneHint,
  cliCanaryNotice,
  rememberCanaryClone,
} from './cli-canary.js';

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
/** Commands that never write to Forge. While main moves they keep running on the current build
 * and start the install in the background, even when the last install failed. Writes do the same
 * unless the last background install failed: then they install in the foreground and report it. */
const READ_ACTIONS = new Set([
  'status',
  'planning',
  'show',
  'diff',
  'peers',
  'lanes',
  'observe',
  'landing',
  'wait',
  'preflight',
  'decisions',
  'queue',
  'landings',
  'lane-history',
  'overlap-answers',
  'doctor',
  'candidate',
  'candidates',
  'view',
  'views',
]);
export function cliReadOnlyCommand(args: string[]) {
  if (['agent', 'x'].includes(args[0]!)) return READ_ACTIONS.has(args[2]?.toLowerCase() ?? '');
  return ['status', 'wait', 'docs', 'heavy', 'doctor'].includes(args[0]!);
}
/** A parent CLI that just installed and verified main hands that fact to the child it re-runs the
 * command in, so the child does not repeat the release read. Bound to the parent pid. */
const VERIFIED = 'FORGE_CLI_VERIFIED_RELEASE';
function inheritedVerification(installed: string, installation: string) {
  const value = process.env[VERIFIED];
  delete process.env[VERIFIED];
  return (
    value === `${installed}:${process.ppid}` &&
    cliBuildCommit(cliSelectedBuild(installation) ?? installation) === installed &&
    !existsSync(join(installation, 'rollback.json'))
  );
}
const RUNTIME_ENV = [
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
];
/** Start one detached updater unless one is live or one failed recently. Never waits. */
export async function startBackgroundCliUpdate(
  installation: string,
  root: string,
  released: string,
  args: string[] = [],
): Promise<'started' | 'running' | 'failed'> {
  const { cliUpdateRunning, cliBackgroundUpdateFailedRecently } = await import('./cli-update.js');
  if (cliUpdateRunning(installation)) return 'running';
  if (cliBackgroundUpdateFailedRecently(installation)) return 'failed';
  rememberCanaryClone(installation, canaryCloneHint(args));
  const log = openSync(join(installation, 'update.log'), 'w', 0o600);
  try {
    spawn(
      process.execPath,
      [
        join(root, 'dist', 'cli-entry.js'),
        'update',
        '--background',
        '--release-head',
        released,
        '--directory',
        installation,
      ],
      {
        cwd: installation,
        detached: true,
        stdio: ['ignore', log, log],
        env: childEnv({ allow: RUNTIME_ENV }),
      },
    ).unref();
  } finally {
    closeSync(log);
  }
  return 'started';
}
/** Run the command in a fresh process on the selected build; no command ran in this one. */
async function redispatch(
  installation: string,
  args: string[],
  stdin: string | undefined,
  verified?: string,
) {
  return new Promise<number>((done, reject) => {
    // The concrete build path: a child never resolves `current` while another update switches it.
    const entry = join(resolveCliPointer(installation, 'current'), 'dist', 'cli-entry.js');
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
      env: childEnv({
        allow: RUNTIME_ENV,
        ...(verified ? { extra: { [VERIFIED]: `${verified}:${process.pid}` } } : {}),
      }),
    });
    if (stdin !== undefined) {
      child.stdin?.on('error', error => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error);
      });
      child.stdin?.end(stdin);
    }
    child.once('error', reject);
    child.once('exit', (status, signal) => done(status ?? (signal === 'SIGINT' ? 130 : 1)));
  });
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
  try {
    retainCliRuntime(root, CLI_RUNTIME_WAIT_MS);
  } catch (error) {
    // This build was retired between this process resolving its path and claiming it. Nothing ran
    // yet, so the command runs on the selected build instead of being refused.
    const installation = cliInstallation(root);
    if (
      !(error instanceof ForgeError) ||
      error.code !== 'CLI_RUNTIME_RETIRED' ||
      !installation ||
      !existsSync(join(installation, 'current', 'dist', 'cli-entry.js'))
    )
      throw error;
    process.exitCode = await redispatch(installation, args, options.stdin);
    return false;
  }
  // Local diagnostics must remain available without discovery. These handlers
  // call back after their local argument checks and before valid work begins.
  if (!options.validated && cliLocalArgumentsFirst(args)) return true;
  // Canary child of the updater (ac9c4ed4): this build under test runs one command with no
  // freshness read and no update, so the check itself adds no release reads or recursion.
  if (process.env.FORGE_CLI_CANARY && process.env.FORGE_CLI_CANARY === cliBuildCommit(root)) return true;
  if (args[0] === 'cli') {
    const { cliManageCli } = await import('./cli-rollback.js');
    const output = await cliManageCli(args.slice(1));
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return false;
  }
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
    const selectedBuild = cliSelectedBuild(installation);
    const expectedCurrent = selectedBuild ? cliBuildCommit(selectedBuild) : null;
    const rollbackPath = join(installation, 'rollback.json');
    const restoreMain =
      expectedCurrent === null ||
      (existsSync(rollbackPath) && JSON.parse(readFileSync(rollbackPath, 'utf8')).head === expectedCurrent);
    if (!restoreMain && inheritedVerification(installed, installation)) return true;
    const released = await check(installed, async () => (selected = await source.current()));
    if (released === installed && !restoreMain) return true;
    // A build the canary refused (or an owner rolled back) never strands anyone: reads and writes
    // keep running on the working build, with one notice line, until the back-off ends or main moves.
    const refused = activeCliCanaryRefusal(installation, released);
    if (refused) {
      process.stderr.write(`${cliCanaryNotice(installation, refused, installed)}\n`);
      return true;
    }
    // No command waits for an install or its canary (2a0557b6: a landing waited ~100 s on another
    // updater's canary). Reads and writes run on this complete, vetted build while the next one
    // installs and is smoke-tested beside it in one detached updater; the switch follows its
    // canary, and the next command runs on main. Only a failed background install makes a write
    // install in the foreground, so a broken update never leaves writes silently on old code.
    // An explicit historical rollback (restoreMain) still restores main before any write.
    const reading = cliReadOnlyCommand(args);
    const frozen = existsSync(join(installation, '.freeze'));
    if (expectedCurrent !== null && (reading || (!restoreMain && !frozen))) {
      const state = frozen
        ? 'held by a measurement hold'
        : await startBackgroundCliUpdate(installation, root, released, args).then(
            started =>
              ({
                started: 'is installing',
                running: 'is installing (already running)',
                failed: `last install failed (${join(installation, 'update.log')}); the next write retries it`,
              })[started],
            () => 'could not start installing; the next command tries again',
          );
      if (reading || !state.startsWith('last install failed')) {
        process.stderr.write(
          `Forge CLI main ${released.slice(0, 8)} ${state}; this ${reading ? 'read' : 'write'} ran on ${installed.slice(0, 8)}.\n`,
        );
        return true;
      }
    }
    if (frozen)
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
    rememberCanaryClone(installation, canaryCloneHint(args));
    const result = await updateCli(installation, address, selected, undefined, {
      expectedCurrent,
      lockWaitMs: CLI_UPDATE_WAIT_MS,
      onWait: () => process.stderr.write('Another Forge CLI update is installing; waiting for it.\n'),
    });
    process.stderr.write(
      `Forge CLI selected ${result.cliCommit}.${result.undo ? ` Revert: ${result.undo}` : ''}\n`,
    );
    if (released === installed) return true;
    // A fresh process uses only the completed selected runtime. When that is the release this
    // process just read, the child skips its own read; otherwise it checks main itself.
    process.exitCode = await redispatch(
      installation,
      args,
      options.stdin,
      result.cliCommit === released ? released : undefined,
    );
    return false;
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'CLI_CANARY_FAILED') {
      // The new build failed its smoke test. The previous build is still selected and works.
      const refusal = readCliCanaryRefusal(installation);
      process.stderr.write(
        `${refusal ? cliCanaryNotice(installation, refusal, cliBuildCommit(root)) : error.message}\n`,
      );
      return true;
    }
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
