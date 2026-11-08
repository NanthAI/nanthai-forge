// SPDX-License-Identifier: Apache-2.0
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import ts from 'typescript';

/** A static import graph of any JavaScript or TypeScript repository, for test selection with any
 * project test runner (Forge's own Node layout keeps scripts/test-import-graph.mjs).
 *
 * It parses import, export-from, require and import() specifiers with TypeScript's preprocessor;
 * it never imports, executes or type-checks repository code. Specifiers resolve as relative paths
 * (with the usual TypeScript extension rules), workspace package names (any package.json with a
 * `name`; `exports`, `main`, `module` and `source` entries, `dist/` read as `src/`, else every source
 * file of the package) and tsconfig/jsconfig `paths` aliases. A file with a computed import, an
 * `import.meta.glob` or a bare specifier no manifest declares is `open`: tests that reach it are
 * selected for every code change. Edges can be missing (fs reads, generated files), so a selection
 * from this graph is advisory local evidence, never an independence proof. */
export type ImportGraph = {
  /** module → files that import it (a package node `package:DIR` stands for a whole package). */
  reverse: Map<string, Set<string>>;
  /** Files whose imports cannot all be resolved statically. */
  open: Set<string>;
  /** Code files that were not read (missing locally or over the size limit). */
  unread: number;
};

export const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SOURCE_FILE = (path: string) => CODE_FILE.test(path) && !/\.d\.[cm]?ts$/.test(path);
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
/** Bounds per graph: beyond them selection stays path-only (src/project-test-runner.ts). */
export const IMPORT_GRAPH_LIMITS = { files: 20_000, fileBytes: 1024 * 1024, totalBytes: 128 * 1024 * 1024 };
const COMPUTED = /\b(?:import|require)\s*\(\s*(?!['"][^'"\n]*['"]\s*[,)])[^\s)]|\bimport\.meta\.glob\s*\(/;

const ignored = (path: string) =>
  path.split('/').some(part => part === 'node_modules' || (part.startsWith('.') && part.length > 1));
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const parseJson = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  const parsed = ts.parseConfigFileTextToJson('config.json', text);
  return parsed.error || !record(parsed.config) ? undefined : parsed.config;
};
const packageName = (specifier: string) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
/** Leaves of an `exports` value: a string, or every string inside condition objects and arrays. */
const leaves = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(leaves)
      : record(value)
        ? Object.values(value).flatMap(leaves)
        : [];

type Alias = { dir: string; base: string; paths: [string, string[]][] };

