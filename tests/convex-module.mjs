import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const ts = process.env.FORGE_TEST_PRECOMPILED === '1' ? null : (await import('typescript')).default;

export function moduleUrl(path) {
  const file = path instanceof URL ? path : new URL(path, import.meta.url);
  // Memory workers reuse a precompiled module graph instead of recursively
  // embedding every shared dependency in data URLs. Build cost is measured in
  // the producer process; the worker imports the exact same emitted handlers.
  const directory = process.env.FORGE_TEST_MODULE_DIRECTORY;
  const output = directory && join(directory, `${createHash('sha256').update(file.href).digest('hex')}.mjs`);
  if (output && existsSync(output)) return pathToFileURL(output).href;
  if (!ts) throw new Error(`Precompiled test module is missing: ${file.pathname}`);
  if (output) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(output, '');
  }
  const code = ts
    .transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    .outputText.replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm, '')
    .replace(/from (['"])([^'"]+)\1/g, (_, quote, name) => {
      let resolved = name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name);
      if (resolved.includes('/src/') && !resolved.includes('/web/src/')) {
        resolved = resolved.replace('/src/', '/dist/');
        if (!resolved.endsWith('.js')) resolved += '.js';
      } else if (
        name.startsWith('.') &&
        !resolved.endsWith('.js') &&
        ['.ts', '.tsx'].some(ext => existsSync(new URL(resolved + ext)))
      )
        resolved = moduleUrl(new URL(resolved + (existsSync(new URL(`${resolved}.ts`)) ? '.ts' : '.tsx')));
      else if (name.startsWith('.') && !resolved.endsWith('.js')) resolved += '.js';
      return `from ${quote}${resolved}${quote}`;
    });
  if (output) {
    writeFileSync(output, code);
    return pathToFileURL(output).href;
  }
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}
