// SPDX-License-Identifier: Apache-2.0
// Where the installed Forge CLI lives, found the way the product installs it (Issue 7af26482,
// docs/operations/cli-update.md): an installation DIR whose `current` selects one build
// (DIR/builds/HEAD), entered by the PATH launcher `nforge` (`exec NODE 'DIR/launcher.mjs'`).
// The bench links the pinned harness's node_modules to that build and holds landings with the
// product's measurement hold, DIR/.freeze. The bench runs on an installation of its own
// (`benchCli`, setup step bench-cli), never on the builders'. Reads only; no network.
//   1. FORGE_CLI_HOME: an installation DIR (has `current`) or one build (has dist/cli-entry.js)
//   2. config.forge.cli: .../dist/cli-entry.js of a build
//   3. the `nforge` launcher on PATH
//   4. the product default installation, ~/.local/share/forge-cli
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CLI_INSTALL_HELP =
  'install the Forge CLI (`nforge update FORGE_CHECKOUT`, docs/operations/cli-update.md) or set FORGE_CLI_HOME to its installation directory';

const isDir = path => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The installation a build belongs to: DIR/builds/HEAD, else its `.cli-installation` binding. */
export function installationOfBuild(build) {
  const real = realpathSync(build);
  if (basename(dirname(real)) === 'builds' && /^[a-f0-9]{12,64}$/.test(basename(real)))
    return dirname(dirname(real));
  const binding = join(real, '.cli-installation');
  return existsSync(binding) ? readFileSync(binding, 'utf8').trim() || null : null;
}

/** DIR from a product launcher's text (`exec 'NODE' 'DIR/launcher.mjs' "$@"`), or null. */
export function launcherInstallation(text) {
  const m = String(text).match(/^exec\s+'(?:[^']|'\\'')*'\s+'((?:[^']|'\\'')*)\/launcher\.mjs'/m);
  return m ? m[1].replaceAll("'\\''", "'") : null;
}

/** The installation the `nforge` on PATH enters, or null. Reads at most one small file. */
export function pathInstallation(pathEnv = process.env.PATH ?? '') {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const file = join(dir, 'nforge');
    if (!existsSync(file)) continue;
    try {
      if (statSync(file).size > 4096) return null;
      return launcherInstallation(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * { build, installation, via }: build is the selected CLI build directory (holds dist/,
 * node_modules, .commit); installation is its product installation, or null for a bare build.
 * Throws BENCH_CLI_NOT_INSTALLED naming the install command when nothing is found.
 */
export function productCli({
  explicit = process.env.FORGE_CLI_HOME,
  config = null,
  pathEnv = process.env.PATH ?? '',
  home = homedir(),
} = {}) {
  const fromInstallation = (installation, via) => ({
    build: realpathSync(join(installation, 'current')),
    installation: realpathSync(installation),
    via,
  });
  if (explicit) {
    if (existsSync(join(explicit, 'current')))
      return fromInstallation(explicit, 'FORGE_CLI_HOME installation');
    if (existsSync(join(explicit, 'dist', 'cli-entry.js')))
      return {
        build: realpathSync(explicit),
        installation: installationOfBuild(explicit),
        via: 'FORGE_CLI_HOME build',
      };
    throw Object.assign(
      Error(
        `BENCH_CLI_NOT_INSTALLED: FORGE_CLI_HOME has neither current nor dist/cli-entry.js; ${CLI_INSTALL_HELP}`,
      ),
      { code: 'BENCH_CLI_NOT_INSTALLED' },
    );
  }
  if (config?.forge?.cli) {
    // The CLI the bench runs; never silently swapped for another installation.
    const build = dirname(dirname(config.forge.cli));
    if (!isDir(build))
      throw Object.assign(
        Error(
          `BENCH_CLI_NOT_INSTALLED: config.forge.cli names ${config.forge.cli}, whose build is missing; ${CLI_INSTALL_HELP}`,
        ),
        { code: 'BENCH_CLI_NOT_INSTALLED' },
      );
    return { build: realpathSync(build), installation: installationOfBuild(build), via: 'config.forge.cli' };
  }
  const onPath = pathInstallation(pathEnv);
  if (onPath && existsSync(join(onPath, 'current'))) return fromInstallation(onPath, 'nforge on PATH');
  const fallback = join(home, '.local', 'share', 'forge-cli');
  if (existsSync(join(fallback, 'current'))) return fromInstallation(fallback, 'default installation');
  throw Object.assign(
    Error(`BENCH_CLI_NOT_INSTALLED: no Forge CLI installation found; ${CLI_INSTALL_HELP}`),
    {
      code: 'BENCH_CLI_NOT_INSTALLED',
    },
  );
}

const realOrNull = path => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The installations builders use: the one the `nforge` on PATH enters, the one the default
 * launcher (~/.local/bin/nforge) enters, and the product default. Real paths of those that exist. */
export function builderInstallations({ pathEnv = process.env.PATH ?? '', home = homedir() } = {}) {
  const launcher = join(home, '.local', 'bin', 'nforge');
  const named = [
    pathInstallation(pathEnv),
    existsSync(launcher) ? pathInstallation(dirname(launcher)) : null,
    join(home, '.local', 'share', 'forge-cli'),
  ];
  return [...new Set(named.filter(Boolean).map(realOrNull).filter(Boolean))];
}

/**
 * The bench's own CLI (Issue 2e1f5fbd): config.forge.cli (or FORGE_CLI_HOME, which must then
 * name the same installation) in an installation of its own, so its measurement hold (.freeze)
 * and its updates never reach builders. Throws BENCH_CLI_SHARED when it is a builders'
 * installation and BENCH_CLI_MISMATCH when FORGE_CLI_HOME and config.forge.cli disagree.
 */
export function benchCli({ config, explicit = process.env.FORGE_CLI_HOME, pathEnv, home } = {}) {
  const cli = productCli({ explicit, config, pathEnv, home });
  if (explicit && config?.forge?.cli) {
    const configured = productCli({ explicit: '', config, pathEnv, home });
    if (configured.installation !== cli.installation)
      throw Object.assign(
        Error(
          `BENCH_CLI_MISMATCH: FORGE_CLI_HOME selects ${cli.installation ?? cli.build}, config.forge.cli ${configured.installation ?? configured.build}; the hold and the agents' CLI must be one installation`,
        ),
        { code: 'BENCH_CLI_MISMATCH' },
      );
  }
  if (cli.installation && builderInstallations({ pathEnv, home }).includes(cli.installation))
    throw Object.assign(
      Error(
        `BENCH_CLI_SHARED: ${cli.installation} is the builders' CLI installation, so the bench's hold would stop their landings; run \`scripts/bench-t3code/setup --live --only bench-cli\` (the bench's own installation, BENCH_ROOT/cli)`,
      ),
      { code: 'BENCH_CLI_SHARED' },
    );
  return cli;
}

/** The product's measurement hold for that installation: landings and updates wait while it exists. */
export function freezePath(cli) {
  if (!cli.installation)
    throw Object.assign(
      Error(
        `BENCH_CLI_NO_INSTALLATION: ${cli.build} is not part of a product installation, so it has no measurement hold; ${CLI_INSTALL_HELP}`,
      ),
      { code: 'BENCH_CLI_NO_INSTALLATION' },
    );
  return join(cli.installation, '.freeze');
}
