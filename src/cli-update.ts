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
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { ForgeError, invariant } from './errors.js';
import { durableReplace } from './state/durability.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import {
  acquireHeavySlot,
  HEAVY_KILL_GRACE_MS,
  heavySlotDirectory,
  inheritedHeavySlot,
  tryHeavySlot,
  waitingMessage,
} from './heavy-slots.js';
import { recordHold } from './heavy-queue.js';
import { heavySlots, readClientSettings } from './client-settings.js';
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
import {
  cliBuildCommit,
  cliBuildPackage,
  cliInstallation,
  cliPackageRoot,
  stableSelection,
  withCliLock,
  writeStableSelection,
  type StableSelection,
} from './cli-installation.js';
import {
  activateCliBuild,
  cliCurrentCommit,
  ensureCliManager,
  installCliBuild,
  canManageCli,
} from './cli-update-install.js';
import { migrateEditHookRunner } from './agent-install-hooks.js';
import type { HostedMain } from './hosted-main.js';
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { processAlive } from './local-process.js';
import { shellQuote } from './shell-quote.js';
import { mkdirBelow } from './mkdir-below.js';
import {
  activeCliCanaryRefusal,
  cliCanaryPreSwitch,
  clearCliCanaryRefusal,
  rememberCanaryClone,
} from './cli-canary.js';
import { checkCliRelease, recordCliReleaseNumber, type ReleaseCheckHooks } from './cli-release-check.js';
import {
  recordStableCheck,
  requireStableRuntime,
  stableCheckDue,
  stableReleaseTarget,
} from './cli-stable.js';

/** How long a write command waits for a live concurrent updater (a dead one is reclaimed at once).
 * A normal update takes seconds; this only bounds a wedged updater process. */
