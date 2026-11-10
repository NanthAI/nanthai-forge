// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// The CLI entry as one tree-shaken bundle in dist/ (Issue 7b2ae8d8). Loading about 700 small modules
// (and zod's 64 locale files) cost 0.5-1 s of CPU before the first network call; the bundle loads about
// 150 chunks and the same code. The tsc output stays: tests, hooks and workers use it, and every
// module that finds a sibling file by `import.meta` keeps its own dist/ location here.
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const BUNDLED = /^(zod|ignore|convex|@noble\/|@lezer\/)/;
const external = Object.keys(manifest.dependencies).filter(name => !BUNDLED.test(name));
const sibling = id => {
  const path = resolve(id.split('?')[0]);
  const local = relative(root, path);
  if (local.startsWith('..') || local.split(sep).includes('node_modules')) return null;
  const [top] = local.split(sep);
  if (top === 'src') return `./${basename(local).replace(/\.ts$/, '.js')}`;
  if (top === 'scripts') return `../${local.split(sep).join('/')}`;
  return null;
};
/** A bundled module keeps the `import.meta` location of its tsc output (dist/NAME.js) or its script, so
 * workers it spawns by path, files it reads next to itself and its own-module checks are unchanged. */
const originalLocation = {
  name: 'forge-original-location',
  enforce: 'pre',
  transform(code, id) {
    if (!/import\.meta\.(?:url|dirname|filename)/.test(code)) return null;
    const rel = sibling(id);
    if (!rel) return null;
    const head =
      `import { fileURLToPath as __forgeToPath } from 'node:url';\nimport { dirname as __forgeDirname } from 'node:path';\n` +
      `const __forgeUrl = new URL(${JSON.stringify(rel)}, import.meta.url).href;\n` +
      `const __forgeFile = __forgeToPath(__forgeUrl);\nconst __forgeDir = __forgeDirname(__forgeFile);\n`;
    return {
      code:
        head +
        code
          .replace(/^#!.*\n/, '\n')
          .replaceAll('import.meta.url', '__forgeUrl')
          .replaceAll('import.meta.dirname', '__forgeDir')
          .replaceAll('import.meta.filename', '__forgeFile'),
      map: null,
    };
  },
};
for (const name of readdirSync(dist))
  if (name.startsWith('cli-bundle-') && name.endsWith('.js')) rmSync(join(dist, name));
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'error',
  plugins: [originalLocation],
  build: {
    ssr: join(root, 'src', 'cli-entry.ts'),
    outDir: dist,
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      external: id => external.some(name => id === name || id.startsWith(`${name}/`)),
      output: { entryFileNames: 'cli-entry.js', chunkFileNames: 'cli-bundle-[name]-[hash].js' },
    },
  },
  ssr: { noExternal: true },
});
