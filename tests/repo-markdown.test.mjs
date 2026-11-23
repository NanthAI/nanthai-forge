// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A Markdown file in the Code reader (Item 8e847a17) is drawn by the safe renderer: no raw HTML or script runs, only
// http(s), mailto and files of the same State can be linked, only files of the same State are asked for as images, and
// a fenced block is handed to the colourer with its language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { SafeMarkdown } = await import(moduleUrl('../web/src/ds/markdown.tsx'));

const seen = { links: [], images: [], fences: [] };
const repo = {
  link: (href, children) => {
    seen.links.push(href);
    return createElement('a', { href: `/files/${href}`, 'data-repo': '1' }, children);
  },
  image: (src, alt) => {
    seen.images.push(src);
    return createElement('span', { 'data-image': src }, alt);
  },
  code: (text, lang) => {
    seen.fences.push([lang, text]);
    return createElement('span', { 'data-fence': lang ?? '' }, text);
  },
};
const html = text => renderToStaticMarkup(createElement(SafeMarkdown, { text, repo }));

test('raw HTML and script links in a README are dropped, not run', () => {
  const out = html(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n',
  );
  assert.doesNotMatch(out, /<script|onerror|javascript:|<img/);
});

test('a relative link or image goes to the repository reader; an outside or protocol-relative one never does', () => {
  seen.links.length = seen.images.length = 0;
  const out = html(
    '[guide](docs/guide.md) [site](https://example.com/a) [mail](mailto:a@b.c)\n\n' +
      '![logo](assets/logo.png) ![out](https://evil.example/x.png) ![proto](//evil.example/x.png)\n',
  );
  assert.deepEqual(seen.links, ['docs/guide.md']);
  assert.deepEqual(seen.images, ['assets/logo.png']);
  assert.match(out, /data-repo="1"/);
  assert.match(out, /href="https:\/\/example.com\/a"[^>]*rel="noreferrer noopener nofollow ugc"/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /Outside images are not loaded/);
});

test('a fenced block reaches the colourer with its language and the text without its closing newline', () => {
  seen.fences.length = 0;
  html('```ts\nconst a = 1;\n```\n\nand `inline` code\n');
  assert.deepEqual(seen.fences, [['ts', 'const a = 1;']]);
});

test('without a repository the same text keeps relative links as plain words', () => {
  const out = renderToStaticMarkup(createElement(SafeMarkdown, { text: '[guide](docs/guide.md)' }));
  assert.doesNotMatch(out, /<a /);
});
