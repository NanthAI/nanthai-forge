// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { browserExecutable, chromiumLaunchOptions, settleBrowserPage } from './browser-runtime.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';

test('1dd4e095: a symlinked probe entry still fails a missing selected CI browser', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-browser-entry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, 'probe.mjs');
  symlinkSync(fileURLToPath(new URL('../scripts/check-browser-runtime.mjs', import.meta.url)), entry);
  assert.throws(
    () =>
      execFileSync(process.execPath, [entry], {
        env: { ...process.env, FORGE_BROWSER_TESTS: '1', FORGE_UI_BROWSER: join(directory, 'missing') },
        stdio: 'pipe',
      }),
    /CI browser is missing/,
  );
});

test('1dd4e095: a missing CI browser fails instead of skipping coverage', () => {
  let skipped = false;
  assert.throws(
    () =>
      browserExecutable(
        {
          skip() {
            skipped = true;
          },
        },
        {
          env: { CI: 'true' },
          executablePath: '/synthetic/missing-browser',
          exists: () => false,
        },
      ),
    /CI browser is missing/,
  );
  assert.equal(skipped, false);
});
test('1dd4e095: local missing browsers skip and a configured cached executable is retained', () => {
  let skipped = false;
  assert.equal(
    browserExecutable(
      {
        skip() {
          skipped = true;
        },
      },
      {
        env: {},
        executablePath: '/synthetic/missing-browser',
        exists: () => false,
      },
    ),
    null,
  );
  assert.equal(skipped, true);
  const cached = browserExecutable(
    {
      skip() {
        assert.fail('cached browser cannot skip');
      },
    },
    {
      env: { CI: 'true', FORGE_UI_BROWSER: '/synthetic/cached-browser' },
      exists: path => path === '/synthetic/cached-browser',
    },
  );
  assert.equal(cached, '/synthetic/cached-browser');
});

test('1dd4e095: CI fixture launch options honor the probe’s override without a Playwright cache', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-browser-override-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { CI: 'true', FORGE_UI_BROWSER: process.execPath, PLAYWRIGHT_BROWSERS_PATH: root };
  const probe = new URL('../scripts/check-browser-runtime.mjs', import.meta.url);
  assert.equal(execFileSync(process.execPath, [fileURLToPath(probe)], { env }).length, 0);
  const fixture = { skip: () => assert.fail('a configured browser cannot skip') };
  assert.deepEqual(chromiumLaunchOptions(fixture, { env }), { executablePath: process.execPath });
  assert.throws(
    () =>
      chromiumLaunchOptions(fixture, {
        env: { ...env, FORGE_UI_BROWSER: '' },
        executablePath: join(root, 'missing'),
      }),
    /CI browser is missing/,
  );
});

test('1dd4e095: the fixed executor fails a missing selected browser before any fixture can silently skip', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-browser-executor-'));
  const prior = { ...process.env };
  t.after(() => {
    process.env = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, 'plan.json');
  process.env.FORGE_ACTIONS_PLAN = path;
  process.env.FORGE_ACTIONS_SHARD = '0';
  process.env.FORGE_UI_BROWSER = join(root, 'missing-browser');
  const plan = {
    standard: true,
    selection: { scope: 'full', tests: ['tests/app-plan-browser.test.mjs'], browser: true },
    groups: [['tests/app-plan-browser.test.mjs']],
  };
  const testRuns = [];
  const execute = (cmd, args, options) => {
    if (args[0]?.endsWith('check-browser-runtime.mjs'))
      return execFileSync(cmd, args, { ...options, stdio: 'pipe' });
    if (args[0] === 'scripts/test-files.mjs') testRuns.push(options.env.FORGE_BROWSER_TESTS);
  };
  writeFileSync(path, JSON.stringify(plan));
  assert.throws(() => runActionsCheck(execute, { install: false, build: false }), /CI browser is missing/);
  assert.deepEqual(testRuns, []);
  process.env.FORGE_UI_BROWSER = process.execPath;
  runActionsCheck(execute, { install: false, build: false });
  assert.deepEqual(testRuns, ['1']);
  plan.selection.browser = false;
  writeFileSync(path, JSON.stringify(plan));
  process.env.FORGE_UI_BROWSER = join(root, 'missing-browser');
  runActionsCheck(execute, { install: false, build: false });
  assert.deepEqual(testRuns, ['1', '0']);
  let skipped = false;
  assert.equal(
    browserExecutable(
      {
        skip() {
          skipped = true;
        },
      },
      {
        env: { CI: 'true', FORGE_BROWSER_TESTS: '0' },
        exists() {
          assert.fail('an excluded browser is never probed');
        },
      },
    ),
    null,
  );
  assert.equal(skipped, true);
});

test('1dd4e095: layout readiness settles fonts and finite transitions without waiting for infinite animation or a frame clock', async () => {
  const fonts = Promise.withResolvers();
  const events = [];
  let opacity = 0;
  const document = {
    fonts: { ready: fonts.promise },
    documentElement: { getBoundingClientRect: () => events.push('layout') },
    getAnimations() {
      return [
        {
          effect: { getComputedTiming: () => ({ iterations: Infinity }) },
          finish() {
            assert.fail('an infinite animation must keep running');
          },
          get finished() {
            assert.fail('an infinite animation never settles');
          },
        },
        {
          effect: { getComputedTiming: () => ({ iterations: 1 }) },
          finish() {
            opacity = 1;
          },
          get finished() {
            assert.equal(opacity, 1, 'settle the final appearance without depending on animation ticks');
            return Promise.resolve();
          },
        },
        {
          effect: null,
          finish() {},
          get finished() {
            return Promise.reject(new Error('animation cancelled'));
          },
        },
      ];
    },
  };
  const ready = settleBrowserPage({ evaluate: callback => runInNewContext(`(${callback})()`, { document }) });
  assert.deepEqual(events, [], 'fonts must settle before measuring layout');
  fonts.resolve();
  await ready;
  assert.deepEqual(events, ['layout']);
  assert.equal(opacity, 1);
});
