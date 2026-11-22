// SPDX-License-Identifier: Apache-2.0
// Parse repository bytes only: never import or execute the inspected modules.
import { posix } from 'node:path';
import { builtinModules } from 'node:module';
import {
  builtNames,
  escape,
  packageSelf,
  pathKind,
  repositoryWorkspaceUser,
} from './test-directory-path.mjs';
import { docsPackager, packageScriptGraph, recursiveJsonReader, scriptPath } from './script-impact.mjs';
import { byNameDispatch } from './convex-function-names.mjs';
import { resolveSymbols } from './test-symbols.mjs';
import { importFacts } from './test-import-cache.mjs';

export function testImportGraph(files, scriptsChanged = [], { typeImports = false } = {}) {
  const evidence = new Map(),
    rows = new Map();
  const emptyStatements = new Set();
  const wholeSite = { whole: true, statements: emptyStatements };
  const declarationSite = { whole: false, statements: emptyStatements };
  const byNameEvidence = { 'function-reference': new Map(), dynamic: new Map() };
  // `byName`: a by-name loader's closure edge (every module named anywhere the test's code can reach).
  // It keeps landing coverage but is weak closeness evidence: preflight never ranks it as direct.
  const edge = (dependency, importer, kind = 'package-command', detail, byName = false) => {
    // A runner naming behavior tests describes coverage, not its implementation.
    // Keep test-to-test imports, but never cycle coverage back into the pipeline.
    if (/^tests\/[^/]+\.test\.mjs$/.test(dependency) && !importer.startsWith('tests/')) return;
    let row = rows.get(dependency);
    if (!row) {
      row = { evidence: new Map(), sites: sites ? new Map() : null };
      rows.set(dependency, row);
      evidence.set(dependency, row.evidence);
      if (sites) sites.set(dependency, row.sites);
    }
    const previous = row.evidence.get(importer);
    // A workspace path is the narrowest evidence; dynamic is replaced by specific evidence.
    if (
      !previous ||
      (previous.detail === recursiveJsonReader && kind === 'import') ||
      previous.kind === 'workspace-path' ||
      (previous.kind === 'dynamic' && kind !== 'workspace-path')
    ) {
      if (byName) {
        const cache = byNameEvidence[kind];
        if (!cache.has(detail)) cache.set(detail, { kind, detail, byName: true });
        row.evidence.set(importer, cache.get(detail));
      } else row.evidence.set(importer, detail ? { kind, detail } : { kind });
    }
    // Where the importer refers to the dependency (test-symbols.mjs). An import or re-export
    // declaration is read from the importer's symbols; an edge made outside a parse is whole.
    if (!row.sites) return;
    const record = row.sites.get(importer);
    if (site === false || sitePath !== importer) {
      if (record?.statements.size) record.whole = true;
      else if (record !== wholeSite) row.sites.set(importer, wholeSite);
    } else if (site !== null) {
      if (record?.statements.size) record.statements.add(site);
      else row.sites.set(importer, { whole: record?.whole ?? false, statements: new Set([site]) });
    } else if (!record) row.sites.set(importer, declarationSite);
  };
  // Symbol-level reach is for runtime selection; type-contract graphs keep whole-module edges.
  const symbols = typeImports ? null : new Map(),
    sites = typeImports ? null : new Map();
  let site = false,
    sitePath = null;
  const packageGraph = packageScriptGraph(files, edge);
  if (scriptsChanged.length && packageGraph.error) return { error: packageGraph.error };
  const self = packageSelf(files);
  const bareResolutions = new Map();
  const relativeResolutions = new Map();
  function resolve(from, value) {
    if (self && (value === self.name || value.startsWith(`${self.name}/`)))
      value = self.exports.get(`.${value.slice(self.name.length)}`)?.slice(2) ?? value;
    const directory = value.startsWith('.') ? posix.dirname(from) : null;
    let cached = bareResolutions;
    if (directory !== null) {
      if (!relativeResolutions.has(directory)) relativeResolutions.set(directory, new Map());
      cached = relativeResolutions.get(directory);
    }
    if (!cached.has(value)) {
      const path = directory !== null ? posix.join(directory, value) : value;
      cached.set(value, resolvePath(path));
    }
    return cached.get(value);
  }
  function resolvePath(path) {
    path = path.replace(/^dist\//, 'src/').replace(/^(src\/.+)\.(?:js|d\.ts)$/, '$1.ts');
    if (files.has(path)) return path;
    if (path.endsWith('.js')) {
      const stem = path.slice(0, -3);
      if (files.has(`${stem}.ts`)) return `${stem}.ts`;
      if (files.has(`${stem}.tsx`)) return `${stem}.tsx`;
    } else if (path.endsWith('.mjs') || path.endsWith('.cjs')) {
      const alternate = `${path.slice(0, -2)}ts`;
      if (files.has(alternate)) return alternate;
    }
    for (const suffix of moduleSuffixes) if (files.has(path + suffix)) return path + suffix;
  }
  const moduleSuffixes = ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx'];
  if (typeImports) moduleSuffixes.push('.d.ts', '/index.d.ts');
  const packages = new Set(builtinModules);
  const packagePaths = [];
  if (files.has('package-lock.json')) {
    try {
      const locked = JSON.parse(files.get('package-lock.json')).packages;
      if (
        Object.values(locked).some(
          item => item.link || /^(?:file:|workspace:|\.|\/)/.test(item.resolved ?? ''),
        )
      )
        return {
          error: 'Local or workspace package dependency cannot be classified as external: package-lock.json',
        };
      for (const path of Object.keys(locked)) {
        const name = path.split('node_modules/').pop();
        if (name) packages.add(name);
        if (installedPath(path)) packagePaths.push(path);
      }
    } catch {
      return { error: 'Cannot classify locked external imports: package-lock.json' };
    }
  }
  const external = value => {
    if (value.startsWith('node:') || packages.has(value)) return true;
    // Check specifier prefixes (including scoped packages and built-in subpaths).
    for (let slash = value.indexOf('/'); slash >= 0; slash = value.indexOf('/', slash + 1))
      if (packages.has(value.slice(0, slash))) return true;
    return false;
  };
  const installedImport = (from, value) => {
    if (!value.startsWith('.') || !installedPath(value)) return false;
    const path = posix.join(posix.dirname(from), value);
    return packagePaths.some(packagePath => path.startsWith(`${packagePath}/`));
  };
  let uncertain;
  const domains = ['src/', 'web/src/', 'convex/', 'netlify/', 'scripts/', 'tests/'];
  const paths = [...files.keys()];
  const jsonFiles = paths.filter(file => file.endsWith('.json') && domains.some(dir => file.startsWith(dir)));
  const jsonGlobs = new Map();
  const matchingJson = pattern => {
    if (!jsonGlobs.has(pattern)) {
      // Literal prefixes discard code/example strings before invoking a glob
      // matcher. Cache the matching inventory once per pattern, not per reader.
      const prefix = pattern.includes('\\') ? '' : pattern.split(/[*?{[(!+@]/, 1)[0];
      jsonGlobs.set(
        pattern,
        jsonFiles.filter(target =>
          [target, posix.basename(target)].some(
            candidate => candidate.startsWith(prefix) && posix.matchesGlob(candidate, pattern),
          ),
        ),
      );
    }
    return jsonGlobs.get(pattern);
  };
  const jsonFolders = new Map();
  for (const file of jsonFiles)
    for (let folder = posix.dirname(file); folder !== '.'; folder = posix.dirname(folder)) {
      if (!jsonFolders.has(folder)) jsonFolders.set(folder, new Set());
      jsonFolders.get(folder).add(file);
    }

  const raw = importFacts(files, !typeImports);
  const loaderDefinitions = new Map();
  const definesLoader = home => {
    if (!loaderDefinitions.has(home)) loaderDefinitions.set(home, raw.get(home).defines);
    return loaderDefinitions.get(home);
  };
  const convexModules = paths
    .map(file => file.match(/^convex\/(?!_generated\/)(.+)\.[jt]s$/)?.[1])
    .filter(name => name && !name.endsWith('.d'));
  const convexResolutions = new Map();
  const convexModule = name => {
    if (!convexResolutions.has(name)) {
      const tsPath = `convex/${name}.ts`;
      const jsPath = `convex/${name}.js`;
      convexResolutions.set(name, files.has(tsPath) ? tsPath : files.has(jsPath) ? jsPath : undefined);
    }
    return convexResolutions.get(name);
  };
  // Convex calls functions by name ("module:function", api.module.function), not by
  // import. Every file's names are recorded; a name we cannot read stands for the
  // matching modules, or for every module. Backend and test code dispatch names
  // in-process (ctx.run*, scheduler, harness maps), so their names are edges: a
  // module's callers depend on it. Product clients send names over the network; in
  // tests that network is a fake, and a fake that runs a real module loads it by
  // import, by a literal list, or by name through a by-name loader (below).
  const named = new Map(),
    nameLoaders = new Set();
  const functionReference = (path, names, detail, kind = 'function-reference') => {
    let references = named.get(path);
    if (!references) {
      references = new Map();
      named.set(path, references);
    }
    const dispatches = /^(?:convex|tests)\//.test(path);
    for (const name of names) {
      const module = convexModule(name),
        evidence = { kind, detail: kind === 'dynamic' ? detail : `${detail}: ${name}` };
      if (references.get(module)?.kind !== 'function-reference') references.set(module, evidence);
      if (dispatches) edge(module, path, evidence.kind, evidence.detail);
    }
  };
  const widenFunctions = (path, prefix, detail) => {
    const matches = convexModules.filter(name => name.startsWith(prefix));
    functionReference(path, matches.length ? matches : convexModules, detail, 'dynamic');
  };
  const changedScripts = new Set(scriptsChanged.map(item => item.path));
  const domainPaths = new Map(domains.map(domain => [domain, []]));
  const sourcePaths = [];
  for (const path of paths) {
    const domain = domains.find(prefix => path.startsWith(prefix));
    if (domain) {
      domainPaths.get(domain).push(path);
      sourcePaths.push(path);
    }
  }
  const built = new Map();
  const namesAt = path => {
    if (!built.has(path)) built.set(path, builtNames(path));
    return built.get(path);
  };
  const suffixMatches = new Map();
  const templateMatches = new Map();
  const widenedPaths = (prefix, from) => {
    if (prefix.suffix) {
      const suffix = prefix.suffix;
      if (!suffixMatches.has(suffix))
        suffixMatches.set(
          suffix,
          paths.filter(candidate =>
            namesAt(candidate).some(name => name === suffix || name.endsWith(`/${suffix}`)),
          ),
        );
      return suffixMatches.get(suffix);
    }
    const template = Array.isArray(prefix) ? prefix : null;
    const head = template ? template[0] : prefix;
    const normalized = head.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), head)) : head;
    const domain = normalized.startsWith('dist/') ? 'src/' : domains.find(dir => normalized.startsWith(dir));
    if (!domain) return sourcePaths;
    const candidates = domainPaths.get(domain);
    if (!template) return candidates;
    const patternSource = `^${[normalized, ...template.slice(1)].map(escape).join('.*')}(?:/.*)?$`;
    if (!templateMatches.has(patternSource)) {
      const pattern = new RegExp(patternSource, 's');
      templateMatches.set(
        patternSource,
        candidates.filter(candidate => namesAt(candidate).some(name => pattern.test(name))),
      );
    }
    return templateMatches.get(patternSource);
  };
  const workspaceUsers = new Set();
  for (const path of paths.slice().sort()) {
    if (!/\.(?:[cm]?js|[cm]?tsx?)$/.test(path) || (!typeImports && path.endsWith('.d.ts'))) {
      if (repositoryWorkspaceUser(path, () => files.get(path))) workspaceUsers.add(path);
      continue;
    }
    const facts = raw.get(path);
    raw.release(path);
    loaderDefinitions.set(path, facts.defines);
    if (facts.invalid) {
      raw.flush();
      return { error: `Unparseable ${scriptPath(path) ? 'script' : 'module'}: ${path}` };
    }
    if (facts.workspaceUser) workspaceUsers.add(path);
    const isScriptOrTest = /^(?:tests|scripts)\//.test(path);
    site = false;
    sitePath = path;
    const resolved = new Map();
    const resolveHere = specifier => {
      if (!resolved.has(specifier)) resolved.set(specifier, resolve(path, specifier));
      return resolved.get(specifier);
    };
    if (symbols) symbols.set(path, resolveSymbols(facts.symbols, resolveHere));
    if (typeImports)
      for (const specifier of facts.types) {
        const target = resolveHere(specifier);
        if (target) edge(target, path, 'import');
      }
    const loaderHome = new Map();
    for (const [local, from, imported] of facts.loader.imports) {
      const home = resolveHere(from);
      if (home)
        loaderHome.set(
          local,
          !facts.loader.shadows.has(local) && definesLoader(home).has(imported) ? home : unknownHome,
        );
    }
    const homeOf = reference => {
      if (!reference) return null;
      if (typeof reference === 'string') return loaderHome.get(reference) ?? null;
      const [specifier, name] = reference;
      const home = specifier !== null && resolveHere(specifier);
      return home && definesLoader(home).has(name) ? home : unknownHome;
    };
    const apiNames = new Set(
      facts.api
        .filter(
          ([, from, anyApi]) =>
            anyApi || /(?:^|\/)convex\/_generated\/api\.[jt]s$/.test(resolveHere(from) ?? ''),
        )
        .map(([name]) => name),
    );
    const widen = (prefix, detail = 'Computed module path', kind = 'dynamic', from = path) => {
      for (const candidate of widenedPaths(prefix, from)) edge(candidate, path, kind, detail);
    };
    const loadStack = [];
    for (const fact of facts.events) {
      site = fact.site;
      switch (fact.kind) {
        case 'root':
          for (const target of jsonFiles)
            if (!fact.suffix || target.endsWith(fact.suffix))
              edge(target, path, 'runtime-path', recursiveJsonReader);
          break;
        case 'api': {
          const { name, segments } = fact;
          if (!apiNames.has(name)) break;
          if (!segments) widenFunctions(path, '', `Whole Convex API object: ${name}`);
          else {
            const length = segments.findLastIndex((_, i) => convexModule(segments.slice(0, i + 1).join('/')));
            if (length >= 0)
              functionReference(path, [segments.slice(0, length + 1).join('/')], 'Convex API reference');
            else {
              const folder = segments.join('/');
              widenFunctions(path, folder ? `${folder}/` : '', `Unresolved Convex API reference: ${folder}`);
            }
          }
          break;
        }
        case 'literal': {
          const { value, name } = fact;
          if (fact.json) {
            const locations = [
              posix.normalize(value),
              ...(!fact.parameter && !posix.isAbsolute(value)
                ? [posix.join(posix.dirname(path), value)]
                : []),
            ];
            for (const location of locations)
              for (const target of jsonFolders.get(location.replace(/\/$/, '')) ?? [])
                edge(target, path, 'runtime-path', 'JSON directory reader');
            if (fact.glob)
              for (const pattern of locations)
                for (const target of matchingJson(pattern))
                  edge(target, path, 'runtime-path', 'Matching JSON glob');
          }
          if (name && convexModule(name)) functionReference(path, [name], 'Convex function name');
          else if (fact.unknownName) widenFunctions(path, '', `Unknown Convex function name: ${value}`);
          if (fact.importing || fact.runtime) {
            const from = homeOf(fact.home);
            const target =
              from === unknownHome ? undefined : from ? resolve(from, value) : resolveHere(value);
            if (fact.specifier && !target && !external(value) && !installedImport(path, value))
              uncertain = `Unresolved import ${value} in ${path}`;
            if (target) edge(target, path, fact.importing ? 'import' : pathKind(path, value));
          }
          if (fact.runtime && isScriptOrTest) packageGraph.reference?.(value, path);
          if (fact.widen) widen(fact.widen);
          break;
        }
        case 'template': {
          const { names, literal, enumerated, parts } = fact;
          if (names) {
            const matches = convexModules.filter(name => names.pattern.test(name));
            if (names.exact) functionReference(path, matches, 'Convex function name from literal values');
            else if (matches.length)
              functionReference(path, matches, `Computed Convex function name: ${fact.source}`, 'dynamic');
            else if (fact.reference) widenFunctions(path, '', `Unknown Convex function name: ${fact.source}`);
          }
          const file = literal && resolveHere(literal);
          if (file && file.endsWith(literal.replace(/^(?:\.\.?\/)+/, '')))
            edge(file, path, pathKind(path, literal));
          else if (fact.nameLoader) nameLoaders.add(path);
          else if (parts) {
            const targets = enumerated?.map(resolveHere);
            if (targets?.every(Boolean))
              for (const [i, target] of targets.entries()) edge(target, path, pathKind(path, enumerated[i]));
            else
              widen(
                parts,
                undefined,
                pathKind(path, parts[0]) === 'workspace-path' ? 'workspace-path' : 'dynamic',
              );
          }
          break;
        }
        case 'glob':
          for (const target of paths)
            if (fact.matchers.some(matcher => matcher.test(target))) edge(target, path, 'import');
          break;
        case 'load': {
          const loaded = [];
          if (!fact.unprovenGlob) loadStack.push(loaded);
          for (const { values, homes, knownBare, template, prefixes, suffix } of fact.alternatives) {
            const home = homes?.map(homeOf).find(Boolean);
            const known = value => {
              if (home === unknownHome) return false;
              const target = home ? resolve(home, value) : resolveHere(value);
              if (target) loaded.push(target);
              return target || external(value) || installedPath(value);
            };
            if (values?.every(known) || knownBare) continue;
            if (suffix) widen({ suffix }, `Computed loader path ending: ${suffix}`);
            else {
              if (changedScripts.has(path) && !docsPackager(path))
                uncertain = `Unknown module loading in changed script: ${path}`;
              for (const prefix of template ? [home === unknownHome ? '' : template] : prefixes) {
                const domain = Array.isArray(prefix) ? prefix[0] : prefix;
                widen(
                  prefix,
                  Array.isArray(prefix) || prefix
                    ? `Computed loader domain: ${domain}`
                    : 'Unknown module loader',
                  'dynamic',
                  Array.isArray(prefix) && home ? home : path,
                );
              }
            }
          }
          break;
        }
        case 'loaded':
          for (const target of loadStack.pop()) edge(target, path, 'import');
          break;
      }
    }
    site = false;
  }
  raw.flush();
  if (uncertain) return { error: uncertain };
  if (scriptsChanged.length && packageGraph.error) return { error: packageGraph.error };
  byNameDispatch(files, evidence, edge, named, nameLoaders);
  const reverse = new Map();
  for (const [dependency, importers] of evidence) reverse.set(dependency, new Set(importers.keys()));
  return { reverse, evidence, packageGraph, workspaceUsers, symbols, sites };
}

const unknownHome = Symbol('unknown loader home');
/** A path into an installed package's folder loads no repository source: the lockfile owns it. */
const installedPath = value => /(?:^|\/)node_modules\//.test(value);
