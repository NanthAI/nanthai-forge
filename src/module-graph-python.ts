// SPDX-License-Identifier: Apache-2.0
import { blank, identifiers, joinPath, posixBasename, posixDirname } from './module-graph-scan.js';
import type { ModuleContext } from './module-graph-types.js';

/** Python module edges: `import a.b`, `from a.b import c` (c may be a submodule), relative imports,
 * the `__init__.py` chain every import runs, the conftest.py files pytest loads for a test, and
 * `pkg.sub` attribute use after importing a package. Absolute imports resolve against the repository
 * root, each Python project folder and its `src/`, and the test file's own rootdir-relative base (the
 * folder pytest puts on sys.path). Dynamic loading (importlib, `__import__`, runpy, subprocess,
 * sys.path edits, exec) and a local-looking import Forge cannot resolve make the file `wide`, unless
 * no Python file or folder in the repository has the missing module's name (a compiled extension or
 * generated module: its sources are not Python, so changing them keeps the package whole). */

type PythonImport = { module: string; names: string[] };
export type PythonFacts = { imports: PythonImport[]; tokens: string[]; wide?: string };

const DYNAMIC =
  /\b(?:importlib|__import__|runpy|pkgutil|subprocess|execfile|load_module|spec_from_file_location|pytest_plugins|entry_points)\b|\bsys\s*\.\s*(?:path|meta_path|modules)\b|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*)\b|(?<![\w.])exec\s*\(/;
/** pytest settings that change which files are tests or how they import. */
const PYTEST_LAYOUT = /\b(?:python_files|pythonpath|import-mode|import_mode|rootdir)\b/;
const CONFIGS = new Set(['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']);

export const pythonTestFile = (path: string) => /^(?:test_.*|.*_test)\.py$/.test(posixBasename(path));

export function pythonFacts(_path: string, text: string): PythonFacts {
  const code = blank(text, 'python');
  // Logical lines: backslash continuations and parenthesized import lists join into one line.
  const joined = code
    .replace(/\\\r?\n/g, ' ')
    .replace(/\(([^()]*)\)/g, (_all, inner: string) => ` ${inner.replace(/\n/g, ' ')} `);
  const imports: PythonImport[] = [];
  for (const line of joined.split(/[\n;]/)) {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(line);
    if (from) {
      const names = from[2]!
        .split(',')
        .map(part =>
          part
            .trim()
            .split(/\s+as\s+/)[0]!
            .trim(),
        )
        .filter(name => /^(?:\w+|\*)$/.test(name));
      imports.push({ module: from[1]!, names });
      continue;
    }
    const plain = /^\s*import\s+(.+)$/.exec(line);
    if (plain)
      for (const part of plain[1]!.split(',')) {
        const module = part
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (/^[\w.]+$/.test(module)) imports.push({ module, names: [] });
      }
  }
  const dynamic = DYNAMIC.exec(code);
  return {
    imports,
    tokens: [...identifiers(code)],
    ...(dynamic ? { wide: `dynamic loading (${dynamic[0].replace(/\s+/g, '')})` } : {}),
  };
}

export function resolvePython(context: ModuleContext) {
  const files = [...context.facts].filter(([path]) => path.endsWith('.py')) as [string, PythonFacts][];
  if (!files.length) return;
  const python = new Set([...context.nodes.keys()].filter(path => path.endsWith('.py')));
  const folders = new Set<string>();
  for (const path of python)
    for (let dir = posixDirname(path); dir; dir = posixDirname(dir)) folders.add(dir);
  // Test files are pytest's defaults; without pytest declared (src/package-graph-python.ts) another
  // runner may name tests otherwise, so no Python package is narrowed.
  let pytest = [...python].some(path => posixBasename(path) === 'conftest.py');
  let layout: string | undefined;
  for (const path of context.paths)
    if (CONFIGS.has(posixBasename(path)) && !/(?:^|\/)\./.test(path)) {
      const text = context.read(path) ?? '';
      pytest ||= posixBasename(path) === 'pytest.ini' || /\bpytest\b/.test(text);
      const found = PYTEST_LAYOUT.exec(text);
      if (found) layout ??= `${path} sets ${found[0]}, which changes test discovery or imports`;
    }
  const whole =
    layout ?? (pytest ? undefined : 'no pytest declared, so Forge cannot tell which files are tests');
  if (whole) for (const file of python) context.nodes.get(file)!.whole = whole;
  const roots = new Set(['', 'src']);
  for (const path of context.paths)
    if (['pyproject.toml', 'setup.cfg', 'setup.py'].includes(posixBasename(path))) {
      roots.add(posixDirname(path));
      roots.add(joinPath(posixDirname(path), 'src'));
    }
  const moduleAt = (base: string) =>
    python.has(`${base}.py`)
      ? `${base}.py`
      : python.has(`${base}/__init__.py`)
        ? `${base}/__init__.py`
        : folders.has(base)
          ? ''
          : undefined;
  // A module no Python file or folder could be (a compiled extension, generated code) is built from
  // non-Python sources; a change to those has no module facts, so its package runs whole anyway.
  const stems = new Set([...python, ...folders].map(path => posixBasename(path).replace(/\.py$/, '')));
  let failed = '';
  const basedir = (path: string) => {
    let dir = posixDirname(path);
    while (dir && python.has(`${dir}/__init__.py`)) dir = posixDirname(dir);
    return dir;
  };
  for (const [path, facts] of files) {
    const node = context.nodes.get(path)!;
    const deps = node.deps;
    if (facts.wide) node.wide = facts.wide;
    for (let dir = posixDirname(path); python.has(joinPath(dir, '__init__.py')); dir = posixDirname(dir)) {
      if (joinPath(dir, '__init__.py') !== path) deps.push(joinPath(dir, '__init__.py'));
      if (!dir) break;
    }
    if (pythonTestFile(path) || posixBasename(path) === 'conftest.py')
      for (let dir = posixDirname(path); ; dir = posixDirname(dir)) {
        const conftest = joinPath(dir, 'conftest.py');
        if (conftest !== path && python.has(conftest)) deps.push(conftest);
        if (!dir) break;
      }
    if (pythonTestFile(path)) node.units = [path];
    const own = [...new Set([...roots, basedir(path)])];
    const packages: string[] = [];
    /** Walks `segments` from `base`, adding each module it runs; the last module's folder or null. */
    const walk = (base: string, segments: string[]) => {
      let at = base;
      for (const segment of segments) {
        at = joinPath(at, segment);
        const found = moduleAt(at);
        if (found === undefined) {
          failed = segment;
          return null;
        }
        if (found) deps.push(found);
      }
      return at;
    };
    const names = (base: string, list: string[]) => {
      for (const name of list) {
        if (name === '*') continue;
        const found = moduleAt(joinPath(base, name));
        if (found) deps.push(found);
      }
      if (moduleAt(base) !== undefined) packages.push(base);
    };
    for (const item of facts.imports) {
      const dots = /^\.*/.exec(item.module)![0].length;
      const segments = item.module.slice(dots).split('.').filter(Boolean);
      if (dots) {
        let base = posixDirname(path);
        let outside = false;
        for (let i = 1; i < dots; i++) {
          if (!base) outside = true;
          base = posixDirname(base);
        }
        const init = joinPath(base, '__init__.py');
        if (python.has(init) && init !== path) deps.push(init);
        failed = '';
        const end = outside ? null : walk(base, segments);
        if (end !== null) names(end, item.names);
        else if (outside || stems.has(failed)) node.wide ??= `unresolved relative import ${item.module}`;
        continue;
      }
      let resolved = false,
        local = false,
        couldBe = false;
      for (const root of own) {
        if (moduleAt(joinPath(root, segments[0]!)) === undefined) continue;
        local = true;
        failed = '';
        const end = walk(root, segments);
        if (end === null) {
          couldBe ||= stems.has(failed);
          continue;
        }
        resolved = true;
        names(end, item.names);
      }
      if (local && !resolved && couldBe) node.wide ??= `unresolved local import ${item.module}`;
    }
    // `import pkg` then `pkg.sub.f()`: a submodule named in this file may be what runs.
    if (packages.length) {
      const tokens = new Set(facts.tokens);
      for (const base of new Set(packages))
        for (const token of tokens) {
          const found = moduleAt(joinPath(base, token));
          if (found) deps.push(found);
        }
    }
  }
}