/** Build the graph from every path of the head and a reader of its bytes. */
export function jsImportGraph(
  allPaths: Iterable<string>,
  read: (path: string) => string | undefined,
): ImportGraph | { error: string } {
  const paths = [...new Set(allPaths)].filter(path => !ignored(path));
  const present = new Set(paths);
  const sources = paths.filter(SOURCE_FILE);
  if (sources.length > IMPORT_GRAPH_LIMITS.files)
    return {
      error: `${sources.length} code files exceed the import graph bound (${IMPORT_GRAPH_LIMITS.files})`,
    };
  // Workspace packages, the dependencies every manifest declares, and alias configs.
  const workspace = new Map<string, { dir: string; manifest: Record<string, unknown> }>();
  const declared = new Set<string>();
  for (const path of paths.filter(path => path === 'package.json' || path.endsWith('/package.json'))) {
    const manifest = parseJson(read(path));
    if (!manifest) continue;
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    if (typeof manifest.name === 'string' && manifest.name) workspace.set(manifest.name, { dir, manifest });
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      if (record(manifest[field])) for (const name of Object.keys(manifest[field])) declared.add(name);
  }
  const aliases = aliasConfigs(paths, read);
  const packageDirs = [...workspace.values()].map(item => item.dir).sort((a, b) => b.length - a.length);
  const owner = (path: string) => packageDirs.find(dir => !dir || path.startsWith(`${dir}/`)) ?? '';
  const reverse = new Map<string, Set<string>>();
  const open = new Set<string>();
  const edge = (target: string, importer: string) => {
    if (target === importer) return;
    if (!reverse.has(target)) reverse.set(target, new Set());
    reverse.get(target)!.add(importer);
  };
  const file = (base: string) => {
    const stripped = base.replace(/^\.\//, '');
    const candidates = [
      stripped,
      stripped.replace(/\.js$/, '.ts'),
      stripped.replace(/\.js$/, '.tsx'),
      stripped.replace(/\.jsx$/, '.tsx'),
      stripped.replace(/\.mjs$/, '.mts'),
      stripped.replace(/\.cjs$/, '.cts'),
      ...EXTENSIONS.map(ext => stripped + ext),
      ...EXTENSIONS.map(ext => `${stripped}/index${ext}`),
    ];
    return candidates.find(candidate => present.has(candidate));
  };
  const usedPackages = new Set<string>();
  const packageEntry = (dir: string, manifest: Record<string, unknown>, subpath: string) => {
    const join = (value: string) => posix.normalize(posix.join(dir || '.', value));
    const found: string[] = [];
    const exports = manifest.exports;
    const key = subpath ? `./${subpath}` : '.';
    const values =
      typeof exports === 'string' || Array.isArray(exports)
        ? subpath
          ? []
          : leaves(exports)
        : record(exports)
          ? Object.keys(exports).some(name => name.startsWith('.'))
            ? exportTargets(exports, key)
            : subpath
              ? []
              : leaves(exports)
          : [];
    const fields = subpath
      ? []
      : ['source', 'module', 'main', 'types'].flatMap(name => leaves(manifest[name]));
    for (const value of values.length ? values : fields) {
      // Built output names its source: `./dist/x.js` (or `.d.ts`) is read as `./src/x`.
      const source = value
        .replace(/^(?:\.\/)?(?:dist|build|lib|out)\//, 'src/')
        .replace(/\.d\.[cm]?ts$/, '')
        .replace(/\.[cm]?js$/, '');
      const resolved = file(join(value)) ?? file(join(source));
      if (resolved) found.push(resolved);
    }
    if (!found.length) {
      const direct = file(join(subpath || 'index')) ?? file(join(`src/${subpath || 'index'}`));
      if (direct) found.push(direct);
    }
    return found;
  };
  const resolve = (from: string, specifier: string): string[] | 'external' | null => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (specifier.startsWith('/')) return null;
      const target = file(posix.normalize(posix.join(posix.dirname(from), specifier.replace(/[?#].*$/, ''))));
      return target ? [target] : [];
    }
    if (specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0]!)) return 'external';
    const name = packageName(specifier);
    const local = workspace.get(name);
    if (local) {
      const found = packageEntry(local.dir, local.manifest, specifier.slice(name.length + 1));
      if (found.length) return found;
      usedPackages.add(local.dir);
      return [`package:${local.dir}`];
    }
    const alias = aliasTarget(aliases, from, specifier, file);
    if (alias) return alias;
    if (declared.has(name)) return 'external';
    return null;
  };
  let total = 0,
    unread = 0;
  for (const path of sources) {
    const text = read(path);
    if (text === undefined || text.length > IMPORT_GRAPH_LIMITS.fileBytes) {
      unread++;
      continue;
    }
    total += text.length;
    if (total > IMPORT_GRAPH_LIMITS.totalBytes)
      return { error: `code bytes exceed the import graph bound (${IMPORT_GRAPH_LIMITS.totalBytes})` };
    if (COMPUTED.test(text)) open.add(path);
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      const targets = resolve(path, fileName);
      if (targets === null) open.add(path);
      else if (targets !== 'external') for (const target of targets) edge(target, path);
    }
  }
  // A package imported as a whole depends on every source file it holds (nested packages excluded).
  for (const dir of usedPackages)
    for (const path of sources) if (owner(path) === dir) edge(path, `package:${dir}`);
  return { reverse, open, unread };
}

/** `exports` targets for `key`, with one `*` pattern key (`./*`, `./utils/*`). */
function exportTargets(exports: Record<string, unknown>, key: string): string[] {
  if (key in exports) return leaves(exports[key]);
  for (const [pattern, value] of Object.entries(exports)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const [head, tail] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (key.startsWith(head) && key.endsWith(tail) && key.length >= head.length + tail.length) {
      const middle = key.slice(head.length, key.length - tail.length);
      return leaves(value).map(target => target.replaceAll('*', middle));
    }
  }
  return [];
}

/** tsconfig.json / jsconfig.json `paths` (with relative `extends`, a few levels), by directory. */
function aliasConfigs(paths: string[], read: (path: string) => string | undefined): Alias[] {
  const configs: Alias[] = [];
  for (const path of paths.filter(path => /(?:^|\/)[tj]sconfig\.json$/.test(path))) {
    let options: Record<string, unknown> = {};
    let current: string | undefined = path,
      optionsDir = '';
    // Child options win; `paths`/`baseUrl` resolve from the config that declares them.
    const chain: { dir: string; options: Record<string, unknown> }[] = [];
    for (let depth = 0; current && depth < 5; depth++) {
      const config = parseJson(read(current));
      if (!config) break;
      const dir: string = posix.dirname(current) === '.' ? '' : posix.dirname(current);
      chain.push({ dir, options: record(config.compilerOptions) ? config.compilerOptions : {} });
      const parent: unknown = config.extends;
      current =
        typeof parent === 'string' && parent.startsWith('.')
          ? posix.normalize(posix.join(dir || '.', parent.endsWith('.json') ? parent : `${parent}.json`))
          : undefined;
    }
    for (const item of chain.reverse()) {
      if (item.options.paths !== undefined || item.options.baseUrl !== undefined) optionsDir = item.dir;
      options = { ...options, ...item.options };
    }
    if (!record(options.paths)) continue;
    const base = posix.normalize(
      posix.join(optionsDir || '.', typeof options.baseUrl === 'string' ? options.baseUrl : '.'),
    );
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    configs.push({
      dir,
      base: base === '.' ? '' : base,
      paths: Object.entries(options.paths).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
      ]),
    });
  }
  return configs.sort((a, b) => b.dir.length - a.dir.length);
}

