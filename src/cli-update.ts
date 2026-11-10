// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { ForgeError, invariant } from './errors.js';
import { durableReplace } from './native-durability.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { tryHeavySlot } from './heavy-slots.js';
import { shareDependencies } from './shared-dependencies.js';
import {
  CLI_UPDATE_WAIT_MS,
  cliReleaseSource,
  cliUpdateCommand,
  readCliSource,
  sourceSchema,
  type CliSource,
} from './cli-update-source.js';
export { CLI_UPDATE_WAIT_MS, cliUpdateCommand, readCliSource };
import { cliBuildCommit, cliInstallation, withCliLock } from './cli-installation.js';
import {
  activateCliBuild,
  cliCurrentCommit,
  ensureCliManager,
  installCliBuild,
  canManageCli,
} from './cli-update-install.js';
import { migrateEditHookRunner } from './agent-install-hooks.js';
import type { HostedMain } from './hosted-main.js';
import { clientCacheRoot } from './root-paths.js';
import { processAlive } from './local-process.js';
import { cliPackageRoot } from './cli-installation.js';
import { shellQuote } from './shell-quote.js';
import {
  activeCliCanaryRefusal,
  cliCanaryPreSwitch,
  clearCliCanaryRefusal,
  rememberCanaryClone,
} from './cli-canary.js';
import { checkCliRelease, recordCliReleaseNumber, type ReleaseCheckHooks } from './cli-release-check.js';

/** How long a write command waits for a live concurrent updater (a dead one is reclaimed at once).
 * A normal update takes seconds; this only bounds a wedged updater process. */
