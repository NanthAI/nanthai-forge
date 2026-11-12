// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import ts from 'typescript';

/** Static bundling resolves literal imports/requires, but createRequire aliases
 * bypass it. Refuse runtime package discovery anywhere in the reachable graph,
 * including lazy branches. The isolated import also catches bundle init errors. */
export async function checkConvexBundles(root, { registeredOnly = false } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'forge-test-convex-bundle-'));
  try {
    const walk = directory =>
      readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.name.startsWith('.') || entry.name === '_generated') return [];
        const path = join(directory, entry.name);
        return entry.isDirectory()
          ? walk(path)
          : path.endsWith('.ts') && !path.endsWith('.d.ts')
            ? [path]
            : [];
      });
    const entries = walk(join(root, 'convex'));
    if (!entries.length) return { modules: 0, entries: 0 };
    const options = {
      absWorkingDir: root,
      entryPoints: entries,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'esnext',
      conditions: ['convex', 'module'],
      splitting: true,
      outdir: out,
      outExtension: { '.js': '.mjs' },
      metafile: true,
      logLevel: 'silent',
    };
    let result = await build(options);
    let selectedEntries = entries;
    if (registeredOnly) {
      const discovered = isolatedImports(root, out, result, entries);
      const roots = [];
      for (const [index, item] of discovered.entries()) {
        if (!item.names.length) continue;
        const path = join(out, `root-${index}.mjs`);
        writeFileSync(
          path,
          `export { ${item.names.join(',')} } from ${JSON.stringify(resolve(root, item.source))};`,
        );
        roots.push(path);
      }
      if (!roots.length) throw new Error('CONVEX_BUNDLE_NO_FUNCTIONS');
      result = await build({ ...options, entryPoints: roots, outdir: join(out, 'functions') });
      selectedEntries = roots;
    }
    // esbuild resolves every static dependency (including dependencies of packages).
    // Check first-party sources for loader aliases that bypass that resolution.
    // Vendor bundles may probe optional native accelerators under their own catches;
    // isolated imports below still require their mandatory dependencies to resolve.
    for (const path of Object.keys(result.metafile.inputs)) {
      if (path.includes('node_modules/') || path.startsWith('../') || path.startsWith(out)) continue;
      const code = readFileSync(resolve(root, path), 'utf8');
      const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
      const visit = node => {
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          const argument = node.arguments[0];
          if (!argument || !ts.isStringLiteral(argument))
            throw new Error(`CONVEX_BUNDLE_DYNAMIC_IMPORT ${path}: dependencies must resolve at build time.`);
        }
        if (
          (ts.isImportSpecifier(node) &&
            !node.isTypeOnly &&
            (node.propertyName ?? node.name).text === 'createRequire') ||
          (ts.isPropertyAccessExpression(node) && node.name.text === 'createRequire') ||
          (ts.isElementAccessExpression(node) &&
            ts.isStringLiteral(node.argumentExpression) &&
            node.argumentExpression.text === 'createRequire') ||
          (ts.isCallExpression(node) && node.expression.getText(source) === 'import.meta.resolve')
        )
          throw new Error(`CONVEX_BUNDLE_RUNTIME_LOADER ${path}: use a static bundled import.`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (result.warnings.length)
      throw new Error(`CONVEX_BUNDLE_WARNING ${result.warnings.map(w => w.id).join(',')}`);
    isolatedImports(root, out, result, selectedEntries);
    return {
      modules: Object.keys(result.metafile.inputs).length,
      entries: entries.length,
      bytes: Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function isolatedImports(root, out, result, entries) {
  const outputs = Object.entries(result.metafile.outputs).filter(
    ([, value]) => value.entryPoint && (!entries || entries.includes(resolve(root, value.entryPoint))),
  );
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createRequire, isBuiltin } from 'node:module';
    import { fileURLToPath } from 'node:url';
    import { dirname } from 'node:path';
    globalThis.__filename = fileURLToPath(import.meta.url);
    globalThis.__dirname = dirname(globalThis.__filename);
    const builtinRequire = createRequire(import.meta.url);
    // Convex Node supplies require for builtins. Keep package lookup disabled.
    globalThis.require = name => {
      if (!isBuiltin(name)) throw Object.assign(new Error(), { code: 'MODULE_NOT_FOUND' });
      return builtinRequire(name);
    };
    const result = [];
    for (const item of JSON.parse(process.argv[1])) {
      try {
        const module = await import(item.url);
        result.push({ source: item.source, names: Object.keys(module).filter(name => {
          const value = module[name];
          return value && (value.isQuery || value.isMutation || value.isAction || value.isHttp || (name === 'default' && item.source.endsWith('/http.ts')));
        }) });
      } catch (error) {
        console.error(JSON.stringify({ code: error.code ?? 'BUNDLE_INIT_FAILED', module: item.source }));
        process.exit(1);
      }
    }
    console.log(JSON.stringify(result));
  `,
      JSON.stringify(
        outputs.map(([path, value]) => ({
          url: pathToFileURL(resolve(root, path)).href,
          source: value.entryPoint,
        })),
      ),
    ],
    {
      cwd: out,
      encoding: 'utf8',
      env: { NODE_PATH: '', NODE_ENV: 'production' },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (child.status !== 0) throw new Error(`CONVEX_BUNDLE_ISOLATED_IMPORT ${child.stderr.trim()}`);
  return JSON.parse(child.stdout);
}
