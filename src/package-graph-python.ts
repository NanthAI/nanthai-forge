// SPDX-License-Identifier: Apache-2.0
import { UNITTEST_UNIT } from './module-graph-types.js';
import { globRegExp } from './path-glob.js';
import { parseToml, tomlGet, tomlStrings, tomlTable, type TomlTable } from './toml-lite.js';
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

const SKIP = /(?:^|\/)(?:venv|site-packages|__pycache__|build|dist)\//;
export const pythonManifest = (path: string) =>
  ['pyproject.toml', 'setup.cfg', 'setup.py'].includes(basename(path)) && !SKIP.test(path);
/** PEP 503 name normalization, used for every package and requirement name. */
const normal = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
/** The project name of one PEP 508 requirement (`foo[extra]>=1; python_version>"3"`). */
const requirement = (spec: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1];

/** setup.cfg sections: `key = value` with indented continuation lines. */
function ini(text: string) {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  let key: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line) || !line.trim()) continue;
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      sections.set(header[1]!.trim(), (section = new Map()));
      key = undefined;
    } else if (/^\s/.test(line) && section && key) section.set(key, `${section.get(key)}\n${line.trim()}`);
    else {
      const pair = /^([^=:]+)[=:](.*)$/.exec(line);
      if (pair && section) section.set((key = pair[1]!.trim()), pair[2]!.trim());
    }
  }
  return sections;
}

type Found = { pkg: GraphPackage; requires: string[]; sources: string[]; pytest: boolean };

function fromPyproject(manifest: string, toml: TomlTable): Found | { name: undefined; pytest: boolean } {
  const project = tomlTable(toml.project);
  const poetry = tomlTable(tomlGet(toml, 'tool', 'poetry'));
  const name = typeof project.name === 'string' ? project.name : poetry.name;
  const groups = Object.values(tomlTable(poetry.group)).map(group =>
    tomlTable(tomlTable(group).dependencies),
  );
  const requires = [
    ...tomlStrings(project.dependencies),
    ...Object.values(tomlTable(project['optional-dependencies'])).flatMap(tomlStrings),
    ...Object.values(tomlTable(toml['dependency-groups'])).flatMap(tomlStrings),
    ...[tomlTable(poetry.dependencies), tomlTable(poetry['dev-dependencies']), ...groups].flatMap(
      Object.keys,
    ),
  ].flatMap(spec => requirement(spec) ?? []);
  const dir = dirname(manifest);
  const sources = Object.values(tomlTable(tomlGet(toml, 'tool', 'uv', 'sources'))).flatMap(source => {
    const path = tomlTable(source).path;
    const resolved = typeof path === 'string' ? joinPath(dir, path) : null;
    return resolved === null ? [] : [resolved];
  });
  const pytest =
    tomlGet(toml, 'tool', 'pytest') !== undefined || requires.some(spec => normal(spec) === 'pytest');
  if (typeof name !== 'string') return { name: undefined, pytest };
  return {
    pkg: { ecosystem: 'python', dir, name, manifest, dependsOn: [], testable: true, declared: false },
    requires,
    sources,
    pytest,
  };
}

/** `python -m unittest MODULE...` in the package folder for unittest units (`unittest:PATH`), or a
 * refusal when a test file cannot be named as a module from there: every folder between the package
 * and the file must be a package (`__init__.py`) with an identifier name, or unittest would import it
 * as another module than the project's own runner does. */
