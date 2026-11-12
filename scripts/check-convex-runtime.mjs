// SPDX-License-Identifier: Apache-2.0
// Convex bundles every module without "use node" for its V8 runtime, where node: builtins do not resolve.
// A deploy fails when such a module reaches one through src/, so reproduce the bundle step here: the same
// esbuild resolution and TypeScript import elision, with builtins left external so they show up in the metafile.
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
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
}
