// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { isMainModule } from './main-module.mjs';

/** Shared availability rule, also run by the fixed executor before browser tests. */
export function browserExecutable(
  t,
  { env = process.env, executablePath, exists = existsSync, root = process.cwd() } = {},
) {
  if (env.FORGE_BROWSER_TESTS === '0') {
    t.skip('Browser coverage is outside this changed-path selection.');
    return null;
  }
  executablePath ??=
    env.FORGE_UI_BROWSER || createRequire(join(root, 'package.json'))('playwright').chromium.executablePath();
  if (exists(executablePath)) return executablePath;
  if (env.CI && !['0', 'false'].includes(String(env.CI).toLowerCase()))
    throw new Error(
      'CI browser is missing. Restore the pinned Playwright browser cache before running browser tests; CI cannot skip this coverage.',
    );
  t.skip('A local test browser is not installed; install Playwright Chromium or set FORGE_UI_BROWSER.');
  return null;
}

if (isMainModule(import.meta.url))
  browserExecutable({ skip: () => {} }, { env: { ...process.env, CI: '1' } });
