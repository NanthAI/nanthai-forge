// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { reviewTextPage } from '../dist/source-review-format.js';
import { moduleUrl } from './convex-module.mjs';

const { FileHeading } = await import(moduleUrl('../web/src/app/code/FileHeading.tsx'));

const heading = (path, page, more = {}) =>
  renderToStaticMarkup(
    createElement(FileHeading, {
      path,
      isFile: true,
      head: { available: true, path, page, mode: 'file', blob: null },
      lines: 2,
      done: true,
      where: 'at main',
      ...more,
    }),
  );

test('J13 file heading shows exact bytes and language beside the line count', () => {
  const text = '// café\nexport const n = 1;\n';
  const size = Buffer.byteLength(text);
  const complete = heading('src/math.js', reviewTextPage(Buffer.from(text)));
  assert.match(complete, new RegExp(`2 lines, ${size} bytes, JavaScript, at main`));

  const long = Buffer.from(`// café\n${'x'.repeat(16_000)}\n`);
  const partial = heading('src/math.ts', reviewTextPage(long), {
    lines: 2,
    done: false,
    where: 'at State abcdef01',
  });
  assert.ok(
    partial.includes(`2 lines so far, ${long.length.toLocaleString()} bytes, TypeScript, at State abcdef01`),
  );

  const empty = heading('LICENSE', reviewTextPage(Buffer.alloc(0)), { lines: 1 });
  assert.match(empty, /1 line, 0 bytes, Plain text, at main/);

  const binary = heading('assets/image.js', { kind: 'binary', size: 51 }, { lines: null });
  assert.match(binary, /51 bytes, Binary, at main/);
  assert.doesNotMatch(binary, /JavaScript/);
});
