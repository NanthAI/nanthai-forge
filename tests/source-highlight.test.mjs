// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const compiled = Buffer.from(moduleUrl('../web/src/source-highlight.ts').split(',')[1], 'base64')
  .toString()
  .replace(/import\('(.*?)'\)/g, (_, name) => `import('${import.meta.resolve(name)}')`);
const { highlightSource } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
test('five language highlighters preserve exact source text including escaped markup and blank lines', async () => {
  for (const [file, source] of [
    ['a.ts', 'export const s: string = "<img src=x>";\n\n'],
    ['a.js', 'const value = 42;\n'],
    ['a.py', 'def hello():\n    return "world"\n'],
    ['A.java', 'public class A { int n = 1; }\n'],
    ['a.rs', 'fn main() { let n = 1; }\n'],
  ]) {
    const lines = await highlightSource(file, source);
    assert.equal(lines.map(tokens => tokens.map(token => token.text).join('')).join('\n'), source, file);
    assert.ok(
      lines.flat().some(token => token.className),
      file,
    );
  }
  const unknown = 'x <script>alert(1)</script>\n';
  assert.equal(
    (await highlightSource('README.txt', unknown)).flat().every(token => token.className === ''),
    true,
  );
});

test('syntax uses only the seven scoped Fable token roles and huge files retain plain source', async () => {
  const tokens = (
    await highlightSource('file.ts', '// comment\nexport const value: string = "word"; const n = 42;')
  ).flat();
  assert.ok(tokens.every(token => ['', 'k', 's', 'n', 'c', 't', 'f', 'p'].includes(token.className)));
  assert.ok(tokens.some(token => token.className === 'k'));
  assert.ok(tokens.some(token => token.className === 'c'));
  const huge = 'export const value = 42;\n'.repeat(45000);
  const plain = await highlightSource('file.ts', huge);
  assert.ok(plain.flat().every(token => !token.className));
  assert.equal(plain.map(line => line.map(token => token.text).join('')).join('\n'), huge);
});
