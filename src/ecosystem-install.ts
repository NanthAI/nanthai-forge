// SPDX-License-Identifier: Apache-2.0
import { ECOSYSTEMS, type EcosystemManager } from './ecosystems.js';
import { declaredInstallScripts, FORGE_CONFIG_FILE } from './project-config.js';

/** The install command of a registry manager (src/ecosystems.ts `install`) under the install-script
 * policy (docs/parallel-work-defaults.md#sharedependencies). By default no dependency install script
 * or plugin runs. What a repository declares is only a request: forge.json `install.scripts: true`
 * (everything) or the manager's own allowlist (Composer `config.allow-plugins`). It takes effect
 * when start passes `installScripts:true` (everything) or this machine's installScripts setting
 * accepts it. A manager whose manifest is code (Gemfile, mix.exs) has no script-free install:
 * Forge refuses it unless everything is allowed. Reads files only; runs nothing. */
export type InstallRequest =
  | { source: string; all: true }
  | { source: string; all?: false; packages: string[] };
export type InstallScriptsMode = 'none' | 'allowlist' | 'all';
export type EcosystemInstall =
  | { manager: string; argv: string[]; scripts: InstallScriptsMode; requested: InstallRequest | null }
  | { manager: string; refusal: string; requested: InstallRequest | null };
/** Reads a repository file by its root-relative path. */
export type RepositoryReader = (path: string) => string | undefined;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const json = (text: string | undefined) => {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};
/** Each manager's own allowlist, where it keeps one. */
const MANAGER_REQUESTS: Record<string, (read: RepositoryReader) => InstallRequest | null> = {
  composer(read) {
    const manifest = json(read('composer.json'));
    const plugins =
      record(manifest) && record(manifest.config) ? manifest.config['allow-plugins'] : undefined;
    // `true` allows every plugin; an object maps a name or `vendor/*` pattern to true or false.
    if (plugins === true) return { source: 'composer.json', packages: ['*'] };
    if (!record(plugins)) return null;
    const packages = Object.entries(plugins)
      .filter(([, allowed]) => allowed === true)
      .map(([name]) => name)
      .sort();
    return packages.length ? { source: 'composer.json', packages } : null;
  },
};

export function installManager(
  name: string,
): EcosystemManager & { install: NonNullable<EcosystemManager['install']> } {
  const manager = ECOSYSTEMS.flatMap(entry => entry.managers ?? []).find(item => item.name === name);
  if (!manager?.install) throw new Error(`Manager ${name} has no install in src/ecosystems.ts.`);
  return manager as ReturnType<typeof installManager>;
}

/** What the repository asks for: everything (forge.json) first, else the manager's own allowlist. */
export function installRequest(name: string, read: RepositoryReader): InstallRequest | null {
  if (declaredInstallScripts(read(FORGE_CONFIG_FILE))) return { source: FORGE_CONFIG_FILE, all: true };
  return MANAGER_REQUESTS[name]?.(read) ?? null;
}

/** The install argv for manager `name`, or why Forge does not run one. `startFlag` is start's
 * `installScripts`; `machine` is this machine's installScripts setting. */
export function ecosystemInstall(
  name: string,
  read: RepositoryReader,
  decision: { startFlag?: boolean | undefined; machine: boolean },
): EcosystemInstall {
  const { install } = installManager(name);
  const requested = installRequest(name, read);
  const mode: InstallScriptsMode =
    decision.startFlag === true
      ? 'all'
      : decision.startFlag === false || !decision.machine || !requested
        ? 'none'
        : requested.all
          ? 'all'
          : 'allowlist';
  if (install.manifestIsCode && mode !== 'all')
    return {
      manager: name,
      requested,
      refusal: `${install.argv.join(' ')} runs ${install.runs}, so Forge runs it only when start passes installScripts:true or this machine's installScripts setting accepts forge.json install.scripts.`,
    };
  const dropped = new Set(
    mode === 'all' ? install.scriptFlags : mode === 'allowlist' ? install.allowlisted : [],
  );
  return { manager: name, requested, scripts: mode, argv: install.argv.filter(word => !dropped.has(word)) };
}