/** After a failed background update, reads stop starting new ones for this long. */
export const CLI_BACKGROUND_RETRY_MS = 10 * 60_000;
const failureMark = (installation: string) => join(installation, 'update-failed.json');
/** Live updater on this installation (dead holders do not count). */
export function cliUpdateRunning(installation: string) {
  return ['update-lock', 'background-update-lock'].some(name =>
    updateLockRunning(join(installation, name, '1')),
  );
}
function updateLockRunning(slot: string) {
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
type UpdateBuildCommand = { env: Record<string, string>; maxMs: number };
export async function cliUpdateRun(cwd: string, args: string[], home?: string, build?: UpdateBuildCommand) {
  await new Promise<void>((done, reject) => {
    const group = !!build && process.platform !== 'win32';
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      detached: group,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({
        allow: ['XDG_CACHE_HOME'],
        extra: {
          ...build?.env,
          ...(home ? { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') } : {}),
        },
      }),
    });
    let stopped = false;
    let kill: NodeJS.Timeout | undefined;
    function signalChild(signal: NodeJS.Signals) {
      if (!child.pid) return;
      if (!group) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    function stop(signal: NodeJS.Signals) {
      stopped = true;
      signalChild(signal);
      kill ??= setTimeout(() => signalChild('SIGKILL'), HEAVY_KILL_GRACE_MS);
    }
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(
      signal => [signal, () => stop(signal)] as const,
    );
    if (build) for (const [signal, handler] of handlers) process.on(signal, handler);
    const bound = build && build.maxMs > 0 ? setTimeout(() => stop('SIGTERM'), build.maxMs) : undefined;
    function cleanup() {
      clearTimeout(bound);
      clearTimeout(kill);
      if (build) for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      // The shell can exit on SIGTERM before all its descendants do.
      if (stopped) signalChild('SIGKILL');
      cleanup();
      if (code === 0 && !stopped) return done();
      process.stderr.write(output.endsWith('\n') || !output ? output : `${output}\n`);
      reject(new ForgeError('CLI_UPDATE_BUILD_FAILED', `CLI update command failed (${signal ?? code}).`));
    });
  });
}
type UpdateBuildLease = { command(): UpdateBuildCommand; release(): void };
/** The ordinary heavy FIFO, taken before the installation lock to avoid lock inversion
 * with foreground updaters already inside heavy. Only a missing build takes a lease. */
async function updateBuildLease(installation: string, inherited: string | null): Promise<UpdateBuildLease> {
  const { sampleHold, slotCapEnv } = (await import(
    /* @vite-ignore */ new URL('./heavy-hold.js', import.meta.url).href
  )) as typeof import('./heavy-hold.js');
  const directory = heavySlotDirectory();
  const slots = () => heavySlots(readClientSettings().localHeavySlots);
  const slot = inherited
    ? null
    : await acquireHeavySlot(
        directory,
        slots,
        wait => process.stderr.write(waitingMessage(slots(), directory, wait)),
        { command: 'cli-update-build', cwd: installation },
      );
  const startedAt = Date.now();
  let cap: ReturnType<typeof slotCapEnv> | undefined;
  let sampler: ReturnType<typeof sampleHold> | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      cap?.dispose();
    } finally {
      if (slot) {
        try {
          if (readFileSync(join(slot, 'pid'), 'utf8') === String(process.pid))
            rmSync(slot, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        recordHold(directory, Date.now() - startedAt, {
          at: startedAt,
          kind: 'build',
          ...(sampler?.stop() ?? {}),
        });
      }
    }
  };
  const writeHolder = (maxMs: number) => {
    if (slot)
      writeFileSync(
        join(slot, 'holder.json'),
        JSON.stringify({ startedAt: Date.now(), command: 'cli-update-build', maxMs }),
      );
  };
  try {
    if (slot) {
      writeHolder(0);
      sampler = sampleHold(process.pid);
    }
    cap = slotCapEnv(
      childEnv({ allow: ['GOMAXPROCS', 'RAYON_NUM_THREADS'] }),
      availableParallelism(),
      slots(),
    );
    const env = {
      ...cap.env,
      FORGE_HEAVY_DIR: directory,
      FORGE_HEAVY_PARENT: slot
        ? JSON.stringify({ directory: canonicalRoot(directory), slot: basename(slot), pid: process.pid })
        : process.env.FORGE_HEAVY_PARENT!,
    };
    return {
      command() {
        const maxMs = slot ? Math.round(readClientSettings().localHeavyMaxMinutes * 60_000) : 0;
        writeHolder(maxMs);
        return { env, maxMs };
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
/** Wait for another updater (same installation) instead of refusing; null when still busy. */
export async function updateLock(installation: string, waitMs: number, onWait?: () => void) {
  const path = join(installation, 'update-lock');
  const attempt = () => {
    mkdirBelow(installation, path);
    return tryHeavySlot(path, 1, process.pid, true, false);
  };
  let lock = attempt();
  if (lock || waitMs <= 0) return { lock, waited: false };
  onWait?.();
  const deadline = Date.now() + waitMs;
  for (let delay = 50; !lock && Date.now() < deadline; delay = Math.min(delay * 2, 500)) {
    await new Promise<void>(done => setTimeout(done, delay));
    lock = attempt();
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
  options: UpdateCliOptions = {},
) {
  const result = await updateCliLocked(installation, address, selected, dependencies, options);
  if (!('buildRequired' in result)) return result;
  const lease = await updateBuildLease(installation, result.inherited);
  try {
    const installed = await updateCliLocked(
      installation,
      address,
      result.buildRequired,
      dependencies,
      {
        ...options,
        expectedCurrent: result.expectedCurrent,
        expectedStable: result.expectedStable,
      },
      lease,
    );
    if ('buildRequired' in installed) throw new Error('CLI update did not receive its claimed build slot');
    return installed;
  } finally {
    lease.release();
  }
}

type UpdateCliOptions = {
  expectedCurrent?: string | null;
  stable?: StableSelection;
  expectedStable?: StableSelection | null;
  stableCheck?: boolean;
  rollback?: boolean;
  /** Wait this long for a concurrent updater, then continue from whatever it installed. */
  lockWaitMs?: number;
  onWait?: () => void;
  retireGraceMs?: number;
  /** Background updates: the head the starting read saw. When an earlier updater already
   * selected it, finish without a release read. */
  skipIfCurrent?: string;
  /** The installation already exists (a background updater inside it): never recreate it. A
   * detached updater outliving its deleted installation then fails with ENOENT. */
  installed?: boolean;
};
type UpdateResult = {
  status: string;
  cliCommit: string | null;
  installation: string;
  removed: string[];
  undo?: string;
};
type UpdateBuildRequired = {
  buildRequired: HostedMain;
  expectedCurrent: string | null;
  expectedStable: StableSelection | null;
  inherited: string | null;
};

async function updateCliLocked(
  installation: string,
  address: CliSource,
  selected: HostedMain | undefined,
  dependencies: NonNullable<Parameters<typeof updateCli>[3]>,
  options: UpdateCliOptions,
  buildLease?: UpdateBuildLease,
): Promise<UpdateResult | UpdateBuildRequired> {
  let expectedCurrent =
    options.expectedCurrent !== undefined ? options.expectedCurrent : cliCurrentCommit(installation);
  address = sourceSchema.parse(address);
  if (options.installed) mkdirBelow(installation, join(installation, 'builds'));
  else mkdirSync(join(installation, 'builds'), { recursive: true, mode: 0o700 });
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
    const installedStable = stableSelection(installation, true);
    if (options.expectedStable !== undefined)
      invariant(
        JSON.stringify(installedStable) === JSON.stringify(options.expectedStable),
        'CLI_UPDATE_CHANGED',
        `The CLI selection changed while waiting for a build slot. Next: ${cliUpdateCommand(installation)}.`,
      );
    const stable = options.stable ?? installedStable;
    invariant(
      !stable || !options.rollback,
      'BAD_ARGUMENT',
      'Use nforge update --pin STATE to select an exact signed build on stable.',
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
    if ((waited || buildLease) && !options.rollback) {
      const installed = cliCurrentCommit(installation);
      if (installed !== expectedCurrent && installed && existsSync(join(installation, 'manager'))) {
        invariant(
          !options.stable,
          'CLI_UPDATE_CHANGED',
          `Current changed; retry ${cliUpdateCommand(installation)} with the original options.`,
        );
        invariant(
          !buildLease || !existsSync(join(installation, 'rollback.json')),
          'CLI_UPDATE_CHANGED',
          `The selected CLI changed to a historical State while waiting for a build slot. Next: ${cliUpdateCommand(installation)}.`,
        );
        rmSync(failureMark(installation), { force: true });
        return { status: 'current', cliCommit: installed, installation, removed: [] };
      }
      expectedCurrent = installed;
    }
    let release = selected;
    if (!release && stable) {
      if (options.stableCheck && !stableCheckDue(installation))
        return { status: 'deferred', cliCommit: cliCurrentCommit(installation), installation, removed: [] };
      recordStableCheck(installation);
      const observed = await dependencies.source.current({ stable: true });
      // The stable extension only exists on a v2 provider. A legacy reply carries no new floor.
      invariant(observed.schema === 2, 'CLI_UPDATE_SOURCE_INVALID', 'Read a current Forge release source.');
      release = stableReleaseTarget(installation, observed, stable);
      if (options.stableCheck && stable.pin)
        return { status: 'pinned', cliCommit: stable.pin, installation, removed: [] };
      if (options.stableCheck && activeCliCanaryRefusal(installation, release.head))
        return { status: 'held', cliCommit: cliCurrentCommit(installation), installation, removed: [] };
    }
    release ??= await dependencies.source.current();
    invariant(
      release.projectId === address.projectId && /^[a-f0-9]{64}$/.test(release.head),
      'CLI_UPDATE_SOURCE_INVALID',
      'Select the configured Forge release State.',
    );
    // A waiter does not repeat a canary the updater it waited for just failed on this head.
    if ((waited || buildLease) && !options.rollback) {
      const refused = activeCliCanaryRefusal(installation, release.head);
      if (refused)
        throw new ForgeError(
          'CLI_CANARY_FAILED',
          `Pre-switch canary refused build ${release.head.slice(0, 8)}: ${refused.reason}.`,
        );
    }
    const build = join(installation, 'builds', release.head);
    const verifyRelease = () =>
      checkCliRelease(
        installation,
        {
          projectId: address.projectId,
          head: release.head,
          ...(stable ? { stable: true, exact: !!stable.pin } : {}),
          ...(dependencies.source.signatures ? { signatures: dependencies.source.signatures } : {}),
        },
        dependencies.releaseCheck,
      );
    const rememberRelease = (verdict: Awaited<ReturnType<typeof verifyRelease>>) => {
      if (stable?.pin) return;
      try {
        recordCliReleaseNumber(installation, release.head, verdict, !!stable);
      } catch {
        /* the next verified update records it */
      }
    };
    if (cliCurrentCommit(installation) === release.head) {
      if (stable) requireStableRuntime(installation, build, stable);
      // Pinning a currently installed State still requires a signature. Unpinning a
      // rolled-back State also has to clear the floating channel's downgrade check.
      const changedSelection = options.stable && (!installedStable || installedStable.pin !== stable?.pin);
      const verdict = changedSelection ? await verifyRelease() : undefined;
      // Adoption/repair and clearing an explicit pin never perform no-op GC.
      const adopt =
        !existsSync(join(installation, 'manager')) ||
        !existsSync(join(installation, 'launcher.mjs')) ||
        (!options.rollback &&
          canManageCli(build) &&
          cliBuildCommit(join(installation, 'manager')) !== release.head);
      if (adopt || options.stable || (!options.rollback && existsSync(join(installation, 'rollback.json'))))
        withCliLock(installation, () => {
          invariant(
            cliCurrentCommit(installation) === release.head,
            'CLI_UPDATE_CHANGED',
            `Current changed; retry ${cliUpdateCommand(installation)}.`,
          );
          if (adopt) ensureCliManager(installation, build, !options.rollback);
          if (options.stable) writeStableSelection(installation, options.stable);
          if (!existsSync(sourcePath)) durableReplace(sourcePath, JSON.stringify(address));
          if (!options.rollback) rmSync(join(installation, 'rollback.json'), { force: true });
        });
      rmSync(failureMark(installation), { force: true });
      if (verdict) rememberRelease(verdict);
      return { status: 'current', cliCommit: release.head, installation, removed: [] };
    }
    const retainedBuild =
      existsSync(build) && cliBuildCommit(build) === release.head && existsSync(join(build, '.managed-cli'));
    if (!retainedBuild && !buildLease) {
      const slots = heavySlots(readClientSettings().localHeavySlots);
      if (slots > 0) {
        const inherited = inheritedHeavySlot(heavySlotDirectory());
        return { buildRequired: release, expectedCurrent, expectedStable: installedStable, inherited };
      }
    }
    // Signed releases: checked with this (already installed) build's keys before the new State is
    // downloaded, provisioned or built. Explicit --state selection is the owner's own recovery path.
    const verdict = options.rollback ? null : await verifyRelease();
    const publish = async (prepared?: string) => {
      const input = {
        installation,
        address,
        head: release.head,
        build,
        stage: prepared,
        expectedCurrent,
        rollback: options.rollback,
        ...(stable ? { stable } : {}),
        ...(options.stable ? { nextStable: options.stable } : {}),
        migrate: dependencies.migrate,
        retireGraceMs: options.retireGraceMs,
      };
      installCliBuild(input);
      if (stable) requireStableRuntime(installation, build, stable);
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
      if (verdict) rememberRelease(verdict);
      return value;
    };
    const install = (directory: string) =>
      dependencies.run(
        directory,
        ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        undefined,
        buildLease?.command(),
      );
    if (retainedBuild) {
      const deps = await shareDependencies(build, { enabled: true, refresh: true, install });
      invariant(
        deps.status !== 'failed' && deps.status !== 'stale',
        'CLI_UPDATE_DEPENDENCIES_FAILED',
        'Could not restore locked CLI dependencies for this build.',
      );
      return await published(publish());
    }
    stage = mkdtempSync(join(installation, 'builds', '.install-'));
    const transferCache = clientCacheRoot(stage);
    try {
      await dependencies.source.checkout(stage, release);
    } finally {
      rmSync(transferCache, { recursive: true, force: true });
    }
    const packageJson = cliBuildPackage(stage);
    invariant(
      packageJson.name === '@nanthai/forge',
      'CLI_UPDATE_SOURCE_INVALID',
      'CLI releases must come from the Forge source project.',
    );
    const deps = await shareDependencies(stage, {
      enabled: true,
      install,
      // An older Lane can hold the cache lock while waiting for our machine lease.
      ...(buildLease ? { installIfCacheBusy: install } : {}),
      heavy: false,
    });
    invariant(
      deps.status === 'linked' || deps.status === 'installed',
      'CLI_UPDATE_DEPENDENCIES_FAILED',
      'Could not provision locked CLI dependencies.',
    );
    await dependencies.run(stage, ['npm', 'run', 'build:core'], undefined, buildLease?.command());
    buildLease?.release();
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
        'nforge update [FORGE_CHECKOUT] [--directory DIR] [--bin FILE] [--channel main|stable] [--pin STATE | --unpin | --state STATE] [--login]\nNew installs default to stable. Use --pin for an exact signed stable build or --state to roll back main.',
    };
  const flags = [...args];
  let root: string | undefined,
    installation = cliInstallation() ?? defaultCliInstallation(),
    state: string | undefined,
    channel: 'main' | 'stable' | undefined,
    pin: string | undefined,
    unpin = false,
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
    } else if (flag === '--channel') {
      const value = flags.shift();
      invariant(value === 'main' || value === 'stable', 'BAD_ARGUMENT', 'Choose main or stable.');
      channel = value;
    } else if (flag === '--pin') {
      pin = flags.shift();
      invariant(pin && /^[a-f0-9]{64}$/.test(pin), 'BAD_ARGUMENT', 'Use a full signed Forge State hash.');
    } else if (flag === '--unpin') {
      unpin = true;
    } else {
      invariant(!root && !flag.startsWith('-'), 'BAD_ARGUMENT', 'Use nforge update --help.');
      root = resolve(flag);
    }
  }
  // Started detached by a read that found main moved: install next to the running build, never
  // wait. A busy updater already does the work; the update lock comes before any release read.
  if (background) {
    invariant(
      !root && !state && !login && !channel && !pin && !unpin,
      'BAD_ARGUMENT',
      'nforge update --background takes only --directory and --release-head.',
    );
    // Keep one detached updater per installation, including while it waits outside update-lock.
    const pendingDirectory = join(installation, 'background-update-lock');
    mkdirBelow(installation, pendingDirectory);
    const reservation = tryHeavySlot(pendingDirectory, 1, process.pid, true, false);
    if (!reservation) return { status: 'busy', installation };
    // The reservation holder alone replaces the bounded stable log.
    const stableLog = !expected && existsSync(join(installation, 'stable-selection.json'));
    const note = (value: object) => {
      if (!stableLog) return;
      try {
        durableReplace(join(installation, 'update.log'), JSON.stringify(value) + '\n');
      } catch {
        /* advisory */
      }
    };
    try {
      const result = await updateCli(installation, readCliSource(installation), undefined, undefined, {
        lockWaitMs: 0,
        installed: true,
        stableCheck: true,
        ...(expected ? { skipIfCurrent: expected } : {}),
      });
      if (result.status !== 'deferred') note(result);
      return result;
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'CLI_UPDATE_BUSY')
        return { status: 'busy', installation };
      note({ code: error instanceof ForgeError ? error.code : 'CLI_UPDATE_FAILED' });
      // A canary refusal or hold carries its own retry time (canary-refused.json); the generic
      // 10-minute mark would delay a deploy-window retry (Issue 3205f7e6).
      if (error instanceof ForgeError && error.code === 'CLI_CANARY_FAILED') throw error;
      durableReplace(
        failureMark(installation),
        JSON.stringify({ code: error instanceof ForgeError ? error.code : 'CLI_UPDATE_FAILED' }),
      );
      throw error;
    } finally {
      rmSync(reservation, { recursive: true, force: true });
    }
  }
  const address = root ? hostedAgentAddress(root, {}) : readCliSource(installation);
  const priorStable = stableSelection(installation);
  const configured = existsSync(join(installation, 'stable-selection.json'))
    ? 'stable'
    : existsSync(join(installation, 'source.json'))
      ? 'main'
      : null;
  channel ??= configured ?? (state ? 'main' : 'stable');
  invariant(
    !configured || configured === channel,
    'BAD_ARGUMENT',
    'Use a separate --directory for a different CLI release channel.',
  );
  invariant(
    !(pin && unpin) && (channel === 'stable' ? !state : !pin && !unpin),
    'BAD_ARGUMENT',
    'Use --pin or --unpin on stable, or --state on main.',
  );
  const stable = channel === 'stable' ? (pin ? { pin } : unpin ? {} : (priorStable ?? {})) : undefined;
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
  const selected = stable ? undefined : await source.current();
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
    state ? { ...selected!, head: state } : selected,
    undefined,
    {
      expectedCurrent,
      rollback: !!state,
      ...(stable ? { stable, expectedStable: priorStable } : {}),
      lockWaitMs: CLI_UPDATE_WAIT_MS,
    },
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
