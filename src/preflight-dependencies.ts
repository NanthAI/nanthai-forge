// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { CODE_FILE } from './js-import-graph.js';

/** A preflight test file that cannot load because a package its imports name is declared but not
 * installed in the Lane is a setup gap, not a failing test: Forge installs a Lane's dependencies
 * only from a lockfile, and a project without one (or a machine without the install) has none.
 * Like a missing toolchain it is an environment result, and the landing check, which sets up its
 * own dependencies, still runs those tests (9ab983fd). It reads source and manifests only and never
 * runs repository code. An import no manifest declares is a real failure and never classified here. */
export const dependenciesEnvironmentSchema = z
  .object({
    category: z.literal('ENVIRONMENT'),
    code: z.literal('DEPENDENCIES_MISSING'),
    message: z.string(),
    next: z.string(),
    /** Packages declared in a manifest but not installed, in the order the scan met them. */
    missing: z.array(z.string()).min(1),
    /** Test files that could not run because of them. */
    units: z.array(z.string()),
  })
  .strict();
export type DependenciesEnvironment = z.infer<typeof dependenciesEnvironmentSchema>;

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const BUILTIN = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const FILE_LIMIT = 400;
const FILE_BYTES = 1024 * 1024;
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const packageName = (specifier: string) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;

type Manifest = { names: Set<string>; declared: Set<string> };
const manifests = new Map<string, Manifest | null>();
function manifestAt(dir: string): Manifest | null {
  const cached = manifests.get(dir);
  if (cached !== undefined) return cached;
  let manifest: Manifest | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const declared = new Set<string>();
      for (const section of DEPENDENCY_SECTIONS) {
        const value = record[section];
        if (value && typeof value === 'object') for (const name of Object.keys(value)) declared.add(name);
      }
      manifest = { names: new Set(typeof record.name === 'string' ? [record.name] : []), declared };
    }
  } catch {
    /* No readable manifest here. */
  }
  manifests.set(dir, manifest);
  return manifest;
}

/** Whether a package directory named `name` is installed in a node_modules above `dir` (Node's own
 * lookup order, up to the filesystem root). */
function installed(dir: string, name: string) {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, 'node_modules', name))) return true;
    if (dirname(current) === current) return false;
  }
}

/** Manifests from `dir` up to `root`, nearest first. */
function manifestChain(root: string, dir: string) {
  const chain: Manifest[] = [];
  for (let current = dir; ; current = dirname(current)) {
    const manifest = manifestAt(current);
    if (manifest) chain.push(manifest);
    if (current === root || dirname(current) === current) return chain;
  }
}

function resolveLocal(base: string, specifier: string) {
  const target = resolve(base, specifier);
  const stem = target.replace(CODE_FILE, '');
  const candidates = [
    target,
    ...EXTENSIONS.map(ext => target + ext),
    ...EXTENSIONS.map(ext => join(target, `index${ext}`)),
    ...(stem !== target ? EXTENSIONS.map(ext => stem + ext) : []),
  ];
  return candidates.find(candidate => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/** Declared-but-not-installed packages the import closure of one test file reaches, in order. */
function missingPackages(root: string, file: string) {
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(root, file)];
  while (queue.length && seen.size < FILE_LIMIT) {
    const path = queue.shift()!;
    if (seen.has(path) || !CODE_FILE.test(path)) continue;
    seen.add(path);
    let text: string;
    try {
      if (statSync(path).size > FILE_BYTES) continue;
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const dir = dirname(path);
    for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const local = resolveLocal(dir, specifier);
        if (local && relative(root, local).split('/')[0] !== '..') queue.push(local);
        continue;
      }
      if (specifier.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) continue;
      const name = packageName(specifier);
      if (BUILTIN.has(name) || BUILTIN.has(specifier) || installed(dir, name)) continue;
      const chain = manifestChain(root, dir);
      // Only a package a manifest declares is a setup gap; a self reference or an undeclared name
      // (a typo, a deleted dependency) is the change's own failure and stays one.
      if (chain.some(manifest => manifest.declared.has(name)) && !chain.some(m => m.names.has(name)))
        if (!missing.includes(name)) missing.push(name);
    }
  }
  return missing;
}

/** The install command for the package manager a runner program belongs to (`npx` is npm's). */
const INSTALL: Record<string, string> = {
  npx: 'npm install --ignore-scripts',
  npm: 'npm install --ignore-scripts',
  pnpm: 'pnpm install --ignore-scripts',
  yarn: 'yarn install --ignore-scripts',
  bun: 'bun install --ignore-scripts',
};

/** Packages a project runner could not start because they are not installed, read from the runner's
 * own error output: `npx --no-install` ("npx canceled due to missing packages"), or pnpm/yarn
 * ("Command "tsx" not found"). Empty when the output says nothing of the kind. */
export function runnerPackagesMissing(output: string) {
  const names: string[] = [];
  const npx = /npx canceled due to missing packages[^\n[]*\[([^\]]*)\]/.exec(output);
  for (const entry of npx?.[1]?.match(/[@\w][^"',\s]*/g) ?? [])
    names.push(entry.replace(/^(@?[^@]+)@.*$/, '$1'));
  for (const found of output.matchAll(/Command "([^"]+)" not found/g)) names.push(found[1]!);
  return [...new Set(names)];
}

/** A project runner that could not start for want of an uninstalled package is the Lane's setup, not a
 * failed test: the same advisory result as a test file that cannot load one, with the exact install
 * command as the way forward. A project with no lockfile gets no Lane install (9ab983fd). */
export function runnerDependenciesMissing(
  output: string,
  program: string,
  units: readonly string[],
  next: string,
): DependenciesEnvironment | null {
  const missing = runnerPackagesMissing(output);
  if (!missing.length) return null;
  const install = INSTALL[program] ?? INSTALL.npm!;
  return {
    category: 'ENVIRONMENT',
    code: 'DEPENDENCIES_MISSING',
    message:
      `The test runner needs ${missing.join(', ')}, which is not installed in this Lane (${units.length} test file(s) not run). ` +
      "Forge installs a Lane's dependencies only from a lockfile; that is setup, not a failed test, and the landing check sets up its own and runs them. " +
      `To run them locally first: run \`${install}\` in the Lane, then preflight again.`,
    next,
    missing,
    units: [...units],
  };
}

/** The environment result when EVERY failed file imports a declared package that is not installed
 * (so no failure is left unexplained), else null. */
export function dependenciesMissing(
  root: string,
  failed: readonly string[],
  next: string,
): DependenciesEnvironment | null {
  if (!failed.length) return null;
  manifests.clear();
  const all: string[] = [];
  for (const file of failed) {
    const found = missingPackages(root, file);
    if (!found.length) return null;
    for (const name of found) if (!all.includes(name)) all.push(name);
  }
  return {
    category: 'ENVIRONMENT',
    code: 'DEPENDENCIES_MISSING',
    message:
      `Declared but not installed in this Lane: ${all.join(', ')}. ${failed.length} test file(s) import them (${failed.slice(0, 5).join(', ')}) and could not load; ` +
      "that is this Lane's setup, not a failed test. Forge installs a Lane's dependencies only from a lockfile, and the landing check sets up its own and runs them. " +
      'To judge them locally first, install the packages in the Lane and run preflight again.',
    next,
    missing: all,
    units: [...failed],
  };
}
