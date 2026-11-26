// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { join } from 'node:path';
import { buildBrowserFixture, readFixtureAsset, repoRoot, routeBrowserFixture } from '../browser-fixture.mjs';

export async function buildFixture(out) {
  const { html } = await buildBrowserFixture(out, {
    entry: 'tests/browser/ds-screens.tsx',
    inputName: 'screens',
    extraInputs: { ds: join(repoRoot, 'web/ds.html') },
    title: 'Forge reflow fixture',
    headExtra: '<style>body { margin: 0 }</style>',
    dynamicImports: false,
  });
  return html;
}

export function fixtureResponse(out, html, path) {
  if (!/\.[a-z0-9]+$/i.test(path)) return { contentType: 'text/html', body: html };
  return (
    readFixtureAsset(out, path, { publicFonts: true, fallbackType: 'application/octet-stream' }) ?? {
      status: 404,
      body: '',
    }
  );
}

export async function serveFixture(page, out, html, path) {
  await routeBrowserFixture(page, out, html, {
    matchHtml: url => !/\.[a-z0-9]+$/i.test(url.pathname),
    publicFonts: true,
    fallbackType: 'application/octet-stream',
  });
  await page.goto(`https://forge.test${path}`);
}
