// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Planted sources for the test-hygiene lint rules (tests/lint-rules.test.mjs, guard 7, Item 611a1795).
// Each is the text of a would-be test file. They sit here, not in the test file, because the
// test-signal ratchet counts sleeps by line even inside strings. Line 1 is the import, line 2 the plant.
const plant = (...lines) => `import test from 'node:test';\n${lines.join('\n')}\n`;

export const plants = {
  sleep: {
    'tests/promise.test.mjs': plant(
      '',
      "test('a', async () => { await new Promise(resolve => setTimeout(resolve, 50)); });",
    ),
    'tests/callback.test.mjs': plant(
      '',
      "test('a', async () => { await new Promise(done => setTimeout(() => done(), 5)); });",
    ),
    'tests/timers.test.mjs':
      "import { setTimeout as pause } from 'node:timers/promises';\nimport test from 'node:test';\ntest('a', async () => { await pause(20); });\n",
    'tests/helper.test.mjs': plant('', "test('a', async () => { await sleep(10); });"),
    'tests/atomics.test.mjs': plant(
      '',
      "test('a', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); });",
    ),
    'tests/spawned.test.mjs': plant(
      "import { execSync } from 'node:child_process';",
      "test('a', () => { execSync('sleep 1'); });",
    ),
    // A yield to the event loop, a timer that is not a wait, an event wait and a local helper are not fixed sleeps.
    'tests/ok.test.mjs': plant(
      "import { once } from 'node:events';",
      "test('a', async () => {",
      '  await new Promise(resolve => setTimeout(resolve, 0));',
      '  const timer = setTimeout(() => {}, 1000); clearTimeout(timer);',
      "  await once(process, 'beforeExit');",
      '  const sleep = () => 1; sleep();',
      '});',
    ),
    // Only tests/ is covered.
    'src/outside.ts': 'export const wait = () => new Promise(resolve => setTimeout(resolve, 50));\n',
  },
  retry: {
    'tests/option.test.mjs': plant("test('a', { retry: 2 }, () => {});"),
    'tests/suite.test.mjs': plant("describe('a', { retries: 3 }, () => {});"),
    'tests/jest.test.mjs': plant('jest.retryTimes(2);'),
    'tests/ok.test.mjs': plant(
      "test('a', { retry: 0 }, () => {});",
      'const retry = 3;',
      "test('b', () => { fetchTwice({ retry }); });",
    ),
  },
  timeout: {
    'tests/raised.test.mjs': plant("test('a', { timeout: 120000 }, async () => {});"),
    'tests/hook.test.mjs': plant('before(async () => {}, { timeout: 60_000 });'),
    'tests/config.test.mjs': plant('jest.setTimeout(30000);', 'const config = { testTimeout: 45000 };'),
    'tests/ok.test.mjs': plant(
      "test('a', { timeout: 5000 }, async () => {});",
      "spawnSync('x', [], { timeout: 120000 });",
    ),
  },
  poll: {
    'tests/interval.test.mjs': plant("test('a', () => { setInterval(() => {}, 10); });"),
    'tests/loop.test.mjs': plant(
      "test('a', async () => { while (!ready()) await new Promise(resolve => setTimeout(resolve, 10)); });",
    ),
    'tests/helper.test.mjs': plant("test('a', async () => { await eventually(() => ready()); });"),
    // A domain call named poll, and a loop that waits on an event, are not polling.
    'tests/ok.test.mjs': plant(
      "test('a', async () => { await flow.poll(id); while (more()) await once(emitter, 'data'); });",
    ),
  },
};

/** A test file with `count` fixed sleeps, one per line from line 2 on. */
export const sleeps = count =>
  plant(...Array.from({ length: count }, (_, i) => `test('t${i}', async () => { await sleep(${i + 1}); });`));