function unittestCommand(
  pkg: GraphPackage,
  units: string[],
  present: Set<string>,
  tool: string[] | null,
): PackageCommand | { refusal: string } {
  const modules: string[] = [];
  for (const unit of units) {
    const path = unit.slice(UNITTEST_UNIT.length);
    const inside = pkg.dir ? path.startsWith(`${pkg.dir}/`) : true;
    const parts = (inside ? (pkg.dir ? path.slice(pkg.dir.length + 1) : path) : '').split('/');
    const stem = parts.pop()?.replace(/\.py$/, '') ?? '';
    const folders = parts.map((_, index) =>
      [pkg.dir, ...parts.slice(0, index + 1)].filter(Boolean).join('/'),
    );
    if (
      !inside ||
      ![...parts, stem].every(part => /^[A-Za-z_]\w*$/.test(part)) ||
      !folders.every(folder => present.has(`${folder}/__init__.py`))
    )
      return {
        refusal: `${path} is not importable as a unittest module from ${pkg.dir || 'the repository root'} (every folder needs an __init__.py), so Python packages have no unambiguous per-package test command`,
      };
    modules.push([...parts, stem].join('.'));
  }
  return {
    ecosystem: 'python',
    cwd: pkg.dir,
    argv: [...(tool ? tool.slice(0, -1) : []), 'python', '-m', 'unittest', ...[...new Set(modules)].sort()],
    packages: [packageKey(pkg)],
  };
}

/** Python: a folder with pyproject.toml (`[project]` or `[tool.poetry]`) or setup.cfg (`[metadata]`)
 * is a package, src layouts included (the folder owns everything below it). Edges come from
 * requirements naming an in-repository package (dependencies, optional and dependency groups, Poetry
 * groups, setup.cfg install_requires/extras) and `[tool.uv.sources]` paths. setup.py is code and is
 * never read, so a package declared only there makes the layout unknown. uv workspace members are
 * declared. Tests run with pytest when the project declares it (dependency, `[tool.pytest]`,
 * pytest.ini or conftest.py), through the lockfile's tool (uv, Poetry, PDM) or `python -m pytest`. */
