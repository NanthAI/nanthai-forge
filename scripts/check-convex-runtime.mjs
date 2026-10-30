// SPDX-License-Identifier: Apache-2.0
// Convex bundles every module without "use node" for its V8 runtime, where node: builtins do not resolve.
// A deploy fails when such a module reaches one through src/, so reproduce the bundle step here: the same
// esbuild resolution and TypeScript import elision, with builtins left external so they show up in the metafile.
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const nodeDirective = /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*['"]use node['"]/;
const isBuiltin = path => path.startsWith('node:') || builtins.has(path.split('/')[0]);
const nodeGlobal = /\b(Buffer)\.\w+\(|\b(__dirname|__filename)\b|\b(setImmediate)\(/;
/** First Node-only global a source uses outside comments, or null. */
export function nodeGlobalUse(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const match = nodeGlobal.exec(code);
  return match ? match.slice(1).find(Boolean) : null;
}

/** Convex modules that run in V8 and, per module, the shortest import chain to a node: builtin. */
export async function findRuntimeViolations(root) {
  const convex = join(root, 'convex');
  const entries = readdirSync(convex)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map(name => join(convex, name))
    .filter(file => !nodeDirective.test(readFileSync(file, 'utf8')));
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
  const imports = new Map(
    Object.entries(metafile.inputs).map(([path, input]) => [
      path,
      input.imports.map(entry => ({ path: entry.path, external: entry.external })),
    ]),
  );
  const violations = [];
  for (const entry of entries.map(file => relative(root, file))) {
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
    // Node globals (Buffer, __dirname) need no import, so the metafile misses them; V8 throws at call time.
    for (let i = 0; i < queue.length && !hit; i++) {
      const used = nodeGlobalUse(readFileSync(join(root, queue[i]), 'utf8'));
      if (used) hit = [queue[i], `global ${used}`];
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
  const violations = await findRuntimeViolations(root);
  for (const { module, chain } of violations)
    console.error(
      `CONVEX_RUNTIME_IMPORT ${module} runs in V8 (no "use node") but reaches ${chain.at(-1)}: ${chain.join(' -> ')}. Use a portable module (src/portable-hash instead of src/hash) or split the helper out.`,
    );
  if (violations.length) process.exit(1);
  console.log('Convex V8 modules bundle without node: builtins.');
}
