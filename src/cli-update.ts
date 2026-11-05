// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { childEnv } from '../scripts/child-env.mjs';
import { ForgeError, invariant } from './errors.js';
import { durableReplace } from './native-durability.js';
import { hostedAgentAddress } from './hosted-agent-cli.js';
import { acquireHeavySlot, heavySlotDirectory, tryHeavySlot } from './heavy-slots.js';
import { heavySlots, readClientSettings } from './client-settings.js';
import { shareDependencies } from './shared-dependencies.js';
import { cliReleaseSource, type CliSource } from './cli-update-source.js';
import { cliBuildCommit, cliInstallation, withCliLock } from './cli-installation.js';
import { cliCurrentCommit, ensureCliManager, publishCliBuild, canManageCli } from './cli-update-install.js';
import { migrateEditHookRunner } from './agent-install-hooks.js';
import type { HostedMain } from './hosted-main.js';
import { clientCacheRoot } from './root-paths.js';
import { cliPackageRoot } from './cli-installation.js';
import { shellQuote } from './agent-brief-render.js';

const sourceSchema = z.object({ url: z.url(), projectId: z.string().min(1) }).strict();
export const defaultCliInstallation = () => join(homedir(), '.local', 'share', 'forge-cli');
export const cliUpdateCommand = (installation: string) =>
  `nforge update --directory ${shellQuote(installation)}`;
export function readCliSource(installation: string): CliSource {
  const path = join(installation, 'source.json');
  if (!existsSync(path)) {
    const command = `nforge update ${shellQuote(process.cwd())} --directory ${shellQuote(installation)}`;
    throw new ForgeError(
      'CLI_UPDATE_SOURCE_REQUIRED',
      `Configure the release from a hosted Forge source checkout. Next: ${command}`,
      undefined,
      { command },
    );
  }
  return sourceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export async function cliUpdateRun(cwd: string, args: string[], home?: string) {
  await new Promise<void>((done, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      stdio: ['ignore', 2, 2],
      env: childEnv({
        allow: ['XDG_CACHE_HOME'],
        ...(home ? { extra: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') } } : {}),
      }),
    });
    child.once('error', reject);
    child.once('exit', code =>
      code === 0
        ? done()
        : reject(new ForgeError('CLI_UPDATE_BUILD_FAILED', `CLI update command failed (${code}).`)),
    );
  });
}
export async function updateCli(
  installation: string,
  address: CliSource,
  selected?: HostedMain,
  dependencies = {
    source: cliReleaseSource(address),
    run: cliUpdateRun,
    migrate: (runner: string) => migrateEditHookRunner(runner),
  },
  options: { expectedCurrent?: string | null; rollback?: boolean } = {},
) {
  const expectedCurrent =
    options.expectedCurrent !== undefined ? options.expectedCurrent : cliCurrentCommit(installation);
  address = sourceSchema.parse(address);
  mkdirSync(join(installation, 'builds'), { recursive: true, mode: 0o700 });
  invariant(
    !existsSync(join(installation, '.freeze')),
    'CLI_UPDATE_FROZEN',
    `CLI update is held by ${join(installation, '.freeze')}. Remove that measurement hold, then run ${cliUpdateCommand(installation)}.`,
  );
  const lock = tryHeavySlot(join(installation, 'update-lock'), 1);
  invariant(
    lock,
    'CLI_UPDATE_BUSY',
    `Another CLI update is running. Next: ${cliUpdateCommand(installation)}`,
  );
  let stage: string | undefined;
  try {
    const sourcePath = join(installation, 'source.json');
    if (existsSync(sourcePath))
      invariant(
        JSON.stringify(readCliSource(installation)) === JSON.stringify(address),
        'CLI_UPDATE_SOURCE_CHANGED',
        'Keep the configured Forge CLI source.',
      );
    const release = selected ?? (await dependencies.source.current());
    invariant(
      release.projectId === address.projectId && /^[a-f0-9]{64}$/.test(release.head),
      'CLI_UPDATE_SOURCE_INVALID',
      'Select the configured Forge release State.',
    );
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
      return { status: 'current', cliCommit: release.head, installation, removed: [] };
    }
    const publish = (prepared?: string) =>
      publishCliBuild({
        installation,
        address,
        head: release.head,
        build,
        stage: prepared,
        expectedCurrent,
        rollback: options.rollback,
        migrate: dependencies.migrate,
      });
    if (
      existsSync(build) &&
      cliBuildCommit(build) === release.head &&
      existsSync(join(build, '.managed-cli'))
    )
      return publish();
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
    });
    invariant(
      deps.status === 'linked' || deps.status === 'installed',
      'CLI_UPDATE_DEPENDENCIES_FAILED',
      'Could not provision locked CLI dependencies.',
    );
    const slots = heavySlots(readClientSettings().localHeavySlots);
    const slot = slots ? await acquireHeavySlot(heavySlotDirectory(), slots) : null;
    try {
      await dependencies.run(stage, ['npm', 'run', 'build:core']);
      const smokeHome = mkdtempSync(join(stage, '.smoke-home-'));
      try {
        await dependencies.run(stage, [process.execPath, 'dist/cli.js', '--help'], smokeHome);
      } finally {
        rmSync(smokeHome, { recursive: true, force: true });
      }
    } finally {
      if (slot) rmSync(slot, { recursive: true, force: true });
    }
    invariant(
      existsSync(join(stage, 'dist', 'cli-entry.js')) &&
        existsSync(join(stage, 'dist', 'agent-edit-hook.js')),
      'CLI_UPDATE_BUILD_FAILED',
      'The built CLI and edit hook must both exist.',
    );
    durableReplace(join(stage, '.commit'), release.head);
    writeFileSync(join(stage, '.managed-cli'), '1');
    return publish(stage);
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
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
    login = false;
  while (flags.length) {
    const flag = flags.shift()!;
    if (flag === '--login') login = true;
    else if (flag === '--directory') {
      const value = flags.shift();
      invariant(value, 'BAD_ARGUMENT', 'Supply --directory DIR.');
      installation = resolve(value);
    } else if (flag === '--bin') {
      const value = flags.shift();
      invariant(value, 'BAD_ARGUMENT', 'Supply --bin FILE.');
      bin = resolve(value);
    } else if (flag === '--state') {
      state = flags.shift();
      invariant(state && /^[a-f0-9]{64}$/.test(state), 'BAD_ARGUMENT', 'Use a full Forge State hash.');
    } else {
      invariant(!root && !flag.startsWith('-'), 'BAD_ARGUMENT', 'Use nforge update --help.');
      root = resolve(flag);
    }
  }
  const address = root ? hostedAgentAddress(root, {}) : readCliSource(installation);
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
    const initialized = await updateCli(installation, address, selected, undefined, { expectedCurrent });
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
    { expectedCurrent, rollback: !!state },
  );
  mkdirSync(resolve(bin, '..'), { recursive: true, mode: 0o700 });
  durableReplace(
    bin,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(installation, 'launcher.mjs'))} \"$@\"\n`,
    0o755,
  );
  const packageRoot = cliPackageRoot();
  if (!cliInstallation(packageRoot) && !existsSync(join(packageRoot, 'src', 'cli-entry.ts')))
    durableReplace(join(packageRoot, '.cli-installation'), installation);
  return {
    ...result,
    bin,
    run: `${shellQuote(process.execPath)} ${shellQuote(join(installation, 'launcher.mjs'))}`,
    ...(state
      ? { notice: 'Explicit rollback selected. The next ordinary invocation checks main again.' }
      : {}),
  };
}
