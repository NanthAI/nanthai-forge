// SPDX-License-Identifier: Apache-2.0
// Forge's own code sets no cookies, so no cookie banner is needed (a9f4654f). Sign-in keeps its state in browser
// storage, and usage stats stay cookie-free. A new cookie must be classified as essential and listed here first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Essential cookies Forge's own code may set, as "path: reason". Empty today.
const essential = new Map();
const scanned = [
  'web/src',
  'web/index.html',
  'web/app.html',
  'web/docs.html',
  'site',
  'scripts/docs-site.tsx',
];
const sets =
  /document\.cookie\s*=|cookieStore\s*\.\s*set|['"`]set-cookie['"`]|\.cookies\s*\.\s*set\(|setCookie\(/i;

function* files(path) {
  if (statSync(path).isFile()) return yield path;
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || /\.test\./.test(name)) continue;
    yield* files(join(path, name));
  }
}

test('web, docs and the site Worker set no cookie that is not listed as essential', () => {
  const found = [];
  for (const start of scanned)
    for (const file of files(join(root, start))) {
      if (!/\.(?:[cm]?[jt]sx?|html)$/.test(file)) continue;
      const path = relative(root, file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (sets.test(line) && !essential.has(path)) found.push(`${path}:${index + 1}`);
        });
    }
  assert.deepEqual(found, [], 'classify a new cookie as essential (with its reason) or remove it');
});

test('the guard recognises the ways a cookie is set', () => {
  for (const line of [
    'document.cookie = "a=1"',
    'await cookieStore.set("a", "1")',
    "headers.append('Set-Cookie', value)",
    'context.cookies.set("a", "1")',
    'setCookie(res, "a", "1")',
  ])
    assert.match(line, sets, line);
  assert.doesNotMatch('const cookies = await context.cookies();', sets);
});
