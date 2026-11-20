// SPDX-License-Identifier: Apache-2.0
// Which test files are browser fixtures, with no imports, so code that only asks this (preflight)
// does not load the shard planner. scripts/browser-test-policy.mjs re-exports it.
// A test file named `tests/<name>-browser.test.mjs` is a browser fixture by name, in
// control and Candidate inventories alike, so a new one needs no registry edit. Only
// older browser fixtures without that suffix are listed here.
const browserName = /^tests\/[^/]+-browser\.test\.mjs$/;
export const browserTests = [
  'billing-home',
  'billing-screens',
  'docs-site',
  'ds-reference',
  'public-discovery-web',
  'run-proof-screen',
  'secrets-screen',
  'stats-screen',
  'ui-account-sessions',
  'ui-agent-sessions',
  'ui-code-index',
  'ui-code-labels',
].map(name => `tests/${name}.test.mjs`);
const browserSet = new Set(browserTests);
export const isBrowserTest = file => browserSet.has(file) || browserName.test(file);
