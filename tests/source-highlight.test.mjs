// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The code reader's and the diffs' syntax colours (Item 8e847a17): Pierre's highlighter in the worker. Every language the
// Item names is coloured by its file name, the colours use only the design system's roles, and the text is never changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { highlightSource, roleOf, plainLines } = await import(moduleUrl('../web/src/source-highlight.ts'));
const text = lines => lines.map(tokens => tokens.map(token => token.text).join('')).join('\n');
const ROLES = ['', 'kw', 'str', 'nu', 'fn', 'ty', 'cm'];

const SAMPLES = [
  ['a.ts', 'export const s: string = "<img src=x>";\n\n'],
  ['a.tsx', 'const a = <div className="x">{1}</div>;\n'],
  ['a.js', 'const value = 42;\n'],
  ['a.jsx', 'const a = <b>hi</b>;\n'],
  ['a.json', '{"a": [1, true, "x"]}\n'],
  ['tsconfig.jsonc', '{\n  // note\n  "a": 1\n}\n'],
  ['a.md', '# Title\n\n```ts\nconst a = 1;\n```\n'],
  ['a.yaml', 'name: forge\nitems:\n  - 1\n'],
  ['a.toml', '[package]\nname = "forge"\n'],
  ['a.html', '<p class="x">hi</p>\n'],
  ['a.css', 'a { color: red; }\n'],
  ['a.scss', '$a: 1; a { b { color: red; } }\n'],
  ['a.sh', 'if [ -f a ]; then echo "hi"; fi\n'],
  ['a.py', 'def hello():\n    return "world"\n'],
  ['a.go', 'package main\nfunc main() { var n int = 1 }\n'],
  ['a.rs', 'fn main() { let n = 1; }\n'],
  ['A.java', 'public class A { int n = 1; }\n'],
  ['a.kt', 'fun main() { val n = 1 }\n'],
  ['a.swift', 'func main() { let n = 1 }\n'],
  ['a.c', 'int main(void) { return 0; }\n'],
  ['a.cpp', 'int main() { return 0; }\n'],
  ['a.cs', 'class A { int n = 1; }\n'],
  ['a.rb', 'def hello\n  "world"\nend\n'],
  ['a.php', '<?php echo "hi"; ?>\n'],
  ['a.sql', 'SELECT a FROM b WHERE c = 1;\n'],
  ['Dockerfile', 'FROM node:24\nRUN echo hi\n'],
];

test('every language the Item names is coloured by file name, and the text comes back exactly', async () => {
  for (const [file, source] of SAMPLES) {
    const lines = await highlightSource(file, source);
    assert.equal(text(lines), source.replace(/\n$/, '') + (source.endsWith('\n') ? '\n' : ''), file);
    assert.ok(
      lines.flat().some(token => token.className),
      `${file} has colour`,
    );
    assert.ok(
      lines.flat().every(token => ROLES.includes(token.className)),
      `${file} uses only design-system roles`,
    );
  }
});

test('JSON keys, strings, numbers and booleans each get a colour (the owner’s screenshot: JSON had none)', async () => {
  const tokens = (await highlightSource('a.json', '{"a": [1, true, "x"]}')).flat();
  const role = word => tokens.find(token => token.text.includes(word))?.className;
  assert.equal(role('"a"'), 'ty');
  assert.equal(role('"x"'), 'str');
  assert.equal(role('1'), 'nu');
  assert.equal(role('true'), 'nu');
});

test('an unknown file name, a text file and markup in plain text stay plain and unchanged', async () => {
  const unknown = 'x <script>alert(1)</script>\n';
  for (const file of ['README.txt', 'data.lock', 'LICENSE', 'noextension'])
    assert.equal(
      (await highlightSource(file, unknown)).flat().every(token => token.className === ''),
      true,
      file,
    );
  assert.equal(text(await highlightSource('a.html', unknown)), unknown);
});

test('Pierre token kinds map to the design system roles and anything else keeps the text colour', () => {
  const expected = {
    comment: 'cm',
    'comment-doc': 'cm',
    string: 'str',
    'string-escape': 'str',
    number: 'nu',
    boolean: 'nu',
    'constant-builtin': 'nu',
    keyword: 'kw',
    'keyword-import': 'kw',
    tag: 'kw',
    function: 'fn',
    'type-builtin': 'ty',
    'property-json-key': 'ty',
    variable: '',
    punctuation: '',
    operator: '',
    '': '',
  };
  for (const [kind, role] of Object.entries(expected)) assert.equal(roleOf(kind), role, kind);
});

test('a file over the cutoff keeps its plain text, one line per source line', async () => {
  const huge = 'export const value = 42;\n'.repeat(45000);
  const plain = await highlightSource('file.ts', huge);
  assert.ok(plain.flat().every(token => !token.className));
  assert.equal(text(plain), huge.replace(/\n$/, '\n'));
  assert.deepEqual(plainLines('a\nb'), [[{ text: 'a', className: '' }], [{ text: 'b', className: '' }]]);
});

test('a fenced code block names its language, not a file: an extension that is a language name colours too', async () => {
  const lines = await highlightSource('fence.typescript', 'const a: number = 1;');
  assert.ok(lines.flat().some(token => token.className));
});
