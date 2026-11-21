// SPDX-License-Identifier: Apache-2.0
import { Buffer } from 'node:buffer';
import type ts from 'typescript';
import { JS_PACKAGE_MANIFEST } from './ecosystems.js';
import { CODE_FILE, IMPORT_GRAPH_LIMITS } from './js-import-graph.js';
import { visitJsSpecifiers } from './js-inbound-specifiers.js';
import { loadTypescript } from './lazy-typescript.js';
import { basename, dirname, joinPath, type ManifestReader } from './package-graph-types.js';

const CONFIG = /^[tj]sconfig.*\.json$/;
const relative = /^(?:\.{1,2})(?:[/\\]|$)/;
const absolute = /^(?:[/\\]|[A-Za-z]:[/\\]|file:)/;
const bare = (value: string) => !relative.test(value) && !absolute.test(value) && !value.startsWith('#');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A baseUrl can only contribute a bare prefix when it encloses the candidate. Index each relative
 * folder once so every bare import need not be joined with every config's baseUrl. */
function aliasFolders(folders: ReadonlySet<string>, bases: ReadonlySet<string>) {
  const byRelative = new Map<string, string[]>();
  for (const folder of folders) {
    for (let base = dirname(folder); ; base = dirname(base)) {
      if (bases.has(base)) {
        const key = base ? folder.slice(base.length + 1) : folder;
        const targets = byRelative.get(key);
        if (targets) targets.push(folder);
        else byRelative.set(key, [folder]);
      }
      if (!base) break;
    }
  }
  return byRelative;
}

function lexicalSpellings(value: string) {
  // Node ESM decodes file URLs. CommonJS also names literal filenames.
  if (!value.includes('%')) return [value];
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? [value] : [value, decoded];
  } catch {
    return [value];
  }
}

/** A proof over captured names and source, independent of local test selection. It never looks up
 * the target of an import. A missing target has exactly the same effect as an existing one. */
