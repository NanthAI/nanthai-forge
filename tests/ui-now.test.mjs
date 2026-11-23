// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';

import { moduleUrl } from './convex-module.mjs';

test('light metadata text meets AA against every light neutral surface', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../web/src/ui/tokens.css', import.meta.url), 'utf8');
  const light = css.split(":root[data-theme='dark']")[0];
  const token = name => light.match(new RegExp(`--fx-${name}: (#[0-9a-f]{6})`))[1];
  const luminance = color =>
    color
      .slice(1)
      .match(/../g)
      .map(hex => parseInt(hex, 16) / 255)
      .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const foreground = luminance(token('text-3'));
  for (const surface of ['bg', 'surface', 'surface-2', 'surface-3', 'hover']) {
    const background = luminance(token(surface));
    assert.ok((background + 0.05) / (foreground + 0.05) >= 4.5, surface);
  }
});
