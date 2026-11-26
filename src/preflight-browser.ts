// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isBrowserTest } from '../scripts/test-browser-names.mjs';
import { testBrowserPath } from '../scripts/test-browser-path.mjs';

const browserTestsOff = (env: NodeJS.ProcessEnv) => env.FORGE_BROWSER_TESTS === '0';

/** Filter before launching a runner: framework-level skips can still load browser test files. */
export function disabledBrowserTests(tests: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return browserTestsOff(env) ? tests.filter(isBrowserTest) : [];
}

/** Browser tests in preflight (Item ad80e037 fix 5). The landing check's test jobs get the browser
 * cache and browser override passed through (src/hosted-actions-job-run.ts: PLAYWRIGHT_BROWSERS_PATH,
 * FORGE_UI_BROWSER). Preflight's clean environment gives HOME/XDG private empty folders, and Playwright
 * looks for its cache under them, so every browser test skipped and the skip counted as a pass. These
 * are resolved from the agent's own environment, before that isolation. */
export function preflightBrowserEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (browserTestsOff(env)) return { FORGE_BROWSER_TESTS: '0' };
  const browser: Record<string, string> = {};
  const cache = testBrowserPath(env);
  // '0' is Playwright's "browsers inside node_modules": a setting, not a folder.
  if (cache === '0' || existsSync(cache)) browser.PLAYWRIGHT_BROWSERS_PATH = cache;
  if (env.FORGE_UI_BROWSER) browser.FORGE_UI_BROWSER = env.FORGE_UI_BROWSER;
  return browser;
}

/** What a skipped browser test needs, and how to get it here. */
export const NEEDS_CHROMIUM = {
  runtime: 'Chromium',
  next: 'npx playwright install chromium (in the Lane), then run preflight again',
} as const;

export const NEEDS_BROWSER_ENABLED = {
  runtime: NEEDS_CHROMIUM.runtime,
  next: 'run preflight again without FORGE_BROWSER_TESTS=0',
} as const;

/** The planned browser tests (the landing check's own browser policy, scripts/browser-test-policy.mjs)
 * when the browser they need is not installed for ENV: the same rule as the check's browser runtime
 * (FORGE_UI_BROWSER, else Playwright's Chromium, resolved from the project's own install in ROOT).
 * They are not run; the run is NOT COMPLETE. Empty when none is planned, the browser is there, or the
 * project's Playwright cannot be loaded (then the tests run and report their own failure). */
export function missingBrowserTests(root: string, tests: string[], env: NodeJS.ProcessEnv): string[] {
  const browserTests = tests.filter(isBrowserTest);
  if (!browserTests.length) return [];
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      "const p = process.env.FORGE_UI_BROWSER || require('playwright').chromium.executablePath(); process.exit(require('node:fs').existsSync(p) ? 0 : 3);",
    ],
    { cwd: root, env, stdio: 'ignore', timeout: 30_000 },
  );
  return probe.status === 3 ? browserTests : [];
}

/** Planned browser test files that skipped a test: the browser did not run, so the file is no pass. */
export const skippedBrowserTests = (skipped: Record<string, string>) =>
  Object.keys(skipped).filter(isBrowserTest).sort();
