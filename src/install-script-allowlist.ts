// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { declaredInstallScripts, FORGE_CONFIG_FILE } from './project-config.js';

/** The repository's own statement of which dependency install scripts may run. */
export type InstallScriptAllowlist =
  | { source: string; all: true }
  | { source: string; all?: false; packages: string[] };

const text = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};
const names = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  // pnpm `allowBuilds` maps a package name to true (allowed) or false (denied).
  if (value && typeof value === 'object')
    return Object.entries(value)
      .filter(([, allowed]) => allowed === true)
      .map(([name]) => name);
  return undefined;
};
const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
/** Top-level `key:` of a YAML file as a list (`- name`) or map (`name: true`) of package names.
 * Only the shapes pnpm documents are read; anything else counts as not declared. */
function yamlNames(source: string, key: string): string[] | undefined {
  const lines = source.split(/\r?\n/),
    start = lines.findIndex(line => line.trimEnd() === `${key}:`);
  if (start === -1) return undefined;
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    const item = line.trim();
    if (item.startsWith('- ')) found.push(unquote(item.slice(2)));
    else {
      const [name, flag] = item.split(/:\s*/, 2);
      if (name && flag?.trim() === 'true') found.push(unquote(name));
    }
  }
  return found;
}

/** Read the allowlist a repository declares for dependency build scripts, or null when it
 * declares none (the caller then skips every script). Reads files only; runs nothing.
 * forge.json: `install.scripts: true` (all). npm: none of its own. pnpm: `onlyBuiltDependencies`/`allowBuilds` in pnpm-workspace.yaml or
 * package.json (`pnpm.*`). bun: `trustedDependencies`. yarn berry: `enableScripts: true` (all) and
 * `dependenciesMeta.<name>.built`. Package names from every source are merged. */
export function readInstallScriptAllowlist(root: string): InstallScriptAllowlist | null {
  const found: { source: string; packages: string[] }[] = [];
  const add = (source: string, packages: string[] | undefined) => {
    if (packages) found.push({ source, packages });
  };
  if (declaredInstallScripts(text(join(root, FORGE_CONFIG_FILE))))
    return { source: FORGE_CONFIG_FILE, all: true };
  const yarnrc = text(join(root, '.yarnrc.yml'));
  if (yarnrc !== undefined && /^enableScripts:\s*true\s*$/m.test(yarnrc))
    return { source: '.yarnrc.yml', all: true };
  const workspace = text(join(root, 'pnpm-workspace.yaml'));
  if (workspace !== undefined)
    for (const key of ['onlyBuiltDependencies', 'allowBuilds'])
      add('pnpm-workspace.yaml', yamlNames(workspace, key));
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(text(join(root, 'package.json')) ?? '{}') as Record<string, unknown>;
  } catch {
    /* An unreadable manifest declares nothing. */
  }
  const pnpm = (manifest.pnpm ?? {}) as Record<string, unknown>;
  add('package.json', names(pnpm.onlyBuiltDependencies));
  add('package.json', names(pnpm.allowBuilds));
  add('package.json', names(manifest.trustedDependencies));
  const meta = manifest.dependenciesMeta;
  if (meta && typeof meta === 'object')
    add(
      'package.json',
      Object.entries(meta as Record<string, { built?: unknown }>)
        .filter(([, value]) => value?.built === true)
        .map(([name]) => name),
    );
  if (!found.length) return null;
  return {
    source: [...new Set(found.map(item => item.source))].join(', '),
    packages: [...new Set(found.flatMap(item => item.packages))].sort(),
  };
}
