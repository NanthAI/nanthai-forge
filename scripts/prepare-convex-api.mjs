// SPDX-License-Identifier: Apache-2.0
// The aggregate is disposable: parallel Lanes change modules, never this inventory.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function convexApiModules(root, io = { readdirSync }) {
  const directory = join(root, 'convex');
  function walk(path) {
    return io.readdirSync(path, { withFileTypes: true }).flatMap(entry => {
      const file = join(path, entry.name);
      if (entry.isDirectory()) return entry.name === '_generated' ? [] : walk(file);
      if (!entry.isFile() || !/\.(?:ts|js)$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
      const name = relative(directory, file)
        .replaceAll('\\', '/')
        .replace(/\.(?:ts|js)$/, '');
      return ['schema', 'auth.config'].includes(name) ? [] : [name];
    });
  }
  return walk(directory).sort();
}

export function renderConvexApi(modules) {
  return `/* eslint-disable */
// Generated locally by scripts/prepare-convex-api.mjs or Convex codegen. Do not commit.
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
${modules.map((name, index) => `import type * as module${index} from ${JSON.stringify(`../${name}.js`)};`).join('\n')}
declare const fullApi: ApiFromModules<{
${modules.map((name, index) => `  ${JSON.stringify(name)}: typeof module${index};`).join('\n')}
}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
export declare const components: {};
`;
}

export function prepareConvexApi(root) {
  const modules = convexApiModules(root);
  const source = renderConvexApi(modules);
  const path = join(root, 'convex/_generated/api.d.ts');
  let previous;
  try {
    previous = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (source !== previous) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, source, { flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return { modules: modules.length, bytes: Buffer.byteLength(source), written: source !== previous };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareConvexApi(fileURLToPath(new URL('../', import.meta.url)));
