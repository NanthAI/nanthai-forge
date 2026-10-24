// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const previousWindow = globalThis.window;
globalThis.window = { location: { hash: '' } };
const { routeUrl, readRoute } = await import(moduleUrl('../web/src/api.ts'));
const { SourceView } = await import(moduleUrl('../web/src/Content.tsx'));
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;

test('ordinary file URLs omit line selection while explicit line 1 remains addressable', () => {
  const previousLocation = globalThis.location;
  globalThis.location = new URL('http://localhost/?file=old.ts&line=9');
  try {
    const route = { file: 'AGENTS.md', view: 'source', state: 'saved', line: 1 };
    const plain = new URL(routeUrl(route, false));
    assert.equal(plain.searchParams.has('line'), false);
    globalThis.location = plain;
    assert.equal(readRoute().line, 1, 'reading still starts at line 1 without selecting it');
    assert.equal(new URL(routeUrl(route)).searchParams.get('line'), '1');
    globalThis.location = new URL('http://localhost/?file=AGENTS.md#L3');
    assert.equal(readRoute().line, 3, 'retained #L anchors keep their exact target');
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test('source renderer highlights only an explicitly selected line, including line 1', () => {
  const source = {
    file: 'script.ts',
    digest: 'synthetic',
    text: '// SPDX-License-Identifier: Apache-2.0\n// A comment\nexport const value = 1;',
    startLine: 1,
    endLine: 3,
    totalLines: 3,
  };
  const render = selectedLine =>
    renderToStaticMarkup(createElement(SourceView, { source, selectedLine, navigate() {} }));
  assert.doesNotMatch(render(undefined), /active-line/);
  for (const line of [1, 3]) {
    const html = render(line);
    assert.equal((html.match(/active-line/g) ?? []).length, 1);
    assert.match(html, new RegExp(`id="L${line}" class="code-line active-line`));
  }
  assert.doesNotMatch(render(80), /active-line/);
});
