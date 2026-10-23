// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixture, write } from './helpers.mjs';
import { indexRepository } from '../dist/index.js';
import { RepositoryQuery } from '../dist/query.js';
import { moduleUrl } from './convex-module.mjs';
const { ReferenceMap } = await import(moduleUrl('../web/src/Map.tsx'));

test('reference lens renders real bounded compiler locations, original source digests and empty/invalid provenance without implying runtime independence', async t => {
  const files = { 'target.ts': 'export const target = 1;\nexport const unused = true;\n' };
  for (let i = 0; i < 12; i++)
    files[`consumer${i}.ts`] =
      'import { target as alias } from "./target";\nexport const values = [alias, alias, alias, alias, alias];\n';
  files['0literal<img>.ts'] = 'import { target } from "./target";\nexport const value = target;\n';
  const root = fixture(t, files);
  await indexRepository(root);
  const query = () => new RepositoryQuery(root);
  const status = query().status(),
    declarations = query().declarations('target.ts');
  const symbol = declarations.results.find(node => node.name === 'target');
  const refs = query().references(symbol.id, 50);
  assert.equal(refs.results.length, 50);
  assert(refs.total > 50);
  assert.equal(refs.truncated, true);
  for (const edge of refs.results) {
    assert.equal(edge.target, symbol.id);
    const text = files[edge.locator.file];
    assert.equal(edge.locator.digest, createHash('sha256').update(text).digest('hex'));
    assert.match(text.slice(edge.locator.start.offset, edge.locator.end.offset), /^(alias|target)$/);
  }
  const render = (references, selected = symbol) =>
    renderToStaticMarkup(
      createElement(ReferenceMap, {
        symbol: selected,
        references,
        sourceId: status.sourceId,
        analysisId: status.analysisId,
        source: () => {},
      }),
    );
  const html = render(refs);
  assert.match(html, /Identifier reference map/);
  assert.match(html, /50 of \d+ recorded references · partial coverage/);
  assert.match(html, /aria-label="Inspect consumer/);
  assert.match(html, /not a complete call graph or impact analysis/);
  assert.match(html, new RegExp(status.analysisId));
  assert.match(html, /literal&lt;img&gt;.ts/);
  assert.ok(!/<img\b/.test(html));
  for (const patch of [
    { sourceId: 'other' },
    { analysisId: 'other' },
    { freshness: 'stale' },
    { results: [{ ...refs.results[0], target: 'other' }] },
  ]) {
    const invalid = render({ ...refs, ...patch });
    assert.match(invalid, /fx-error-placeholder/);
    assert.doesNotMatch(invalid, /role="alert"|Reference data does not match/);
    assert.ok(!invalid.includes('consumer'));
  }
  const unused = declarations.results.find(node => node.name === 'unused'),
    empty = query().references(unused.id);
  assert.equal(empty.total, 0);
  assert.match(render(empty, unused), /Runtime effects remain unknown/);
  write(root, 'target.ts', 'export const target = 2;\n');
  assert.throws(() => query().references(symbol.id), { code: 'SOURCE_STALE' });
});
