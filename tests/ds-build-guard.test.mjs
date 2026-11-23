// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The build guard for the design system's behaviour layer (scripts/ds-build-guard.mjs, Item 6ebb58ab): only
// web/src/ds/behaviour imports the headless library, no second behaviour or drag library appears, the release-candidate
// Autocomplete stays in one file, and the layer never reaches the first-paint chunks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layerBundleReport, layerImportViolation } from '../scripts/ds-build-guard.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = path => join(root, path);

test('the headless library is imported only from the behaviour folder', () => {
  assert.equal(layerImportViolation('react-aria-components', at('web/src/ds/behaviour/Menu.tsx')), null);
  assert.equal(layerImportViolation('react-aria/useDrag', at('web/src/ds/behaviour/Dock.tsx')), null);
  for (const id of [
    'react-aria-components',
    'react-aria-components/GridList',
    'react-aria',
    '@react-aria/dnd',
    'react-stately',
    '@react-stately/list',
  ])
    assert.match(
      layerImportViolation(id, at('web/src/HostedLanes.tsx')) ?? '',
      /outside web\/src\/ds\/behaviour/,
      id,
    );
  assert.match(
    layerImportViolation('react-aria-components', at('web/src/ds/interactive.tsx')) ?? '',
    /outside/,
  );
  // the library's own files and relative imports are not checked
  assert.equal(
    layerImportViolation('react-aria/private/x', at('node_modules/react-aria-components/dist/x.mjs')),
    null,
  );
  assert.equal(layerImportViolation('./behaviour', at('web/src/ds/layer.ts')), null);
  // a look-alike name is not the library
  assert.equal(layerImportViolation('react-ariadne', at('web/src/App.tsx')), null);
});

test('a second behaviour, drag or motion library fails anywhere, the behaviour folder included', () => {
  for (const id of [
    '@dnd-kit/core',
    '@radix-ui/react-dialog',
    'cmdk',
    'vaul',
    'framer-motion',
    'motion/react',
    '@floating-ui/react',
    'react-beautiful-dnd',
    '@hello-pangea/dnd',
    'downshift',
  ])
    assert.match(layerImportViolation(id, at('web/src/ds/behaviour/Menu.tsx')) ?? '', /second behaviour/, id);
  assert.equal(layerImportViolation('@floating-ui/dom-utils-not-react', at('web/src/App.tsx')), null);
});

test('Autocomplete (a release candidate) is imported in one file only', () => {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        /\.(tsx?|mjs)$/.test(entry.name) &&
        /\bAutocomplete\b/.test(readFileSync(path, 'utf8').replace(/\/\/.*$/gm, ''))
      )
        files.push(relative(root, path));
    }
  };
  walk(at('web/src'));
  assert.deepEqual(files, ['web/src/ds/behaviour/Palette.tsx']);
});

const chunk = (fileName, modules, extra = {}) => ({
  type: 'chunk',
  fileName,
  code: 'x'.repeat(200) + fileName,
  imports: [],
  modules: Object.fromEntries(modules.map(id => [id, {}])),
  ...extra,
});

test('the bundle report fails a first-paint chunk that carries the layer and measures the layer against its budget', () => {
  const clean = {
    'app.js': chunk('app.js', ['/r/web/src/main.tsx'], { isEntry: true }),
    'hosted.js': chunk('hosted.js', ['/r/web/src/app/App.tsx'], { facadeModuleId: '/r/web/src/app/App.tsx' }),
    'layer.js': chunk(
      'layer.js',
      ['/r/web/src/ds/behaviour/index.ts', '/r/node_modules/react-aria-components/dist/Menu.mjs'],
      {
        facadeModuleId: '/r/web/src/ds/behaviour/index.ts',
        imports: ['shared.js'],
      },
    ),
    'shared.js': chunk('shared.js', ['/r/node_modules/@react-aria/utils/x.mjs']),
  };
  const ok = layerBundleReport(clean, 10_000);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.layer.files.sort(), ['layer.js', 'shared.js']);
  assert.ok(ok.layer.gzipBytes > 0);
  assert.match(layerBundleReport(clean, 10).problems.join(), /over the 10 budget/);

  const leaked = { ...clean, 'hosted.js': { ...clean['hosted.js'], imports: ['shared.js'] } };
  assert.match(
    layerBundleReport(leaked, 10_000).problems.join(),
    /first-paint chunk shared\.js carries the behaviour layer/,
  );
  // The rebuilt app under /- (Item 84125787) paints first too: its module may not carry the layer either.
  const rebuilt = {
    ...clean,
    'rebuilt.js': chunk('rebuilt.js', ['/r/web/src/app/App.tsx'], {
      facadeModuleId: '/r/web/src/app/App.tsx',
      imports: ['shared.js'],
    }),
  };
  assert.match(
    layerBundleReport(rebuilt, 10_000).problems.join(),
    /first-paint chunk shared\.js carries the behaviour layer/,
  );
});
