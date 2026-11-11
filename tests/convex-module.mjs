// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compiled test modules use the supervisor-provided shared cache when selected;
// direct test files own a private cache that is reclaimed on exit. The file name is a hash of everything the output depends on: this
// file (rewrite rules), the TypeScript version, the compiler options, the
// source bytes and import resolutions of every module its source can reach. Any source edit therefore yields a new file; an old
// one is never read. Files are written to a temp name and renamed, so readers
// see either nothing or a complete module. TypeScript itself loads only on a miss.
// Server diagnostics belong to Convex's separate log stream in production.
// Route these in-process server markers away from CLI/result JSON stdout too.
const moduleConsoleLog = console.log;
console.log = (...args) => {
  if (args.length === 1 && typeof args[0] === 'string' && /^FORGE_[A-Z0-9_]+ /.test(args[0]))
    process.stderr.write(args[0] + '\n');
  else moduleConsoleLog(...args);
};

const require = createRequire(import.meta.url);
const selfSource = readFileSync(fileURLToPath(import.meta.url));
const root = new URL('../', import.meta.url);
const tsVersion = JSON.parse(
  readFileSync(new URL('node_modules/typescript/package.json', root), 'utf8'),
).version;
const options = { target: 'ES2022', module: 'ESNext', jsx: 'ReactJSX' };
const fromPattern = /from (['"])([^'"]+)\1/g;
const dynamicPattern = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
let ts;

let privateCache;
function cacheDirectory() {
  if (process.env.FORGE_TEST_MODULE_DIRECTORY) return process.env.FORGE_TEST_MODULE_DIRECTORY;
  privateCache ??= temporaryDirectory(null, 'forge-test-modules-');
  // Measured child processes reuse their parent's prepared modules, and do not own
  // or remove this cache. The preparing test process reclaims it after they finish.
  process.env.FORGE_TEST_MODULE_DIRECTORY = privateCache;
  return privateCache;
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

// One module's own bytes and import resolutions, read once per load.
function moduleFacts(file, keys) {
  const known = keys.facts.get(file.href);
  if (known) return known;
  const source = readFileSync(file);
  const hash = createHash('sha256').update(file.href).update(source);
  const nested = [];
  for (const [, , name] of [
    ...source.toString('utf8').matchAll(fromPattern),
    ...source.toString('utf8').matchAll(dynamicPattern),
  ]) {
    const resolved = resolveSpecifier(name, file);
    hash.update(`\0${name}\0${resolved.nested?.href ?? resolved.href}`);
    if (resolved.nested) nested.push(resolved.nested);
  }
  const facts = { digest: hash.digest('hex'), nested };
  keys.facts.set(file.href, facts);
  return facts;
}

// The key covers the bytes of every module the source can reach. Keys built from imports'
// keys broke on cycles through type-only imports (kept in source, dropped from output): a
// module could be keyed by a value import's href, then load that import's older output.
function moduleKey(file, keys) {
  if (keys.has(file.href)) return keys.get(file.href);
  const reach = new Map();
  for (const stack = [file]; stack.length;) {
    const next = stack.pop();
    if (reach.has(next.href)) continue;
    const facts = moduleFacts(next, keys);
    reach.set(next.href, facts.digest);
    stack.push(...facts.nested);
  }
  const hash = createHash('sha256').update(selfSource).update(tsVersion).update(JSON.stringify(options));
  hash.update(file.href);
  for (const href of [...reach.keys()].sort()) hash.update(`\0${href}\0${reach.get(href)}`);
  const key = hash.digest('hex');
  keys.set(file.href, key);
  return key;
}

const moduleKeys = () => Object.assign(new Map(), { facts: new Map(), outputs: new Map() });

function compile(file, directory, keys) {
  ts ??= require('typescript');
  return ts
    .transpileModule(readFileSync(file, 'utf8'), {
      fileName: file.pathname,
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
    })
    .replace(dynamicPattern, (_, quote, name) => {
      const { href, nested } = resolveSpecifier(name, file);
      return `import(${quote}${nested ? build(nested, directory, keys) : href}${quote})`;
    });
}

function build(file, directory, keys) {
  // Literal lazy imports can close value-import cycles (UI route -> page ->
  // route). Reserve the content-addressed URL before compiling dependencies;
  // each member is published once before the caller imports the root.
  if (keys.outputs.has(file.href)) return keys.outputs.get(file.href);
  const output = directory && join(directory, `${moduleKey(file, keys)}.mjs`);
  if (output && existsSync(output)) return pathToFileURL(output).href;
  if (process.env.FORGE_TEST_PRECOMPILED === '1')
    throw new Error(`Precompiled test module is missing: ${file.pathname}`);
  if (output) keys.outputs.set(file.href, pathToFileURL(output).href);
  const code = compile(file, directory, keys);
  if (!output) return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const temp = `${output}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, code);
    renameSync(temp, output);
  } catch (error) {
    let published = false;
    if (['EEXIST', 'EPERM', 'EACCES'].includes(error.code))
      try {
        // Windows cannot replace a module another process published or opened. Trust only exact bytes.
        published = readFileSync(output).equals(Buffer.from(code));
      } catch {
        // A missing or unreadable destination does not reconcile the failed write.
      }
    rmSync(temp, { force: true });
    if (!published) throw error;
  }
  return pathToFileURL(output).href;
}

// Compiled text of one module, for tests that patch its imports before loading it.
export function moduleSource(path) {
  const file = path instanceof URL ? path : new URL(path, import.meta.url);
  const directory = cacheDirectory();
  mkdirSync(directory, { recursive: true });
  return compile(file, directory, moduleKeys());
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
  return build(file, directory, moduleKeys());
}
