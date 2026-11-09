// SPDX-License-Identifier: Apache-2.0
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installConfigFiles, type PackageManager } from './package-manager.js';

/** Hosts the public package managers fetch from by default; everything else is worth showing. */
const PUBLIC_REGISTRIES = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
/** A lockfile is read once per start; a pathological one is cut off here, never parsed whole. */
const READ_LIMIT = 32 * 1024 * 1024;
const LISTED = 20;
const URL_AUTHORITY = /\b(?:git\+)?(?:https?|ssh|git):\/\/([^\s"'<>)\],\\/?#]+)/gi;
/** npmrc auth lines name a host as `//host/path/:_authToken=…`; only the host is captured. */
const NPMRC_HOST = /^\s*\/\/([^\s/:=]+(?::\d+)?)\//gm;
const HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/;

export type RegistryHosts = {
  /** Host names (with a port when one is set), sorted, at most 20. Never a path, user or token. */
  hosts: string[];
  /** Hosts beyond the 20 listed. */
  more: number;
  /** The files that named them (lockfile and install settings). */
  sources: string[];
};

function readBounded(path: string, binary: boolean): string | null {
  try {
    if (statSync(path).size > READ_LIMIT) return null;
    const bytes = readFileSync(path);
    return bytes.toString(binary ? 'latin1' : 'utf8');
  } catch {
    return null;
  }
}
/** Host names a file's text points installs at. Comments are skipped; credentials in a URL
 * (`user:token@host`) are dropped before anything is kept. */
export function hostsInText(text: string): Set<string> {
  const found = new Set<string>();
  const body = text.replace(/^[ \t]*[#;].*$/gm, '');
  const add = (authority: string | undefined) => {
    const host = authority?.slice(authority.lastIndexOf('@') + 1).toLowerCase();
    if (host && HOST.test(host)) found.add(host);
  };
  for (const match of body.matchAll(URL_AUTHORITY)) add(match[1]);
  for (const match of body.matchAll(NPMRC_HOST)) add(match[1]);
  return found;
}
const bareHost = (host: string) => host.replace(/:\d+$/, '');

/** Where this repository's install fetches from besides the public npm and Yarn registries: URLs the
 * lockfile resolves to (npm `resolved`, Yarn classic `resolved`, pnpm `tarball`, git and tarball
 * dependencies) and, for pnpm, Yarn and Bun, the registries the copied install settings name (npm
 * reads no settings from the repository). Reads files only; one bounded pass at start; host names only. */
export function installRegistryHosts(root: string, pm: PackageManager): RegistryHosts | null {
  const files = [pm.lockfile];
  if (pm.name !== 'npm')
    files.push(
      ...installConfigFiles(root).filter(file => !file.includes('/') && !file.startsWith('patches')),
    );
  const hosts = new Set<string>(),
    sources: string[] = [];
  for (const file of files) {
    const text = readBounded(join(root, file), file.endsWith('.lockb'));
    if (text === null) continue;
    let named = false;
    for (const host of hostsInText(text))
      if (!PUBLIC_REGISTRIES.has(bareHost(host))) {
        hosts.add(host);
        named = true;
      }
    if (named) sources.push(file);
  }
  if (!hosts.size) return null;
  const sorted = [...hosts].sort();
  return { hosts: sorted.slice(0, LISTED), more: Math.max(0, sorted.length - LISTED), sources };
}

/** The one stderr line printed before an install fetches from non-public hosts. */
export function registryHostsNotice(found: RegistryHosts): string {
  const list = found.hosts.join(', ') + (found.more ? ` and ${found.more} more` : '');
  return `Install fetches from ${list}, besides the public npm registries (named by ${found.sources.join(', ')}); Forge's clean install environment sends none of your credentials.`;
}
export const announceRegistryHosts = (found: RegistryHosts) =>
  process.stderr.write(`${registryHostsNotice(found)}\n`);
