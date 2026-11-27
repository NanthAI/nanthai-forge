// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

const ds = pathToFileURL(realpathSync(fileURLToPath(moduleUrl('../web/src/ds/index.ts')))).href;
const handoff = moduleUrl('../web/src/app/plan/HandoffSheet.tsx');
const bulk = moduleUrl('../web/src/app/plan/Bulk.tsx');
// Render the real sheet content on Node. The hosted browser suite exercises the modal overlay.
const hook = registerHooks({
  load(url, context, next) {
    if (url !== ds) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `export * from ${JSON.stringify(ds + '?with-overlay')};
        import { createElement } from ${JSON.stringify(import.meta.resolve('react'))};
        export function Sheet({ open, children, footer }) {
          return open ? createElement('section', null, children, footer) : null;
        }`,
    };
  },
});
const [{ HandoffSheet }, { CloseSheet }, { itemBody }] = await Promise.all([
  import(handoff),
  import(bulk),
  import(moduleUrl('../web/src/app/plan/item-body.ts')),
]).finally(() => hook.deregister());

const row = {
  id: '00000000-0000-4000-8000-000000000010',
  title: 'Preserve split bytes',
  version: 2,
  doneWhen: [1, 3],
};
const lines = itemBody(
  '- [ ] Read a split frame\n- [x] Keep the framing bytes\n- [~] Move the old fixture\n- [ ] Report the byte count',
).lines;
const projectUrl = 'https://example.test/builder/parser';
const modal = { open: true, onOpenChange() {} };

test('J02 handoff shows the Item and its checklist before the full prompt disclosure', () => {
  const html = renderToStaticMarkup(
    h(HandoffSheet, { ...modal, item: row, itemUrl: `${projectUrl}/plan/${row.id}`, lines, projectUrl }),
  );
  assert.match(html, /Show prompt/);
  const [preview, disclosure] = html.split('<details>');
  assert.match(preview, /Preserve split bytes/);
  assert.match(preview, /nforge agent \. start/);
  assert.match(preview, /Read a split frame.*Keep the framing bytes.*Report the byte count/s);
  assert.match(disclosure, /Read a split frame.*Keep the framing bytes.*Report the byte count/s);
  assert.doesNotMatch(html, /Move the old fixture/);
});

test('J10 Close Item lists the outstanding checklist lines before the quick reasons', () => {
  const html = renderToStaticMarkup(
    h(CloseSheet, { ...modal, rows: [row], lines, go: async () => null, busy: false, error: '' }),
  );
  assert.match(html, /Not needed/);
  assert.match(html, /Read a split frame.*Report the byte count.*Not needed/s);
  assert.doesNotMatch(html, /Keep the framing bytes|Move the old fixture/);
});