function aliasTarget(
  configs: Alias[],
  from: string,
  specifier: string,
  file: (base: string) => string | undefined,
): string[] | null {
  const config = configs.find(item => !item.dir || from.startsWith(`${item.dir}/`));
  if (!config) return null;
  for (const [pattern, targets] of config.paths) {
    const star = pattern.indexOf('*');
    const middle =
      star < 0
        ? pattern === specifier
          ? ''
          : null
        : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))
          ? specifier.slice(star, specifier.length - (pattern.length - star - 1))
          : null;
    if (middle === null) continue;
    for (const target of targets) {
      const resolved = file(posix.normalize(posix.join(config.base || '.', target.replace('*', middle))));
      if (resolved) return [resolved];
    }
  }
  return null;
}

/** Tests that reach a changed file through imports, plus tests that reach an `open` file when any
 * code changed. `tests` are the runner's test files. */
export function importGraphTests(graph: ImportGraph, tests: readonly string[], changed: readonly string[]) {
  const testSet = new Set(tests);
  const reach = (starts: Iterable<string>) => {
    const seen = new Set<string>(starts);
    const queue = [...seen];
    while (queue.length)
      for (const importer of graph.reverse.get(queue.pop()!) ?? [])
        if (!seen.has(importer)) {
          seen.add(importer);
          queue.push(importer);
        }
    return seen;
  };
  const traced = changed.filter(path => graph.reverse.has(path) || testSet.has(path));
  const untraced = changed.filter(path => !traced.includes(path) && CODE_FILE.test(path));
  const reached = [...reach(traced)].filter(path => testSet.has(path));
  const open =
    changed.some(path => CODE_FILE.test(path)) && graph.open.size
      ? [...reach(graph.open)].filter(path => testSet.has(path))
      : [];
  return { tests: [...new Set([...reached, ...open])].sort(), openTests: open.length, untraced };
}
