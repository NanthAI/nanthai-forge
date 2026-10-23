// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, write } from './helpers.mjs';
import { indexRepository } from '../dist/index.js';
import { RepositoryQuery } from '../dist/query.js';
import { moduleUrl } from './convex-module.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const { DocumentMarkdown } = await import(moduleUrl('../web/src/Content.tsx'));
const previousWindow = globalThis.window;
globalThis.window = { location: { hash: '' } };
const { Home } = await import(moduleUrl('../web/src/Home.tsx'));
const { ImportMap } = await import(moduleUrl('../web/src/Map.tsx'));
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;

test('actual Markdown renderer preserves text while refusing raw script/MDX/CSS, executable links and image loads', () => {
  const text = [
    '# Normal heading',
    '<script>document.body.dataset.executed=1</script>',
    '<style>body { display:none }</style>',
    '<iframe src="https://outside.invalid"/>',
    '{(() => window.execute())()}',
    '<Widget onClick={dangerous}/>',
    '![Secret image](https://outside.invalid/secret)',
    '[Run](javascript:dangerous)',
    '[Official source](https://github.com/thevarsek/nanthai-forge)',
  ].join('\n\n');
  const html = renderToStaticMarkup(createElement(DocumentMarkdown, { text }));
  assert.match(html, /Normal heading/);
  assert.match(html, /external images are not loaded/);
  assert.ok(!/<(?:script|style|iframe|img|Widget)\b/i.test(html));
  assert.ok(!/href="javascript:/i.test(html));
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /https:\/\/github.com\/thevarsek\/nanthai-forge/);
});

test('safe Home work components preserve hosted boundaries, strict JSON properties and literal original blocks', () => {
  const status = {
    files: 2,
    symbols: 3,
    imports: 1,
    sourceId: 'original-source',
    analysisId: 'original-analysis',
    analysis: { coverage: 'partial', limitations: ['Unknown dynamic relationships'] },
  };
  const blocks = [
    '{"component":"work"}',
    '{"component":"evidence"}',
    '{"component":"releases"}',
    '{"component":"work","command":"run-check"}',
    '{"component":"releases","file":"../private"}',
    '{"component":"evidence","enabled":true}',
    '{"component":"unknown","text":"<script>execute()</script>"}',
    '{"component":"coverage"}',
  ];
  const text = blocks.map(block => '```forge\n' + block + '\n```').join('\n\n');
  const html = renderToStaticMarkup(
    createElement(Home, {
      document: { text, file: '.nforge/home.md', scope: 'git-revision' },
      status,
      request: () => {
        throw new Error('No hosted Work API');
      },
      navigate: () => {},
    }),
  );
  assert.equal((html.match(/Hosted source snapshots do not include local Work records/g) ?? []).length, 3);
  assert.equal((html.match(/Unsupported Forge component/g) ?? []).length, 4);
  assert.match(html, /Analysis coverage/);
  assert.match(html, /original-source/);
  assert.match(html, /&lt;script&gt;execute\(\)&lt;\/script&gt;/);
  assert.ok(!/<script\b|<form\b|Open Work/.test(html));
});

test('reverse Home maps use actual direct importers and locators, preserve query bounds and keep unknown impact explicit', async t => {
  const files = {
    'target.ts': 'export const value = 1;\n',
    'isolated.ts': 'export const isolated = true;\n',
  };
  for (let i = 0; i < 12; i++)
    files[`consumer${i}.ts`] =
      'import { value } from "./target";\nimport external from "outside-package";\nexport const answer = value;\n';
  const root = fixture(t, files);
  await indexRepository(root);
  const query = () => new RepositoryQuery(root);
  const status = query().status(),
    result = query().impact('target.ts', 2);
  assert.equal(result.total, 12);
  assert.equal(result.results.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.sourceId, status.sourceId);
  assert.ok(
    result.results.every(
      edge =>
        edge.target === 'target.ts' && edge.from.startsWith('consumer') && edge.locator.start.line === 1,
    ),
  );
  assert.match(result.meaning, /Direct reverse imports only/);
  const render = (data, direction) =>
    renderToStaticMarkup(
      createElement(ImportMap, { file: 'target.ts', imports: data, direction, select: () => {} }),
    );
  const incoming = render(result, 'importers');
  assert.match(incoming, /Direct importers map/);
  assert.match(incoming, /consumer\d+\.ts:1/);
  assert.match(incoming, /12 recorded edges/);
  assert.match(incoming, /aria-label="Inspect consumer/);
  assert.ok(!incoming.includes('outside-package'));
  const outgoing = query().imports('consumer0.ts');
  assert.match(render(outgoing, 'imports'), /Import map/);
  assert.match(render(outgoing, 'imports'), /aria-label="Inspect target.ts"/);
  const empty = query().impact('isolated.ts');
  assert.match(render(empty, 'importers'), /Runtime effects remain unknown/);
  assert.throws(() => query().impact('../private.ts'));
  write(root, 'target.ts', 'export const value = 2;\n');
  assert.throws(() => query().impact('target.ts'), { code: 'SOURCE_STALE' });
});

test('document links resolve within the selected source and GFM tables/headings keep safe semantic markup', async () => {
  const { documentTarget } = await import('../dist/document-paths.js');
  assert.deepEqual(documentTarget('../README.md#start', 'docs/guide.md'), {
    file: 'README.md',
    anchor: 'start',
    source: false,
    line: 1,
  });
  assert.equal(documentTarget('/docs/guide.md#details', 'README.md').file, 'docs/guide.md');
  assert.equal(documentTarget('#details', 'docs/guide.md').file, 'docs/guide.md');
  assert.equal(documentTarget('../src/a.ts#L22-L25', 'docs/guide.md').line, 22);
  for (const path of [
    '../../outside.md',
    '%2e%2e/outside.md',
    '//outside.invalid/x.md',
    'https://outside.invalid/x.md',
    'javascript:evil.md',
    'a%5cb.md',
    'secret.txt',
    'bad%ZZ.md',
  ])
    assert.equal(documentTarget(path, 'README.md'), null, path);
  const text =
    '# Guide\n\n## Details\n\n## Details\n\n| Action | Result |\n| --- | --- |\n| **Read** | Works |\n\n[Next](../README.md#start)\n\n[Remote](https://example.com/original?a=1#here)\n\n<script>bad()</script>\n\n![No network](https://outside.invalid/image.png)';
  const navigation = {
    href: target => '/?state=PIN&document=' + encodeURIComponent(target.file) + '&anchor=' + target.anchor,
    open: () => {},
  };
  const html = renderToStaticMarkup(
    createElement(DocumentMarkdown, { text, file: 'docs/guide.md', navigation }),
  );
  assert.match(html, /<table>/);
  assert.match(html, /<thead>/);
  assert.match(html, /<th>Action<\/th>/);
  assert.match(html, /<td><strong>Read<\/strong><\/td>/);
  assert.match(html, /<h2 id="forge-document-guide" tabindex="-1">/);
  assert.match(html, /id="forge-document-details-1"/);
  assert.match(html, /href="\/\?state=PIN&amp;document=README.md&amp;anchor=start"/);
  assert.match(html, /href="https:\/\/example.com\/original\?a=1#here"/);
  assert.ok(!/<script|<img/.test(html));
});
