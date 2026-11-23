// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item ad80e037 fix 5: preflight's clean environment hid the browser cache, so all 18 UI browser tests
// skipped in 0.0 s and the skip counted as a pass; a broken screen reached the landing check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/state/hash.js';
import { sourceTree } from '../dist/source-tree.js';
import { preflightPlan, preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import { preflightBrowserEnv } from '../dist/preflight-browser.js';

const laneId = '33333333-3333-4333-8333-333333333333';
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

function lane(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-skips-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // An empty standard check entry: Forge's own Node layout, as the other preflight fixtures use.
  const bytes = new Map(Object.entries({ 'scripts/forge-check.mjs': '', ...files }));
  for (const [path, body] of bytes) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const list = () => [...bytes].map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const plan = paths => preflightPlan(root, { paths, complete: true }, { laneId, files: list() });
  const run = p => runPreflight(root, laneId, digest(JSON.stringify(list())), p, sourceTree(list()));
  return { root, dir, plan, run };
}
const withEnv = (t, name, value) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
};

const manifest = forge =>
  JSON.stringify({ type: 'module', scripts: {}, forge: { preflight: { static: [], ...forge } } });
const browserTest = body => `import test from 'node:test';\nimport '../src/screen.ts';\n${body}\n`;
const skipping = browserTest(
  `test('screen renders', t => { t.skip('Playwright Chromium is not installed.'); });`,
);

test('fix 5: a browser test that skips is NOT COMPLETE (needs Chromium), never a pass or a reusable pass', t => {
  withEnv(t, 'FORGE_UI_BROWSER', undefined);
  const f = lane(t, {
    'package.json': manifest({}),
    'src/screen.ts': 'export const screen = 1;\n',
    'tests/screen-browser.test.mjs': skipping,
  });
  const plan = f.plan(['src/screen.ts']);
  assert.deepEqual(plan.tests, ['tests/screen-browser.test.mjs']);
  const receipt = f.run(plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.outcome, 'incomplete');
  assert.deepEqual(receipt.incomplete.needs.files, ['tests/screen-browser.test.mjs']);
  assert.equal(receipt.incomplete.needs.runtime, 'Chromium');
  assert.equal(receipt.incomplete.finish, undefined, 'a rerun does not install a browser');
  assert.equal(receipt.tests, 0, 'the skipped file is not counted as run');
});

test('fix 5: a planned browser test whose browser is absent is not run, for a project runner too', t => {
  // The same availability rule the check's browser runtime uses: FORGE_UI_BROWSER, else Playwright.
  withEnv(t, 'FORGE_UI_BROWSER', '/nonexistent/forge-test-browser');
  const passing = browserTest(`test('screen renders', () => {});`);
  for (const forge of [
    {},
    { tests: { glob: 'tests/*.test.mjs', command: [process.execPath, '--test', '{files}'] } },
  ]) {
    const f = lane(t, {
      'package.json': manifest(forge),
      'src/screen.ts': 'export const screen = 1;\n',
      'tests/screen-browser.test.mjs': passing,
    });
    const receipt = f.run(f.plan(['src/screen.ts']));
    assert.equal(receipt.outcome, 'incomplete', JSON.stringify(forge));
    assert.deepEqual(receipt.incomplete.needs.files, ['tests/screen-browser.test.mjs']);
    assert.equal(receipt.passed, false);
  }
});

test('fix 5: the browser cache the agent has is still found inside preflight after HOME/XDG isolation', t => {
  withEnv(t, 'FORGE_UI_BROWSER', undefined);
  const cache = mkdtempSync(join(tmpdir(), 'forge-browser-cache-'));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  withEnv(t, 'PLAYWRIGHT_BROWSERS_PATH', cache);
  assert.deepEqual(preflightBrowserEnv(), { PLAYWRIGHT_BROWSERS_PATH: cache });
  assert.deepEqual(preflightBrowserEnv({ PLAYWRIGHT_BROWSERS_PATH: join(cache, 'absent') }), {});
  const f = lane(t, {
    'package.json': manifest({}),
    'src/a.ts': 'export const a = 1;\n',
    'tests/a.test.mjs':
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport '../src/a.ts';\n` +
      `test('sees the cache', () => { assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, ${JSON.stringify(cache)}); assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)}); });\n`,
  });
  const receipt = f.run(f.plan(['src/a.ts']));
  assert.equal(receipt.outcome, 'passed', JSON.stringify(receipt.failure));
});