export function pythonGraph(paths: string[], read: ManifestReader): EcosystemResult {
  const manifests = paths.filter(pythonManifest);
  if (!manifests.length) return null;
  const present = new Set(paths);
  const byDir = new Map<string, Found>();
  const members: string[] = [];
  let pytest = paths.some(path => ['pytest.ini', 'conftest.py'].includes(basename(path)) && !SKIP.test(path));
  const configOnly = new Set<string>();
  for (const manifest of manifests.filter(path => basename(path) !== 'setup.py')) {
    const dir = dirname(manifest);
    const text = read(manifest);
    if (text === undefined) return { ecosystem: 'python', refusal: `${manifest} is unreadable` };
    let found: Found | { name: undefined; pytest: boolean };
    if (basename(manifest) === 'pyproject.toml') {
      let toml: TomlTable;
      try {
        toml = parseToml(text);
      } catch (error) {
        return { ecosystem: 'python', refusal: `${manifest}: ${(error as Error).message}` };
      }
      for (const glob of tomlStrings(tomlGet(toml, 'tool', 'uv', 'workspace', 'members')))
        members.push(dir ? `${dir}/${glob}` : glob);
      found = fromPyproject(manifest, toml);
    } else {
      const cfg = ini(text);
      const name = cfg.get('metadata')?.get('name');
      const requires = [
        ...(cfg.get('options')?.get('install_requires') ?? '').split('\n'),
        ...(cfg.get('options')?.get('tests_require') ?? '').split('\n'),
        ...[...(cfg.get('options.extras_require')?.values() ?? [])].flatMap(value => value.split('\n')),
      ].flatMap(spec => requirement(spec) ?? []);
      pytest ||= cfg.has('tool:pytest') || requires.some(spec => normal(spec) === 'pytest');
      found = name
        ? {
            pkg: { ecosystem: 'python', dir, name, manifest, dependsOn: [], testable: true, declared: false },
            requires,
            sources: [],
            pytest: false,
          }
        : { name: undefined, pytest: false };
    }
    pytest ||= found.pytest;
    if ('pkg' in found) {
      const previous = byDir.get(dir);
      // pyproject.toml wins over setup.cfg in one folder; both name the same package.
      if (!previous || basename(manifest) === 'pyproject.toml')
        byDir.set(dir, previous ? { ...found, requires: [...found.requires, ...previous.requires] } : found);
    } else configOnly.add(dir);
  }
  for (const manifest of manifests.filter(path => basename(path) === 'setup.py')) {
    const dir = dirname(manifest);
    if (!byDir.has(dir))
      return {
        ecosystem: 'python',
        refusal: `${manifest} declares a package only in setup.py, which is code and never read; add [project] metadata to pyproject.toml or setup.cfg`,
      };
  }
  for (const dir of configOnly)
    if (dir && !byDir.has(dir))
      return { ecosystem: 'python', refusal: `${dir}/pyproject.toml names no project` };
  const found = [...byDir.values()];
  if (!found.length) return null;
  const memberGlobs = members.map(globRegExp);
  const byName = new Map(found.map(item => [normal(item.pkg.name), item.pkg]));
  for (const item of found) {
    item.pkg.declared = memberGlobs.some(glob => glob.test(item.pkg.dir));
    const edges = new Set<string>();
    for (const spec of item.requires) {
      const target = byName.get(normal(spec));
      if (target && target !== item.pkg) edges.add(packageKey(target));
    }
    for (const dir of item.sources) {
      const target = byDir.get(dir)?.pkg;
      if (target && target !== item.pkg) edges.add(packageKey(target));
    }
    item.pkg.dependsOn = [...edges].sort();
  }
  const tool = (dir: string) => {
    const at = (file: string) => present.has(dir ? `${dir}/${file}` : file);
    if (at('uv.lock')) return ['uv', 'run', 'pytest'];
    if (at('poetry.lock')) return ['poetry', 'run', 'pytest'];
    if (at('pdm.lock')) return ['pdm', 'run', 'pytest'];
    return null;
  };
  return {
    ecosystem: 'python',
    packages: found.map(item => item.pkg),
    commands(selected, _changed, narrowed) {
      if (!pytest) {
        const refusal =
          'no pytest declared (dependency, [tool.pytest], pytest.ini or conftest.py), so Python packages have no unambiguous per-package test command';
        // unittest modules proven by the module graph (src/module-graph-python.ts) are the exception:
        // every selected package must be narrowed to them.
        const units = selected.map(pkg => narrowed?.get(packageKey(pkg)));
        if (!units.every(list => list?.length && list.every(unit => unit.startsWith(UNITTEST_UNIT))))
          return { refusal };
        const built = selected.map((pkg, index) =>
          unittestCommand(pkg, units[index]!, present, tool(pkg.dir)),
        );
        return built.find(item => 'refusal' in item) ?? (built as PackageCommand[]);
      }
      // A package with its own lockfile runs in its own folder; the rest run from the root.
      const own: PackageCommand[] = [];
      const shared: GraphPackage[] = [];
      // A narrowed package (src/module-selection.ts) runs only its test files that reach the change.
      const targets = (pkg: GraphPackage, from: string) =>
        narrowed
          ?.get(packageKey(pkg))
          ?.map(unit => unit.replace(UNITTEST_UNIT, ''))
          .map(path => (from ? path.slice(from.length + 1) : path)) ?? [pkg.dir || '.'];
      for (const pkg of selected) {
        const local = tool(pkg.dir);
        if (pkg.dir && local)
          own.push({
            ecosystem: 'python',
            cwd: pkg.dir,
            argv: [...local, ...(narrowed?.has(packageKey(pkg)) ? targets(pkg, pkg.dir) : [])],
            packages: [packageKey(pkg)],
          });
        else shared.push(pkg);
      }
      const prefix = tool('') ?? ['python', '-m', 'pytest'];
      return [
        ...(shared.length
          ? [
              {
                ecosystem: 'python' as const,
                cwd: '',
                argv: [...prefix, ...[...new Set(shared.flatMap(pkg => targets(pkg, '')))].sort()],
                packages: shared.map(packageKey),
              },
            ]
          : []),
        ...own,
      ];
    },
  };
}
