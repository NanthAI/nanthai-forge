// SPDX-License-Identifier: Apache-2.0
import { globRegExp } from './path-glob.js';
import { parseToml, tomlGet, tomlStrings, tomlTable, type TomlTable, type TomlValue } from './toml-lite.js';
import {
  basename,
  dirname,
  joinPath,
  packageKey,
  type EcosystemResult,
  type GraphPackage,
  type ManifestReader,
  type PackageCommand,
} from './package-graph-types.js';

/** Go: every go.mod is a module (Go itself skips vendor/ and testdata/). A module depends on another
 * in-repository module it requires (replaced or not, so a published copy is over-, never under-
 * selected). A change to `_test.go` files or `testdata/` only is tested in its own package folder:
 * nothing can import a test file. */
export function goGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(
    path => basename(path) === 'go.mod' && !/(?:^|\/)(?:vendor|testdata)\//.test(path),
  );
  if (!manifests.length) return null;
  const modules: { pkg: GraphPackage; module: string; requires: string[] }[] = [];
  for (const manifest of manifests) {
    const text = read(manifest);
    const module = text && /^\s*module\s+("?)([^\s"]+)\1/m.exec(text)?.[2];
    if (!text || !module) return { ecosystem: 'go', refusal: `${manifest} names no module` };
    const requires: string[] = [];
    const body = text.replace(/\/\/.*$/gm, '');
    for (const block of body.matchAll(/^\s*(?:require|replace)\s*\(([\s\S]*?)\)/gm))
      for (const line of block[1]!.split('\n')) if (line.trim()) requires.push(line.trim().split(/\s+/)[0]!);
    for (const line of body.matchAll(/^\s*(?:require|replace)\s+([^\s(]+)/gm)) requires.push(line[1]!);
    modules.push({
      pkg: {
        ecosystem: 'go',
        dir: dirname(manifest),
        name: module,
        manifest,
        dependsOn: [],
        testable: true,
        declared: false,
      },
      module,
      requires: requires.map(path => path.replace(/^"|"$/g, '')),
    });
  }
  const byModule = new Map(modules.map(item => [item.module, item.pkg]));
  for (const item of modules)
    item.pkg.dependsOn = [
      ...new Set(
        item.requires.flatMap(path => (byModule.get(path) ? [packageKey(byModule.get(path)!)] : [])),
      ),
    ].filter(key => key !== packageKey(item.pkg));
  const moduleOf = (path: string) =>
    modules
      .map(item => item.pkg)
      .filter(pkg => !pkg.dir || path.startsWith(`${pkg.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
  return {
    ecosystem: 'go',
    packages: modules.map(item => item.pkg),
    leafOwner(path) {
      const test = /_test\.go$/.test(path) ? dirname(path) : /^(.*?)\/?testdata\//.exec(path)?.[1];
      const module = test === undefined ? undefined : moduleOf(path);
      if (test === undefined || !module) return undefined;
      return {
        ecosystem: 'go',
        dir: test,
        name: `${module.name}${test === module.dir ? '' : `/${test.slice(module.dir ? module.dir.length + 1 : 0)}`}`,
        manifest: module.manifest,
        dependsOn: [],
        testable: true,
        declared: false,
        leaf: true,
      };
    },
    commands(selected, _changed, narrowed) {
      const whole = new Set(
        selected.filter(pkg => !pkg.leaf && !narrowed?.has(packageKey(pkg))).map(pkg => pkg.dir),
      );
      const commands: PackageCommand[] = [...whole].sort().map(dir => ({
        ecosystem: 'go',
        cwd: dir,
        argv: ['go', 'test', './...'],
        packages: [`go:${dir}`],
      }));
      const leaves = new Map<string, GraphPackage[]>();
      // Test-only folders, and the package folders a narrowed module's change reaches.
      const units = (pkg: GraphPackage) => (pkg.leaf ? [pkg.dir] : (narrowed?.get(packageKey(pkg)) ?? []));
      for (const pkg of selected.filter(pkg => pkg.leaf || narrowed?.has(packageKey(pkg)))) {
        const module = pkg.leaf ? moduleOf(`${pkg.dir}/x_test.go`)! : pkg;
        if (whole.has(module.dir)) continue;
        leaves.set(module.dir, [...(leaves.get(module.dir) ?? []), pkg]);
      }
      for (const [dir, pkgs] of [...leaves].sort())
        commands.push({
          ecosystem: 'go',
          cwd: dir,
          argv: [
            'go',
            'test',
            ...[
              ...new Set(
                pkgs
                  .flatMap(units)
                  .map(unit => `./${unit.slice(dir ? dir.length + 1 : 0)}`.replace(/\/$/, '')),
              ),
            ].sort(),
          ],
          packages: pkgs.map(packageKey),
        });
      return commands;
    },
  };
}

const DEPENDENCY_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies'];
/** Every dependency table of a Cargo manifest, target-specific ones included. */
function cargoDependencies(manifest: TomlTable): [string, TomlValue][] {
  const tables = [manifest, ...Object.values(tomlTable(manifest.target)).map(tomlTable)];
  return tables.flatMap(table => DEPENDENCY_TABLES.flatMap(name => Object.entries(tomlTable(table[name]))));
}

/** Rust: each Cargo.toml with `[package]` is a crate. A crate is a member of the nearest enclosing
 * `[workspace]` whose `members` globs include it (`exclude` honoured), and runs as `cargo test -p
 * NAME` there; a crate outside every workspace runs `cargo test` in its folder. Edges come from
 * `path` dependencies (direct or through `[workspace.dependencies]`) and from dependencies named like
 * an in-repository crate. */
export function cargoGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(path => basename(path) === 'Cargo.toml' && !/(?:^|\/)target\//.test(path));
  if (!manifests.length) return null;
  const parsed = new Map<string, TomlTable>();
  for (const manifest of manifests) {
    const text = read(manifest);
    if (text === undefined) return { ecosystem: 'cargo', refusal: `${manifest} is unreadable` };
    try {
      parsed.set(manifest, parseToml(text));
    } catch (error) {
      return { ecosystem: 'cargo', refusal: `${manifest}: ${(error as Error).message}` };
    }
  }
  const workspaces = [...parsed].filter(([, toml]) => tomlGet(toml, 'workspace') !== undefined);
  const workspaceOf = (dir: string) =>
    workspaces
      .map(([manifest, toml]) => ({ root: dirname(manifest), toml }))
      .filter(({ root, toml }) => {
        if (root === dir) return true;
        if (root && !dir.startsWith(`${root}/`)) return false;
        const relative = root ? dir.slice(root.length + 1) : dir;
        const match = (globs: string[]) =>
          globs.some(glob => globRegExp(glob.replace(/\/$/, '')).test(relative));
        return (
          match(tomlStrings(tomlGet(toml, 'workspace', 'members'))) &&
          !match(tomlStrings(tomlGet(toml, 'workspace', 'exclude')))
        );
      })
      .sort((a, b) => b.root.length - a.root.length)[0];
  const crates: { pkg: GraphPackage; toml: TomlTable; workspace?: { root: string; toml: TomlTable } }[] = [];
  for (const [manifest, toml] of parsed) {
    if (tomlGet(toml, 'package') === undefined) continue;
    const name = tomlGet(toml, 'package', 'name');
    if (typeof name !== 'string') return { ecosystem: 'cargo', refusal: `${manifest} has no package name` };
    const dir = dirname(manifest);
    const workspace = workspaceOf(dir);
    crates.push({
      pkg: {
        ecosystem: 'cargo',
        dir,
        name,
        manifest,
        dependsOn: [],
        testable: true,
        declared: !!workspace && workspace.root !== dir,
      },
      toml,
      ...(workspace ? { workspace } : {}),
    });
  }
  if (!crates.length) return null;
  const byDir = new Map(crates.map(crate => [crate.pkg.dir, crate.pkg]));
  const byName = new Map(crates.map(crate => [crate.pkg.name, crate.pkg]));
  for (const crate of crates) {
    const edges = new Set<string>();
    for (const [key, value] of cargoDependencies(crate.toml)) {
      const spec = tomlTable(value);
      const inherited =
        spec.workspace === true && crate.workspace
          ? tomlTable(tomlGet(crate.workspace.toml, 'workspace', 'dependencies', key))
          : {};
      const local =
        typeof spec.path === 'string'
          ? joinPath(crate.pkg.dir, spec.path)
          : typeof inherited.path === 'string' && crate.workspace
            ? joinPath(crate.workspace.root, inherited.path)
            : null;
      const target =
        (local !== null && byDir.get(local)) ||
        byName.get(typeof spec.package === 'string' ? spec.package : key);
      if (target && target !== crate.pkg) edges.add(packageKey(target));
    }
    crate.pkg.dependsOn = [...edges].sort();
  }
  const rootOf = new Map(crates.map(crate => [packageKey(crate.pkg), crate.workspace?.root ?? null]));
  return {
    ecosystem: 'cargo',
    packages: crates.map(crate => crate.pkg),
    commands(selected, _changed, narrowed) {
      const groups = new Map<string, GraphPackage[]>();
      const standalone: PackageCommand[] = [];
      const targeted: PackageCommand[] = [];
      for (const pkg of selected) {
        const root = rootOf.get(packageKey(pkg));
        // A narrowed crate (src/module-selection.ts) runs only the test targets that reach the change.
        const tests = narrowed?.get(packageKey(pkg));
        if (tests) {
          targeted.push({
            ecosystem: 'cargo',
            cwd: root ?? pkg.dir,
            argv: [
              'cargo',
              'test',
              ...(root === null || root === undefined ? [] : ['-p', pkg.name]),
              ...tests.map(name => `--test=${name}`),
            ],
            packages: [packageKey(pkg)],
          });
          continue;
        }
        if (root === null || root === undefined)
          standalone.push({
            ecosystem: 'cargo',
            cwd: pkg.dir,
            argv: ['cargo', 'test'],
            packages: [packageKey(pkg)],
          });
        else groups.set(root, [...(groups.get(root) ?? []), pkg]);
      }
      return [
        ...[...groups].sort().map(([root, pkgs]) => ({
          ecosystem: 'cargo' as const,
          cwd: root,
          argv: [
            'cargo',
            'test',
            ...[...new Set(pkgs.map(pkg => pkg.name))].sort().flatMap(name => ['-p', name]),
          ],
          packages: pkgs.map(packageKey),
        })),
        ...standalone,
        ...targeted,
      ];
    },
  };
}