/** After a failed background update, reads stop starting new ones for this long. */
export const CLI_BACKGROUND_RETRY_MS = 10 * 60_000;
const failureMark = (installation: string) => join(installation, 'update-failed.json');
/** Live updater on this installation (dead holders do not count). */
export function cliUpdateRunning(installation: string) {
  const slot = join(installation, 'update-lock', '1');
  try {
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - statSync(slot).mtimeMs < 60_000;
    // The slot records the holder's start time next to its pid: a reused pid is not the updater.
    let startTime: string | undefined;
    try {
      startTime = readFileSync(join(slot, 'start'), 'utf8') || undefined;
    } catch {
      /* a legacy slot has no start identity: pid only */
    }
    return processAlive({ pid, startTime });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
export function cliBackgroundUpdateFailedRecently(installation: string) {
  try {
    return Date.now() - statSync(failureMark(installation)).mtimeMs < CLI_BACKGROUND_RETRY_MS;
  } catch {
    return false;
  }
}
export const defaultCliInstallation = () => join(homedir(), '.local', 'share', 'forge-cli');
/** Build and install output is diagnostic only: stdout and stderr are buffered and shown (on stderr)
 * when a step fails. A successful update prints nothing, so the caller's stdout stays one result. */
const OUTPUT_TAIL = 64 * 1024;
export async function cliUpdateRun(cwd: string, args: string[], home?: string) {
  await new Promise<void>((done, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({
        allow: ['XDG_CACHE_HOME'],
        ...(home ? { extra: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') } } : {}),
      }),
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) return done();
      process.stderr.write(output.endsWith('\n') || !output ? output : `${output}\n`);
      reject(new ForgeError('CLI_UPDATE_BUILD_FAILED', `CLI update command failed (${code}).`));
    });
  });
}
/** Wait for another updater (same installation) instead of refusing; null when still busy. */
export async function updateLock(installation: string, waitMs: number, onWait?: () => void) {
  const path = join(installation, 'update-lock');
  let lock = tryHeavySlot(path, 1);
  if (lock || waitMs <= 0) return { lock, waited: false };
  onWait?.();
  const deadline = Date.now() + waitMs;
  for (let delay = 50; !lock && Date.now() < deadline; delay = Math.min(delay * 2, 500)) {
    await new Promise<void>(done => setTimeout(done, delay));
    lock = tryHeavySlot(path, 1);
  }
  return { lock, waited: true };
}
export async function updateCli(
  installation: string,
  address: CliSource,
  selected?: HostedMain,
  dependencies = {
    source: cliReleaseSource(address),
    run: cliUpdateRun,
    migrate: (runner: string) => migrateEditHookRunner(runner),
    // Every auto-update smoke-tests the new build before the switch (canary, ac9c4ed4).
    preSwitch: cliCanaryPreSwitch(installation),
  } as {
    source: Pick<ReturnType<typeof cliReleaseSource>, 'current' | 'checkout'> &
      Partial<Pick<ReturnType<typeof cliReleaseSource>, 'signatures'>>;
    run: typeof cliUpdateRun;
    migrate(runner: string): unknown;
    /** Pre-switch check (canary, ac9c4ed4): runs on the installed-but-not-active build; throwing
     * keeps the previous build selected. Explicit rollback (--state) skips it. */
    preSwitch?: (build: string, head: string) => unknown;
    /** Release keys, transition switch and alert; the compiled ones unless a test supplies its own. */
    releaseCheck?: ReleaseCheckHooks;
  },
  options: {
    expectedCurrent?: string | null;
    rollback?: boolean;
    /** Wait this long for a concurrent updater, then continue from whatever it installed. */
    lockWaitMs?: number;
    onWait?: () => void;
    retireGraceMs?: number;
    /** Background updates: the head the starting read saw. When an earlier updater already
     * selected it, finish without a release read. */
    skipIfCurrent?: string;
  } = {},
) {
  let expectedCurrent =
    options.expectedCurrent !== undefined ? options.expectedCurrent : cliCurrentCommit(installation);
  address = sourceSchema.parse(address);
  mkdirSync(join(installation, 'builds'), { recursive: true, mode: 0o700 });
  invariant(
    !existsSync(join(installation, '.freeze')),
    'CLI_UPDATE_FROZEN',
    `CLI update is held by ${join(installation, '.freeze')}. Remove that measurement hold, then run ${cliUpdateCommand(installation)}.`,
  );
  const { lock, waited } = await updateLock(installation, options.lockWaitMs ?? 0, options.onWait);
  invariant(
    lock,
    'CLI_UPDATE_BUSY',
    `Another CLI update is running. Next: ${cliUpdateCommand(installation)}`,
  );
  let stage: string | undefined;
  try {
    // Only the update-lock holder creates stages, so any stage now is from an updater that died
    // mid-install. It was never selected: current still names the complete previous build.
    for (const name of readdirSync(join(installation, 'builds')))
      if (name.startsWith('.install-'))
        rmSync(join(installation, 'builds', name), { recursive: true, force: true });
    const sourcePath = join(installation, 'source.json');
    if (existsSync(sourcePath))
      invariant(
        JSON.stringify(readCliSource(installation)) === JSON.stringify(address),
        'CLI_UPDATE_SOURCE_CHANGED',
        'Keep the configured Forge CLI source.',
      );
    if (options.skipIfCurrent && cliCurrentCommit(installation) === options.skipIfCurrent)
      return { status: 'current', cliCommit: options.skipIfCurrent, installation, removed: [] };
    // A detached updater that got the lock just after another one refused this head (several
    // commands start one at once) does not repeat its canary inside the back-off.
    if (options.skipIfCurrent && !options.rollback) {
      const refused = activeCliCanaryRefusal(installation, options.skipIfCurrent);
      if (refused)
        throw new ForgeError(
          'CLI_CANARY_FAILED',
          `Pre-switch canary refused build ${options.skipIfCurrent.slice(0, 8)}: ${refused.reason}.`,
        );
    }
    // After waiting: when the other updater moved current, use what it installed from main (no
    // second release read; the next command's own check still sees any newer main). When it
    // failed, current is unchanged and this updater installs the release it already read.
    if (waited && !options.rollback) {
      const installed = cliCurrentCommit(installation);
      if (installed !== expectedCurrent && installed && existsSync(join(installation, 'manager'))) {
        rmSync(failureMark(installation), { force: true });
        return { status: 'current', cliCommit: installed, installation, removed: [] };
      }
      expectedCurrent = installed;
    }
    const release = selected ?? (await dependencies.source.current());
    invariant(
      release.projectId === address.projectId && /^[a-f0-9]{64}$/.test(release.head),
      'CLI_UPDATE_SOURCE_INVALID',
      'Select the configured Forge release State.',
    );
    // A waiter does not repeat a canary the updater it waited for just failed on this head.
    if (waited && !options.rollback) {
      const refused = activeCliCanaryRefusal(installation, release.head);
      if (refused)
        throw new ForgeError(
          'CLI_CANARY_FAILED',
          `Pre-switch canary refused build ${release.head.slice(0, 8)}: ${refused.reason}.`,
        );
    }
    const build = join(installation, 'builds', release.head);
    if (cliCurrentCommit(installation) === release.head) {
      // Adoption/repair and clearing an explicit pin never perform no-op GC.
      const adopt =
        !existsSync(join(installation, 'manager')) ||
        !existsSync(join(installation, 'launcher.mjs')) ||
        (!options.rollback &&
          canManageCli(build) &&
          cliBuildCommit(join(installation, 'manager')) !== release.head);
      if (adopt || (!options.rollback && existsSync(join(installation, 'rollback.json'))))
        withCliLock(installation, () => {
          invariant(
            cliCurrentCommit(installation) === release.head,
            'CLI_UPDATE_CHANGED',
            `Current changed; retry ${cliUpdateCommand(installation)}.`,
          );
          if (adopt) ensureCliManager(installation, build, !options.rollback);
          if (!existsSync(sourcePath)) durableReplace(sourcePath, JSON.stringify(address));
          if (!options.rollback) rmSync(join(installation, 'rollback.json'), { force: true });
        });
      rmSync(failureMark(installation), { force: true });
      return { status: 'current', cliCommit: release.head, installation, removed: [] };
    }
    // Signed releases: checked with this (already installed) build's keys before the new State is
    // downloaded, provisioned or built. Explicit --state selection is the owner's own recovery path.
    const verdict = options.rollback
      ? null
      : await checkCliRelease(
          installation,
          {
            projectId: address.projectId,
            head: release.head,
            ...(dependencies.source.signatures ? { signatures: dependencies.source.signatures } : {}),
          },
          dependencies.releaseCheck,
        );
    const publish = async (prepared?: string) => {
      const input = {
        installation,
        address,
        head: release.head,
        build,
        stage: prepared,
        expectedCurrent,
        rollback: options.rollback,
        migrate: dependencies.migrate,
        retireGraceMs: options.retireGraceMs,
      };
      installCliBuild(input);
      // Nothing to fall back on (first install) means nothing to protect: the canary needs a
      // selected build to keep serving callers when it refuses.
      if (!options.rollback && cliCurrentCommit(installation))
        await dependencies.preSwitch?.(build, release.head);
      return activateCliBuild(input);
    };
    const published = async (result: ReturnType<typeof publish>) => {
      const value = await result;
      rmSync(failureMark(installation), { force: true });
      clearCliCanaryRefusal(installation, release.head);
      // Anti-downgrade floor: the highest verified release number now installed here.
      if (verdict)
        try {
          recordCliReleaseNumber(installation, release.head, verdict);
        } catch {
          /* the next verified update records it */
        }
      return value;
    };
    if (
      existsSync(build) &&
      cliBuildCommit(build) === release.head &&
      existsSync(join(build, '.managed-cli'))
    )
      return await published(publish());
    stage = mkdtempSync(join(installation, 'builds', '.install-'));
    const transferCache = clientCacheRoot(stage);
    try {
      await dependencies.source.checkout(stage, release);
    } finally {
      rmSync(transferCache, { recursive: true, force: true });
    }
    const packageJson = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
    invariant(
      packageJson.name === '@nanthai/forge',
      'CLI_UPDATE_SOURCE_INVALID',
      'CLI releases must come from the Forge source project.',
    );
    const deps = await shareDependencies(stage, {
      enabled: true,
      install: directory =>
        dependencies.run(directory, ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']),
      // The updater is already serialized by update-lock; machine-wide test slots must not stall it.
      heavy: false,
    });
    invariant(
      deps.status === 'linked' || deps.status === 'installed',
      'CLI_UPDATE_DEPENDENCIES_FAILED',
      'Could not provision locked CLI dependencies.',
    );
    // Not a heavy-slot job: ~2 s of tsc, one at a time per installation through update-lock. Queueing
    // behind long test batches is what turned a forced update into a multi-minute stall.
    await dependencies.run(stage, ['npm', 'run', 'build:core']);
    const smokeHome = mkdtempSync(join(stage, '.smoke-home-'));
    try {
      await dependencies.run(stage, [process.execPath, 'dist/cli.js', '--help'], smokeHome);
    } finally {
      rmSync(smokeHome, { recursive: true, force: true });
    }
    invariant(
      existsSync(join(stage, 'dist', 'cli-entry.js')) &&
        existsSync(join(stage, 'dist', 'agent-edit-hook.js')),
      'CLI_UPDATE_BUILD_FAILED',
      'The built CLI and edit hook must both exist.',
    );
    durableReplace(join(stage, '.commit'), release.head);
    writeFileSync(join(stage, '.managed-cli'), '1');
    return await published(publish(stage));
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
/** The other, still existing installation a product launcher file enters, or null when the
 * file is absent, unreadable, not a product launcher, or enters `installation` itself. */
export function launcherElsewhere(bin: string, installation: string): string | null {
  let text: string;
  try {
    text = readFileSync(bin, 'utf8');
  } catch {
    return null;
  }
  const entered = text.match(/^exec\s+'(?:[^']|'\\'')*'\s+'((?:[^']|'\\'')*)\/launcher\.mjs'/m)?.[1];
  if (!entered) return null;
  const dir = entered.replaceAll("'\\''", "'");
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const target = real(dir);
  return target && existsSync(join(target, 'launcher.mjs')) && target !== (real(installation) ?? installation)
    ? dir
    : null;
}
export async function cliUpdateCli(args: string[]) {
  if (args.includes('--help'))
    return {
      usage:
        'nforge update [FORGE_CHECKOUT] [--directory DIR] [--bin FILE] [--state STATE] [--login]\nUpdates from accepted Forge main; --state explicitly selects a retained State for rollback.',
    };
  const flags = [...args];
  let root: string | undefined,
    installation = cliInstallation() ?? defaultCliInstallation(),
    state: string | undefined,
    bin = join(homedir(), '.local', 'bin', 'nforge'),
    binGiven = false,
    login = false,
    background = false,
    expected: string | undefined;
  while (flags.length) {
    const flag = flags.shift()!;
    if (flag === '--login') login = true;
    else if (flag === '--background') background = true;
    else if (flag === '--release-head') {
      expected = flags.shift();
      invariant(expected && /^[a-f0-9]{64}$/.test(expected), 'BAD_ARGUMENT', 'Use a full Forge State hash.');
    } else if (flag === '--directory') {
      const value = flags.shift();
      invariant(value, 'BAD_ARGUMENT', 'Supply --directory DIR.');
      installation = resolve(value);
    } else if (flag === '--bin') {
      const value = flags.shift();
      invariant(value, 'BAD_ARGUMENT', 'Supply --bin FILE.');
      bin = resolve(value);
      binGiven = true;
    } else if (flag === '--state') {
      state = flags.shift();
      invariant(state && /^[a-f0-9]{64}$/.test(state), 'BAD_ARGUMENT', 'Use a full Forge State hash.');
    } else {
      invariant(!root && !flag.startsWith('-'), 'BAD_ARGUMENT', 'Use nforge update --help.');
      root = resolve(flag);
    }
  }
  // Started detached by a read that found main moved: install next to the running build, never
  // wait. A busy updater already does the work; the update lock comes before any release read.
  if (background) {
    invariant(
      !root && !state && !login,
      'BAD_ARGUMENT',
      'nforge update --background takes only --directory and --release-head.',
    );
    try {
      return await updateCli(installation, readCliSource(installation), undefined, undefined, {
        lockWaitMs: 0,
        ...(expected ? { skipIfCurrent: expected } : {}),
      });
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'CLI_UPDATE_BUSY')
        return { status: 'busy', installation };
      // A canary refusal or hold carries its own retry time (canary-refused.json); the generic
      // 10-minute mark would delay a deploy-window retry (Issue 3205f7e6).
      if (error instanceof ForgeError && error.code === 'CLI_CANARY_FAILED') throw error;
      durableReplace(
        failureMark(installation),
        JSON.stringify({ code: error instanceof ForgeError ? error.code : 'CLI_UPDATE_FAILED' }),
      );
      throw error;
    }
  }
  const address = root ? hostedAgentAddress(root, {}) : readCliSource(installation);
  rememberCanaryClone(installation, root);
  invariant(
    address,
    'CLI_UPDATE_SOURCE_REQUIRED',
    'Select a hosted Forge source checkout: nforge update FORGE_CHECKOUT.',
  );
  if (login) {
    const { authCli } = await import('./auth-cli.js');
    await authCli('login', [address.url]);
  }
  let source: ReturnType<typeof cliReleaseSource>;
  try {
    source = cliReleaseSource(address);
  } catch (error) {
    if (!(error instanceof ForgeError) || !['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(error.code))
      throw error;
    const command = `nforge update ${root ? shellQuote(root) + ' ' : ''}--directory ${shellQuote(installation)} --login`;
    throw new ForgeError(
      'CLI_UPDATE_AUTH_REQUIRED',
      `Sign in through the updater before checking the release. Next: ${command}`,
      undefined,
      { command },
    );
  }
  let expectedCurrent = cliCurrentCommit(installation);
  const selected = await source.current();
  if (state && !existsSync(join(installation, 'manager'))) {
    const initialized = await updateCli(installation, address, selected, undefined, {
      expectedCurrent,
      lockWaitMs: CLI_UPDATE_WAIT_MS,
    });
    expectedCurrent = cliCurrentCommit(installation);
    process.stderr.write(
      `Forge initialized the update controller at ${initialized.cliCommit}; selecting requested State ${state}.\n`,
    );
  }
  const result = await updateCli(
    installation,
    address,
    state ? { ...selected, head: state } : selected,
    undefined,
    { expectedCurrent, rollback: !!state, lockWaitMs: CLI_UPDATE_WAIT_MS },
  );
  // The default launcher belongs to one installation: an update of another one (a bench's own
  // CLI home) keeps it unless --bin names it, so it never repoints the user's `nforge`.
  const other = binGiven ? null : launcherElsewhere(bin, installation);
  if (other)
    process.stderr.write(
      `Kept ${bin}: it enters ${other}. Pass --bin FILE to write a launcher for ${installation}.\n`,
    );
  else {
    mkdirSync(resolve(bin, '..'), { recursive: true, mode: 0o700 });
    durableReplace(
      bin,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(installation, 'launcher.mjs'))} \"$@\"\n`,
      0o755,
    );
  }
  const packageRoot = cliPackageRoot();
  if (!cliInstallation(packageRoot) && !existsSync(join(packageRoot, 'src', 'cli-entry.ts')))
    durableReplace(join(packageRoot, '.cli-installation'), installation);
  return {
    ...result,
    bin: other ? null : bin,
    run: `${shellQuote(process.execPath)} ${shellQuote(join(installation, 'launcher.mjs'))}`,
    ...(state
      ? { notice: 'Explicit rollback selected. The next ordinary invocation checks main again.' }
      : {}),
  };
}
