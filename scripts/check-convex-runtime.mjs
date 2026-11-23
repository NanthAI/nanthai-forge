// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Convex bundles every module without "use node" for its V8 runtime, where node: builtins do not resolve.
// A deploy fails when such a module reaches one through src/, so reproduce the bundle step here: the same
// esbuild resolution and TypeScript import elision, with builtins left external so they show up in the metafile.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { checkConvexBundles } from './check-convex-bundle.mjs';

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const usesNode = source => {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === 'use node') return true;
  }
  return false;
};
const isBuiltin = path => path.startsWith('node:') || builtins.has(path.split('/')[0]);
const nodeGlobal = /\b(Buffer)\.\w+\(|\b(__dirname|__filename)\b|\b(setImmediate)\(/;
/** First Node-only global a source uses outside comments, or null. */
export function nodeGlobalUse(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const match = nodeGlobal.exec(code);
  return match ? match.slice(1).find(Boolean) : null;
}

// Local preflight (Forge) hands this guard the saved changed paths and a folder to keep a cache in
// (FORGE_PREFLIGHT_CHANGED_FILE, FORGE_PREFLIGHT_CACHE_DIR: src/agent-preflight-static.ts). A full pass
// records every first-party module the Convex graphs reach and a digest of their contents. The next run
// exits early only when no changed path can touch the graph (it is outside convex/**, package and
// tsconfig files, this guard, every reached module and any file that could shadow one) AND the graph's
// own files still hash to the recorded digest, so a base that moved on cannot hide a new edge.
// Anything missing, unreadable or different runs the full pass and refreshes the record. The hosted
// check and a direct run set neither variable and always run in full.
const CACHE_VERSION = 1;
const CACHE_FILE = 'convex-reached.json';
const sha = data => createHash('sha256').update(data).digest('hex');
const stem = path => path.replace(/\.[^./]+$/, '');
const moduleNames = path => {
  const name = stem(path);
  return name.endsWith('/index') ? [name, name.slice(0, -'/index'.length)] : [name];
};
const alwaysWatched = path =>
  path.startsWith('convex/') ||
  /^(?:package(?:-lock)?|tsconfig[^/]*)\.json$/.test(path) ||
  path === 'scripts/check-convex-runtime.mjs' ||
  path === 'scripts/check-convex-bundle.mjs';

/** Whether any changed path is in, or could change, what the Convex graphs reach. */
export function touchesConvexGraph(changed, reached) {
  const files = new Set(reached);
  const names = new Set(reached.flatMap(moduleNames));
  return changed.some(
    path => alwaysWatched(path) || files.has(path) || moduleNames(path).some(name => names.has(name)),
  );
}

/** Digest of everything the guard reads: the Convex tree, each reached module, the config files, the
 * lockfile, and the sibling names that could shadow a reached module's resolution. */
export function convexGraphDigest(root, reached) {
  const files = new Set(reached.filter(path => !path.startsWith('convex/')));
  const directories = new Set();
  const walk = directory => {
    directories.add(directory);
    for (const item of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else files.add(path);
    }
  };
  walk('convex');
  for (const path of [
    'package.json',
    'package-lock.json',
    'scripts/check-convex-runtime.mjs',
    'scripts/check-convex-bundle.mjs',
    ...readdirSync(root).filter(name => /^tsconfig[^/]*\.json$/.test(name)),
  ])
    files.add(path);
  const names = new Set(reached.flatMap(moduleNames));
  for (const path of reached) directories.add(dirname(path));
  const hash = createHash('sha256');
  const add = (...parts) => {
    for (const part of parts) hash.update(String(part)).update('\0');
  };
  add(CACHE_VERSION, process.version);
  for (const path of [...files].sort()) {
    let content = 'missing';
    try {
      content = sha(readFileSync(join(root, path)));
    } catch {
      /* A reached module that is gone changes the digest. */
    }
    add(path, content);
  }
  for (const directory of [...directories].sort()) {
    let shadows = [];
    try {
      shadows = readdirSync(join(root, directory), { withFileTypes: true })
        .filter(item => {
          const path = directory === '.' ? item.name : join(directory, item.name);
          return item.isDirectory() ? names.has(path) : moduleNames(path).some(name => names.has(name));
        })
        .map(item => item.name)
        .sort();
    } catch {
      /* A missing directory hashes as empty. */
    }
    add(directory, ...shadows);
  }
  return hash.digest('hex');
}

/** The preflight hints, or null (run in full, no cache): all of them must be present and readable. */
export function convexPreflightHints(env, root) {
  const file = env.FORGE_PREFLIGHT_CHANGED_FILE;
  const directory = env.FORGE_PREFLIGHT_CACHE_DIR;
  if (!directory) return null;
  let changed = null;
  try {
    if (file) changed = readFileSync(file, 'utf8').split('\0').filter(Boolean);
  } catch {
    /* Unknown paths: never an early exit. */
  }
  try {
    return { changed, directory, lock: sha(readFileSync(join(root, 'package-lock.json'))) };
  } catch {
    return null;
  }
}

/** True when the recorded full pass still covers this tree. */
export function convexPassStillHolds(hints, root) {
  if (!hints.changed) return false;
  try {
    const record = JSON.parse(readFileSync(join(hints.directory, CACHE_FILE), 'utf8'));
    if (
      record?.version !== CACHE_VERSION ||
      record.lock !== hints.lock ||
      !Array.isArray(record.reached) ||
      !record.reached.every(path => typeof path === 'string') ||
      touchesConvexGraph(hints.changed, record.reached)
    )
      return false;
    return convexGraphDigest(root, record.reached) === record.digest;
  } catch {
    return false;
  }
}

/** Records a passing full pass; a failure to write only means the next run is full too. */
export function recordConvexPass(hints, root, reached) {
  try {
    const sorted = [...new Set(reached)]
      .filter(path => !path.startsWith('..') && !path.includes('node_modules/'))
      .sort();
    mkdirSync(hints.directory, { recursive: true, mode: 0o700 });
    const file = join(hints.directory, CACHE_FILE);
    writeFileSync(
      `${file}.tmp`,
      JSON.stringify({
        version: CACHE_VERSION,
        lock: hints.lock,
        digest: convexGraphDigest(root, sorted),
        reached: sorted,
      }),
    );
    renameSync(`${file}.tmp`, file);
  } catch {
    /* Cache is an optimization only. */
  }
}

/** V8 roots and their shortest chain to an unsupported import, loader or global. */
export async function findRuntimeViolations(root, { onBundle } = {}) {
  const sources = new Map();
  const source = path => {
    if (!sources.has(path))
      sources.set(
        path,
        ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true),
      );
    return sources.get(path);
  };
  const walk = directory =>
    readdirSync(join(root, directory), { withFileTypes: true }).flatMap(item => {
      if (item.name.startsWith('.') || item.name === 'node_modules') return [];
      const path = join(directory, item.name);
      return item.isDirectory() ? walk(path) : path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
    });
  const entries = walk('convex').filter(path => !usesNode(source(path)));
  if (!entries.length) return [];
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    outdir: join(root, '.convex-runtime-check'),
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    packages: 'external',
    external: [...builtins],
  });
  onBundle?.({
    entries: entries.length,
    modules: Object.keys(metafile.inputs).length,
    bytes: Object.values(metafile.outputs).reduce((total, output) => total + output.bytes, 0),
    inputs: Object.keys(metafile.inputs),
  });
  const unsupported = new Map();
  const unsupportedUse = path => {
    if (unsupported.has(path)) return unsupported.get(path);
    const file = source(path);
    let hit = null;
    const visit = node => {
      if (hit) return;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        hit = `dynamic import ${node.arguments[0]?.getText(file) ?? '(missing argument)'}`;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    const used = nodeGlobalUse(file.text);
    if (!hit && used) hit = `global ${used}`;
    unsupported.set(path, hit);
    return hit;
  };
  const imports = new Map(
    Object.entries(metafile.inputs).map(([path, input]) => [
      path,
      input.imports.map(entry => ({ path: entry.path, external: entry.external })),
    ]),
  );
  const violations = [];
  for (const entry of entries) {
    // Breadth-first so the reported chain is the shortest one a reviewer can act on.
    const parent = new Map([[entry, null]]);
    const queue = [entry];
    let hit = null;
    for (let i = 0; i < queue.length && !hit; i++)
      for (const next of imports.get(queue[i]) ?? []) {
        if (next.external && isBuiltin(next.path)) {
          hit = [queue[i], next.path];
          break;
        }
        if (!next.external && !parent.has(next.path)) {
          parent.set(next.path, queue[i]);
          queue.push(next.path);
        }
      }
    // Inspect source ASTs too: computed import() has no metafile edge, and
    // a literal import can deploy yet fail only when V8 executes the branch.
    for (let i = 0; i < queue.length && !hit; i++) {
      const used = unsupportedUse(queue[i]);
      if (used) hit = [queue[i], used];
    }
    if (!hit) continue;
    const chain = [hit[1]];
    for (let file = hit[0]; file; file = parent.get(file)) chain.unshift(file);
    violations.push({ module: entry, chain });
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const hints = convexPreflightHints(process.env, root);
  if (hints && convexPassStillHolds(hints, root)) {
    console.log(
      'Convex V8 guard skipped: no changed path touches the Convex graphs, and their files match the last full pass.',
    );
    process.exit(0);
  }
  let v8;
  const violations = await findRuntimeViolations(root, {
    onBundle: metrics => {
      v8 = metrics;
    },
  });
  for (const { module, chain } of violations)
    console.error(
      `CONVEX_RUNTIME_IMPORT ${module} runs in V8 (no "use node") but reaches ${chain.at(-1)}: ${chain.join(' -> ')}. Use static, portable imports or move the caller behind a "use node" action boundary.`,
    );
  if (violations.length) process.exit(1);
  if (v8)
    console.log(
      `Convex V8 graph: ${v8.entries} entries, ${v8.modules} modules, ${v8.bytes} bundled bytes (unshared entry outputs).`,
    );
  const bundled = await checkConvexBundles(root, { registeredOnly: true });
  console.log(
    `Convex V8 modules use static portable imports; ${bundled.entries} entries and ${bundled.modules} reachable modules (${bundled.bytes} bytes) resolve in isolated bundles.`,
  );
  if (hints) recordConvexPass(hints, root, [...(v8?.inputs ?? []), ...bundled.inputs]);
}