export function certifyJsInbound(
  paths: readonly string[],
  read: ManifestReader,
  folders: readonly string[],
  readConfig: ManifestReader,
): string[] {
  const active = new Set(folders);
  if (!active.size) return [];
  const owner = (path: string) => {
    for (let dir = path; dir; dir = dirname(dir)) if (active.has(dir)) return dir;
    return '';
  };
  const refuseOutside = (inside: string) => {
    for (const dir of active) if (dir !== inside) active.delete(dir);
  };
  const target = (dir: string, value: string, inside: string, prefix?: 'directory' | 'partial') => {
    if (absolute.test(value)) {
      refuseOutside(inside);
      return;
    }
    for (const spelling of lexicalSpellings(value)) {
      const resolved = joinPath(dir, spelling);
      if (resolved === null) continue;
      const enclosing = owner(resolved);
      if (enclosing && enclosing !== inside) active.delete(enclosing);
      if (prefix)
        for (const candidate of active)
          if (
            candidate !== inside &&
            (!resolved || candidate.startsWith(prefix === 'directory' ? resolved + '/' : resolved))
          )
            active.delete(candidate);
    }
    if (prefix && /%(?:[\da-f]?$)/i.test(value)) refuseOutside(inside);
  };

  const sources = paths.filter(path => CODE_FILE.test(path));
  if (sources.length > IMPORT_GRAPH_LIMITS.files) {
    const internal = new Map<string, number>();
    for (const path of sources) {
      const folder = owner(path);
      if (folder) internal.set(folder, (internal.get(folder) ?? 0) + 1);
    }
    for (const folder of active)
      if (sources.length - (internal.get(folder) ?? 0) > IMPORT_GRAPH_LIMITS.files) active.delete(folder);
  }
  if (!active.size) return [];

  const api = loadTypescript();
  const bases = new Set<string>();
  const configs = new Set(
    paths.filter(path => {
      const name = basename(path);
      return name === JS_PACKAGE_MANIFEST || CONFIG.test(name);
    }),
  );
  const aliasTargets: Array<{ inside: string; value: string }> = [];
  const alias = (dir: string, value: string, inside: string) => {
    const star = value.indexOf('*');
    const prefix = star < 0 ? value : value.slice(0, star);
    target(dir, prefix, inside, star < 0 ? undefined : /[/\\]$/.test(prefix) ? 'directory' : 'partial');
  };
  for (const path of configs) {
    const inside = owner(path);
    if (!active.size) return [];
    if (inside && active.size === 1) continue;
    const text = readConfig(path);
    const parsed = text === undefined ? undefined : api.parseConfigFileTextToJson(path, text);
    const config: unknown = parsed?.config;
    if (!parsed || parsed.error || !object(config)) {
      refuseOutside(inside);
      continue;
    }
    const dir = dirname(path);
    if (basename(path) === JS_PACKAGE_MANIFEST) {
      const imports = (value: unknown) => {
        if (typeof value === 'string') alias(dir, value, inside);
        else if (Array.isArray(value) || object(value))
          for (const child of Object.values(value)) imports(child);
      };
      imports(config.imports);
      continue;
    }
    if (config.extends !== undefined) {
      const inherited = Array.isArray(config.extends) ? config.extends : [config.extends];
      for (const entry of inherited) {
        const resolved = typeof entry === 'string' && relative.test(entry) ? joinPath(dir, entry) : null;
        if (resolved === null || (!configs.has(resolved) && !configs.has(resolved + '.json')))
          refuseOutside(inside);
        else target(dir, entry, inside);
      }
    }
    const options = config.compilerOptions;
    if (options === undefined) continue;
    if (!object(options)) {
      refuseOutside(inside);
      continue;
    }
    const baseUrl = options.baseUrl;
    const base = typeof baseUrl === 'string' ? joinPath(dir, baseUrl) : dir;
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== 'string') refuseOutside(inside);
      else target(dir, baseUrl, inside);
      if (base !== null && typeof baseUrl === 'string' && !absolute.test(baseUrl)) bases.add(base);
    }
    if (options.paths === undefined) continue;
    if (
      !object(options.paths) ||
      Object.values(options.paths).some(
        values => !Array.isArray(values) || values.some(value => typeof value !== 'string'),
      )
    ) {
      refuseOutside(inside);
      continue;
    }
    if (base !== null)
      for (const values of Object.values(options.paths) as string[][])
        for (const value of values) {
          if (baseUrl === undefined && config.extends !== undefined) aliasTargets.push({ inside, value });
          alias(base, value, inside);
        }
  }
  const aliases = aliasFolders(active, bases);
  const aliasKeys = [...aliases.keys()].sort();
  const refuseAlias = (inside: string, specifier: string, prefix?: 'partial' | 'directory') => {
    if (!bases.size) return;
    const block = (key: string) => {
      for (const folder of aliases.get(key) ?? []) if (folder !== inside) active.delete(folder);
    };
    for (const value of lexicalSpellings(specifier)) {
      const path = joinPath('', value);
      // A target escaping its alias base needs the exact inherited resolution to prove a boundary.
      if (path === null) {
        refuseOutside(inside);
        continue;
      }
      for (let key = path; key; key = dirname(key)) block(key);
      if (!prefix) continue;
      const head = prefix === 'directory' && path ? path + '/' : path;
      let start = 0;
      let end = aliasKeys.length;
      while (start < end) {
        const middle = (start + end) >>> 1;
        if (aliasKeys[middle]! < head) start = middle + 1;
        else end = middle;
      }
      for (let i = start; active.size && aliasKeys[i]?.startsWith(head); i++) block(aliasKeys[i]!);
    }
  };
  for (const { inside, value } of aliasTargets) {
    const star = value.indexOf('*');
    const prefix = star < 0 ? value : value.slice(0, star);
    refuseAlias(inside, prefix, star < 0 ? undefined : /[/\\]$/.test(prefix) ? 'directory' : 'partial');
  }
  if (!active.size) return [];

  const mentions = new RegExp(folders.map(dir => dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  let bytes = 0;
  const insideBytes = new Map<string, number>();
  for (const path of sources) {
    if (!active.size) return [];
    const inside = owner(path);
    if (inside && active.size === 1) continue;
    const text = read(path);
    const size = text === undefined ? 0 : Buffer.byteLength(text);
    if (text === undefined || size > IMPORT_GRAPH_LIMITS.fileBytes) {
      refuseOutside(inside);
      continue;
    }
    bytes += size;
    if (inside) insideBytes.set(inside, (insideBytes.get(inside) ?? 0) + size);
    if (bytes > IMPORT_GRAPH_LIMITS.totalBytes)
      for (const folder of active)
        if (bytes - (insideBytes.get(folder) ?? 0) > IMPORT_GRAPH_LIMITS.totalBytes) active.delete(folder);
    if (!active.size) return [];

    if (mentions.test(text))
      for (const folder of active) if (folder !== inside && text.includes(folder)) active.delete(folder);
    if (!active.size) return [];
    const file = api.createSourceFile(path, text, api.ScriptTarget.Latest, false) as ts.SourceFile & {
      parseDiagnostics: readonly ts.Diagnostic[];
    };
    if (file.parseDiagnostics.length) {
      refuseOutside(inside);
      continue;
    }
    const dir = dirname(path);
    for (const reference of file.referencedFiles) target(dir, reference.fileName, inside);
    visitJsSpecifiers(api, file, ({ value, complete }, glob) => {
      const specifier = glob ? value.replace(/^!/, '') : value;
      if (absolute.test(specifier)) refuseOutside(inside);
      else if (relative.test(specifier) || (glob && specifier.startsWith('.'))) {
        const pattern = glob ? specifier.search(/[*?[{]/) : -1;
        const path = pattern < 0 ? specifier.replace(/[?#].*$/, '') : specifier.slice(0, pattern);
        const prefix = (glob && complete && pattern < 0) || /[/\\]$/.test(path) ? 'directory' : 'partial';
        target(dir, path, inside, !complete || glob ? prefix : undefined);
      } else if (bare(specifier)) {
        const prefix = /[/\\]$/.test(specifier) ? 'directory' : 'partial';
        refuseAlias(inside, specifier.replace(/[?#].*$/, ''), complete ? undefined : prefix);
      }
    });
  }
  return [...active];
}
