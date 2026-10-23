import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compiled test modules are cached on disk, shared by every test process of a
// checkout. The file name is a hash of everything the output depends on: this
// file (rewrite rules), the TypeScript version, the compiler options, the
// module's source bytes, how each import resolves, and, recursively, the key of
// every module it compiles. Any source edit therefore yields a new file; an old
// one is never read. Files are written to a temp name and renamed, so readers
// see either nothing or a complete module. TypeScript itself loads only on a miss.
const require = createRequire(import.meta.url);
const selfSource = readFileSync(fileURLToPath(import.meta.url));
const root = new URL('../', import.meta.url);
const tsVersion = JSON.parse(
  readFileSync(new URL('node_modules/typescript/package.json', root), 'utf8'),
).version;
const options = { target: 'ES2022', module: 'ESNext', jsx: 'ReactJSX' };
const fromPattern = /from (['"])([^'"]+)\1/g;
let ts;

function cacheDirectory() {
  return (
    process.env.FORGE_TEST_MODULE_DIRECTORY ||
    join(
      tmpdir(),
      `forge-test-modules-${createHash('sha256').update(fileURLToPath(root)).digest('hex').slice(0, 16)}`,
    )
  );
}

// Same decisions the rewrite makes, without compiling. `nested` is a TypeScript
// source that must itself be compiled; otherwise `href` is the final specifier.
function resolveSpecifier(name, file) {
  let resolved = name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name);
  if (resolved.includes('/src/') && !resolved.includes('/web/src/')) {
    resolved = resolved.replace('/src/', '/dist/');
    if (!resolved.endsWith('.js')) resolved += '.js';
  } else if (name.startsWith('.') && !resolved.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx'])
      if (existsSync(new URL(resolved + ext))) return { nested: new URL(resolved + ext) };
    resolved += '.js';
  }
  return { href: resolved };
}

function moduleKey(file, keys, active) {
  if (keys.has(file.href)) return keys.get(file.href);
  if (active.has(file.href)) return file.href;
  active.add(file.href);
  const source = readFileSync(file);
  const hash = createHash('sha256').update(selfSource).update(tsVersion).update(JSON.stringify(options));
  hash.update(file.href).update(source);
  for (const [, , name] of source.toString('utf8').matchAll(fromPattern)) {
    const { href, nested } = resolveSpecifier(name, file);
    hash.update(`\0${name}\0${nested ? moduleKey(nested, keys, active) : href}`);
  }
  active.delete(file.href);
  const key = hash.digest('hex');
  keys.set(file.href, key);
  return key;
}

function compile(file, directory, keys) {
  ts ??= require('typescript');
  return ts
    .transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    .outputText.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm, '')
    .replace(fromPattern, (_, quote, name) => {
      const { href, nested } = resolveSpecifier(name, file);
      return `from ${quote}${nested ? build(nested, directory, keys) : href}${quote}`;
    });
}

function build(file, directory, keys) {
  const output = directory && join(directory, `${moduleKey(file, keys, new Set())}.mjs`);
  if (output && existsSync(output)) return pathToFileURL(output).href;
  if (process.env.FORGE_TEST_PRECOMPILED === '1')
    throw new Error(`Precompiled test module is missing: ${file.pathname}`);
  const code = compile(file, directory, keys);
  if (!output) return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const temp = `${output}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, code);
    renameSync(temp, output);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return pathToFileURL(output).href;
}

// Compiled text of one module, for tests that patch its imports before loading it.
export function moduleSource(path) {
  const file = path instanceof URL ? path : new URL(path, import.meta.url);
  const directory = cacheDirectory();
  mkdirSync(directory, { recursive: true });
  return compile(file, directory, new Map());
}

export function moduleUrl(path) {
  const file = path instanceof URL ? path : new URL(path, import.meta.url);
  let directory = cacheDirectory();
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // An unwritable cache must not break a test: fall back to in-memory modules.
    if (process.env.FORGE_TEST_PRECOMPILED === '1')
      throw new Error(`Precompiled test module directory is unusable: ${directory}`);
    directory = null;
  }
  return build(file, directory, new Map());
}
