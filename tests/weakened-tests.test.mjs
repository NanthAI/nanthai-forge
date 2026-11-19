// SPDX-License-Identifier: Apache-2.0
// Issue 11901a0c: preflight flags a weakened test (removed or loosened assertions, added skips or
// name filters, a changed input under unchanged assertions) by file and test name, and never a
// plain refactor. Real past diffs of this repository's own tests are in fixtures/weakened-tests.json.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { weakenedTestFlags } from '../dist/weakened-tests.js';
import {
  laneWeakenedTests,
  laneWeakenedTestsReply,
  weakenedTestsReason,
  weakenedTestsReply,
} from '../dist/preflight-weakened-tests.js';
import { digest } from '../dist/state/hash.js';
import { localObjects } from '../dist/machine-object-store.js';
import { parseNativeState } from '../dist/state/format.js';
import { clientCacheRoot } from '../dist/root-paths.js';

const reads = { objects: localObjects, digest, files: state => parseNativeState(state).files };

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/weakened-tests.json', import.meta.url), 'utf8'));
const kinds = changes => weakenedTestFlags(changes).map(flag => [flag.test, flag.kind]);
const one = (before, after, path = 'tests/a.test.mjs') => kinds([{ path, before, after }]);
const STRICT = "import assert from 'node:assert/strict';\nimport test from 'node:test';\n";
const LOOSE = "import assert from 'node:assert';\nimport test from 'node:test';\n";

test('real past diffs: each weakening is flagged by test and kind, and each refactor is not', () => {
  assert.ok(fixtures.some(item => item.name.startsWith('687d1eda replay')));
  assert.ok(fixtures.some(item => item.name.startsWith('G2a replay')));
  for (const item of fixtures) assert.deepEqual(kinds(item.changes), item.expect, item.name);
  // The two incidents that made this a machine check (687d1eda and the G2a review).
  const replay = name => fixtures.find(item => item.name.startsWith(name));
  assert.deepEqual(
    kinds(replay('687d1eda').changes).find(([name]) => name.startsWith('1dd4e095: a Candidate adding')),
    [
      '1dd4e095: a Candidate adding a -browser fixture gets browser coverage and the browser job without a registry edit',
      'input-changed',
    ],
  );
  assert.deepEqual(
    kinds(replay('G2a').changes).map(([, kind]) => kind),
    ['name-pattern-narrowed'],
  );
});

test('a strict check made loose, an exact value made a bound and a truthiness check are loosened', () => {
  const t = body => `${LOOSE}test('t', () => {\n  ${body}\n});\n`;
  assert.deepEqual(one(t('assert.strictEqual(n, 3);'), t('assert.equal(n, 3);')), [
    ['t', 'assertion-loosened'],
  ]);
  assert.deepEqual(one(t('assert.ok(n === 3);'), t('assert.ok(n >= 3);')), [['t', 'assertion-loosened']]);
  assert.deepEqual(one(t('expect(n).toBe(3);'), t('expect(n).toBeGreaterThanOrEqual(3);')), [
    ['t', 'assertion-loosened'],
  ]);
  assert.deepEqual(one(t('expect(n).toBe(3);'), t('expect(n).not.toBe(4);')), [['t', 'assertion-loosened']]);
  assert.deepEqual(one(t("assert.throws(f, { code: 'X' });"), t('assert.throws(f);')), [
    ['t', 'assertion-loosened'],
  ]);
  // Under node:assert/strict, equal already is strictEqual: switching between them is a refactor.
  const s = body => `${STRICT}test('t', () => {\n  ${body}\n});\n`;
  assert.deepEqual(one(s('assert.strictEqual(n, 3);'), s('assert.equal(n, 3);')), []);
  // Stronger is never flagged.
  assert.deepEqual(one(t('assert.ok(n >= 3);'), t('assert.strictEqual(n, 3);')), []);
});

test('fewer assertion calls in a test are flagged with counts, never values', () => {
  const before = `${STRICT}test('t', () => {\n  assert.equal(a, 1);\n  assert.equal(b, 2);\n});\n`;
  const after = `${STRICT}test('t', () => {\n  assert.equal(a, 1);\n});\n`;
  const [flag] = weakenedTestFlags([{ path: 'tests/a.test.mjs', before, after }]);
  assert.deepEqual(flag, {
    file: 'tests/a.test.mjs',
    test: 't',
    kind: 'assertions-removed',
    assertions: { before: 2, after: 1 },
  });
});

test('added skips are flagged: modifiers, options, a skip call and a guarded early return', () => {
  const body = '  assert.equal(run(), 1);\n';
  const plain = `${STRICT}test('t', () => {\n${body}});\n`;
  for (const after of [
    `${STRICT}test.skip('t', () => {\n${body}});\n`,
    `${STRICT}test.todo('t', () => {\n${body}});\n`,
    `${STRICT}test('t', { skip: true }, () => {\n${body}});\n`,
    `${STRICT}test('t', { skip: process.env.CI }, () => {\n${body}});\n`,
    `${STRICT}test('t', t => {\n  if (process.env.CI) t.skip('later');\n${body}});\n`,
    `${STRICT}test('t', () => {\n  if (process.env.CI) return;\n${body}});\n`,
    `${STRICT}test.skipIf(process.env.CI)('t', () => {\n${body}});\n`,
  ])
    assert.deepEqual(one(plain, after), [['t', 'skip-added']], after);
  // A false option skips nothing; a return inside a callback is not the test's return.
  assert.deepEqual(one(plain, `${STRICT}test('t', { skip: false }, () => {\n${body}});\n`), []);
  const callback = one(
    `${STRICT}test('t', () => {\n  const f = x => x + 1;\n${body}});\n`,
    `${STRICT}test('t', () => {\n  const f = x => { if (!x) return 0; return x + 1; };\n${body}});\n`,
  );
  assert.deepEqual(callback, [['t', 'input-changed']]);
});

test('.only narrows the file and a name filter written into a test narrows what it runs', () => {
  const plain = `${STRICT}test('t', () => {\n  assert.equal(run(), 1);\n});\n`;
  assert.deepEqual(one(plain, plain.replace("test('t'", "test.only('t'")), [['t', 'only-added']]);
  const child = args =>
    `${STRICT}test('t', async () => {\n  await spawn([${args}]);\n  assert.equal(code, 0);\n});\n`;
  assert.deepEqual(one(child("'--test', 'f.mjs'"), child("'--test', '--test-name-pattern=x', 'f.mjs'")), [
    ['t', 'name-pattern-narrowed'],
  ]);
});

test('plain refactors are not flagged: layout, comments, order, local names, helpers, moves and new tests', () => {
  const a = `${STRICT}test('first', () => {\n  const value = make({ a: 1 });\n  assert.deepEqual(value, { a: 1 });\n});\n\ntest('second', () => {\n  assert.equal(two(), 2);\n});\n`;
  const relaid = `${STRICT}// A comment.\ntest(\n  'first',\n  () => {\n    const value = make({\n      a: 1,\n    });\n    assert.deepEqual(value, { a: 1 });\n  },\n);\n\ntest('second', () => {\n  assert.equal(two(), 2); // still two\n});\n`;
  assert.deepEqual(one(a, relaid), []);
  const reordered = `${STRICT}test('second', () => {\n  assert.equal(two(), 2);\n});\n\ntest('first', () => {\n  const value = make({ a: 1 });\n  assert.deepEqual(value, { a: 1 });\n});\n`;
  assert.deepEqual(one(a, reordered), []);
  // A local renamed everywhere it is used, and a test renamed with the same body.
  assert.deepEqual(one(a, a.replaceAll('value', 'made').replace("'second'", "'second, renamed'")), []);
  const added = `${a}\ntest('third', () => {\n  assert.equal(three(), 3);\n});\n`;
  assert.deepEqual(one(a, added), []);
  // The assertions moved into a file helper the test calls.
  const helper = `${STRICT}function check(value) {\n  assert.deepEqual(value, { a: 1 });\n}\ntest('first', () => {\n  const value = make({ a: 1 });\n  check(value);\n});\n\ntest('second', () => {\n  assert.equal(two(), 2);\n});\n`;
  assert.deepEqual(one(a, helper), []);
  // A test moved to another changed file keeps its body: not a removal.
  const second = `${STRICT}test('second', () => {\n  assert.equal(two(), 2);\n});\n`;
  const firstOnly = `${STRICT}test('first', () => {\n  const value = make({ a: 1 });\n  assert.deepEqual(value, { a: 1 });\n});\n`;
  assert.deepEqual(
    kinds([
      { path: 'tests/a.test.mjs', before: a, after: firstOnly },
      { path: 'tests/b.test.mjs', before: null, after: second },
    ]),
    [],
  );
  // Without the destination it is a removal.
  assert.deepEqual(one(a, firstOnly), [['second', 'test-removed']]);
});

test('a test whose input changed under the same assertions is a hint, not a weakening', () => {
  const t = input =>
    `${STRICT}test('filters', () => {\n  const out = filter(${input});\n  assert.equal(out.includes('x'), false);\n});\n`;
  const [flag] = weakenedTestFlags([
    { path: 'tests/a.test.mjs', before: t("['x', 'y']"), after: t("['y']") },
  ]);
  assert.deepEqual(flag, { file: 'tests/a.test.mjs', test: 'filters', kind: 'input-changed', hint: true });
  // A file that does not parse is left to its own test run.
  assert.deepEqual(one(t("['x']"), 'test(('), []);
});

test('a reason line in the landing message clears the flags; without one the reply says how', () => {
  const flags = Array.from({ length: 23 }, (_, i) => ({
    file: 'tests/a.test.mjs',
    test: `t${i}`,
    kind: 'test-removed',
  }));
  const open = weakenedTestsReply(flags);
  assert.equal(open.count, 23);
  assert.equal(open.flags.length, 20);
  assert.equal(open.more, 3);
  assert.match(open.clear, /Weakened-tests: <why>/);
  assert.equal(open.cleared, undefined);
  const message = 'Drop the retired presence worker\n\nWeakened-tests: presence worker removed in 1b2c3d4e\n';
  const cleared = weakenedTestsReply(flags, message);
  assert.equal(cleared.cleared, 'presence worker removed in 1b2c3d4e');
  assert.equal(cleared.clear, undefined);
  // The reason is one line of its own; a bare key or a mention mid-sentence does not clear.
  assert.equal(weakenedTestsReason('Weakened-tests:'), null);
  assert.equal(weakenedTestsReason('See Weakened-tests: later'), null);
  assert.equal(weakenedTestsReply([], message), undefined);
});

test('the Lane check reads the base State and blobs from local stores only, and skips unknown bases', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-weakened-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = join(clientCacheRoot(root), 'objects');
  mkdirSync(store, { recursive: true });
  const put = body => {
    writeFileSync(join(store, digest(body)), body);
    return digest(body);
  };
  const files = new Map([
    ['tests/a.test.mjs', `${STRICT}test('t', () => {\n  assert.equal(a, 1);\n  assert.equal(b, 2);\n});\n`],
    ['src/a.ts', 'export const a = 1;\n'],
  ]);
  const entries = () => [...files].map(([path, body]) => ({ path, blob: put(body), mode: 'file' }));
  const state = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    message: 'base',
    at: '2026-11-19T00:00:00.000Z',
  };
  const base = put(JSON.stringify({ ...state, files: entries() }));
  // Only a new test file and a source edit: nothing existing changed, nothing to judge.
  files.set('src/a.ts', 'export const a = 2;\n');
  files.set('tests/new.test.mjs', `${STRICT}test('n', () => {});\n`);
  assert.deepEqual(
    laneWeakenedTests(reads, root, base, entries(), () => undefined),
    { flags: [], unchecked: 0 },
  );
  // The Lane folder holds the saved head; its bytes are used when they match the saved blob.
  files.set('tests/a.test.mjs', `${STRICT}test('t', () => {\n  assert.equal(a, 1);\n});\n`);
  const head = entries();
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests/a.test.mjs'), files.get('tests/a.test.mjs'));
  const reply = laneWeakenedTestsReply(
    reads,
    root,
    base,
    head,
    'Fix\n\nWeakened-tests: b is now covered by c.test.mjs',
  );
  assert.deepEqual(reply.flags, [
    { file: 'tests/a.test.mjs', test: 't', kind: 'assertions-removed', assertions: { before: 2, after: 1 } },
  ]);
  assert.equal(reply.cleared, 'b is now covered by c.test.mjs');
  // An unknown base (not on this machine) claims nothing.
  assert.equal(
    laneWeakenedTests(reads, root, 'f'.repeat(64), head, () => undefined),
    null,
  );
  assert.equal(laneWeakenedTestsReply(reads, root, 'f'.repeat(64), head), undefined);
});

test('preflight and land replies carry the flags, a reason line clears them, and no Convex call is added', async t => {
  const body = asserts => `${STRICT}test('kept', () => {\n${asserts}});\n`;
  const land = async (laneTest, message) => {
    const files = { 'package.json': '{"type":"module"}', 'scripts/forge-check.mjs': '' };
    const s = agentFixture(t, {
      base: { ...files, 'tests/a.test.mjs': body('  assert.equal(1, 1);\n  assert.equal(2, 2);\n') },
      lane: { ...files, 'tests/a.test.mjs': laneTest },
    });
    // On a real machine the start's checkout of main cached the base State and blobs here.
    const store = join(clientCacheRoot(s.root), 'objects');
    mkdirSync(store, { recursive: true });
    for (const [id, bytes] of s.objects) writeFileSync(join(store, id), bytes, { mode: 0o600 });
    s.caps.agentDefaults = effectiveAgentDefaults({ preflight: 'off' });
    s.caps.features = ['land-gates'];
    const transport = s.transport();
    await transport.dispatch('open', { laneId: s.lane.laneId });
    const mutate = s.exchange.client.mutation;
    s.exchange.client.mutation = async (ref, args) => {
      const text = await mutate(ref, args);
      if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return text;
      const state = JSON.parse(text);
      state.phase = 'landed';
      state.observation = { state: 'landed', pendingReason: null, cause: null };
      state.acceptance = { receiptId: randomUUID(), head: s.lane.head };
      return JSON.stringify(state);
    };
    const preflight = await transport.dispatch('preflight', { laneId: s.lane.laneId });
    const before = s.calls.length;
    const landed = await submitHostedLand(
      s.root,
      { operationId: randomUUID(), message },
      s.address,
      transport,
    );
    assert.equal(landed.result.submission.phase, 'landed', 'a flag never stops a landing');
    return {
      preflight: preflight.result,
      landed: landed.result,
      calls: s.calls.slice(before).map(c => c.name),
    };
  };
  const weakened = await land(body('  assert.equal(1, 1);\n'), 'Trim a test');
  const flag = {
    file: 'tests/a.test.mjs',
    test: 'kept',
    kind: 'assertions-removed',
    assertions: { before: 2, after: 1 },
  };
  assert.deepEqual(weakened.preflight.weakenedTests.flags, [flag]);
  assert.deepEqual(weakened.landed.defaults.weakenedTests.flags, [flag]);
  assert.match(weakened.landed.defaults.weakenedTests.clear, /Weakened-tests:/);
  const reasoned = await land(
    body('  assert.equal(1, 1);\n'),
    'Trim a test\n\nWeakened-tests: 2 === 2 proves nothing',
  );
  assert.equal(reasoned.landed.defaults.weakenedTests.cleared, '2 === 2 proves nothing');
  const strengthened = await land(
    body('  assert.equal(1, 1);\n  assert.equal(2, 2);\n  assert.equal(3, 3);\n'),
    'More',
  );
  assert.equal(strengthened.preflight.weakenedTests, undefined);
  assert.equal(strengthened.landed.defaults?.weakenedTests, undefined);
  assert.deepEqual(
    weakened.calls,
    strengthened.calls,
    'the check is local: the same Convex calls either way',
  );
});

// Review eeae9daf (11901a0c) findings 2-5 and the small lows: each case failed on 611ab04b.
test('a skip or early return added inside a helper the test calls is flagged on that test', () => {
  const t = helper =>
    `${STRICT}function check(t) {\n${helper}  assert.equal(run(), 1);\n}\ntest('t', t => {\n  check(t);\n});\n`;
  const plain = t('');
  assert.deepEqual(one(plain, t('  if (process.env.CI) return;\n')), [['t', 'skip-added']]);
  assert.deepEqual(one(plain, t("  if (process.env.CI) t.skip('later');\n")), [['t', 'skip-added']]);
  // A helper returning a value under a branch computes; it skips nothing.
  const value = body =>
    `${STRICT}function pick(x) {\n${body}  return x;\n}\ntest('t', () => {\n  assert.equal(pick(1), 1);\n});\n`;
  assert.deepEqual(one(value(''), value('  if (!x) return 0;\n')), []);
});

test('aliased and extended test functions, function-reference tests and the singular Jest name pattern are seen', () => {
  const aliased = tail =>
    `import assert from 'node:assert/strict';\nimport { it as baseIt } from 'node:test';\nconst it = baseIt${tail};\nit('t', () => {\n  assert.equal(run(), 1);\n});\n`;
  assert.deepEqual(one(aliased(''), aliased('.skip')), [['t', 'skip-added']]);
  const extended = call =>
    `${STRICT}const myTest = test.extend({ db: async () => {} });\n${call}('t', () => {\n  assert.equal(run(), 1);\n});\n`;
  assert.deepEqual(one(extended('myTest'), extended('myTest.only')), [['t', 'only-added']]);
  const ref = call =>
    `${STRICT}function runCase() {\n  assert.equal(run(), 1);\n}\n${call}\ntest('other', () => {\n  assert.equal(two(), 2);\n});\n`;
  const plain = ref("test('t', runCase);");
  assert.deepEqual(one(plain, ref("test.only('t', runCase);")), [['t', 'only-added']]);
  assert.deepEqual(one(plain, ref("test('t', { skip: true }, runCase);")), [['t', 'skip-added']]);
  assert.deepEqual(one(plain, ref("test.skipIf(process.env.CI)('t', runCase);")), [['t', 'skip-added']]);
  assert.deepEqual(one(plain, ref('')), [['t', 'test-removed']]);
  // A pattern's own .test() is never a test.
  const regex = `${STRICT}test('t', () => {\n  const s = 'x';\n  assert.ok(PATTERN.test(s));\n});\n`;
  assert.deepEqual(one(regex, regex.replace("'x'", "'xy'")), [['t', 'input-changed']]);
  const child = args =>
    `${STRICT}test('t', async () => {\n  await spawn(['vitest', ${args}]);\n  assert.equal(code, 0);\n});\n`;
  assert.deepEqual(one(child("'run'"), child("'run', '--testNamePattern=x'")), [
    ['t', 'name-pattern-narrowed'],
  ]);
});

test('honest refactors are not flagged: describe renames and moves, new subtests, renames next to deletions, formatting', () => {
  const suite = (name, extra = '') =>
    `${STRICT}describe('${name}', () => {\n  it('adds', () => {\n    assert.equal(add(1, 2), 3);\n  });\n${extra}});\n`;
  assert.deepEqual(one(suite('math'), suite('arithmetic')), []);
  // A test moved from one describe block into another.
  const two = (a, b) => `${STRICT}describe('a', () => {\n${a}});\ndescribe('b', () => {\n${b}});\n`;
  const moved = "  it('moves', () => {\n    assert.equal(move(), 1);\n  });\n";
  const kept = "  it('stays', () => {\n    assert.equal(stay(), 2);\n  });\n";
  assert.deepEqual(one(two(moved + kept, ''), two(kept, moved)), []);
  // Subtests added or reordered under a parent that asserts, and tests added under a beforeEach that asserts.
  const sub = (...names) =>
    `${STRICT}test('parent', async t => {\n  assert.ok(setup());\n${names.map(name => `  await t.test('${name}', () => {\n    assert.equal(${name}(), 1);\n  });\n`).join('')}});\n`;
  assert.deepEqual(one(sub('a', 'b'), sub('b', 'a', 'c')), []);
  const each = extra =>
    `${STRICT}describe('s', () => {\n  beforeEach(() => {\n    assert.ok(reset());\n  });\n  it('one', () => {\n    assert.equal(one(), 1);\n  });\n${extra}});\n`;
  assert.deepEqual(one(each(''), each("  it('two', () => {\n    assert.equal(two(), 2);\n  });\n")), []);
  // An earlier deleted test whose name prefixes a renamed one does not steal the rename.
  const pair = `${STRICT}test('checks the queue order', () => {\n  assert.equal(order(), 1);\n  assert.equal(order(), 2);\n});\ntest('checks the queue order under load', () => {\n  assert.equal(load(), 3);\n});\n`;
  const renamed = `${STRICT}test('checks the queue order under heavy load', () => {\n  assert.equal(load(), 3);\n});\n`;
  assert.deepEqual(one(pair, renamed), [['checks the queue order', 'test-removed']]);
  // Formatter-only edits: quote style, semicolons and a lone arrow parameter's parentheses.
  const before = `${STRICT}test('t', () => {\n  const v = make('a', x => x + 1);\n  assert.equal(v.size, 1);\n});\n`;
  const after = `${STRICT.replaceAll("'", '"').replaceAll(';', '')}test("t", () => {\n  const v = make("a", (x) => x + 1)\n  assert.equal(v.size, 1)\n})\n`;
  assert.deepEqual(one(before, after), []);
});

test('small precision fixes: data skips, schema.strict, unnamed options-first tests and CRLF reasons', () => {
  const t = body => `${STRICT}test('t', () => {\n${body}  assert.equal(run(), 1);\n});\n`;
  assert.deepEqual(one(t(''), t('  const rows = cursor.skip(5);\n')), [['t', 'input-changed']]);
  assert.deepEqual(one(t('  schema.strict.parse(input);\n'), t('')), [['t', 'input-changed']]);
  const unnamed = `${STRICT}test({ skip: false }, () => {\n  assert.equal(run(), 1);\n});\n`;
  assert.deepEqual(one(unnamed, unnamed.replace('assert.equal(run(), 1);', '')), [
    ['<anonymous>', 'assertions-removed'],
  ]);
  assert.equal(
    weakenedTestsReason('Fix\r\n\r\nWeakened-tests: moved to b.test.mjs\r\n'),
    'moved to b.test.mjs',
  );
});

test('a Lane past the check bound reports the files it did not check by count, and never fails', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-weakened-bound-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = join(clientCacheRoot(root), 'objects');
  mkdirSync(store, { recursive: true });
  const put = body => {
    writeFileSync(join(store, digest(body)), body);
    return digest(body);
  };
  const file = (i, n) => `${STRICT}test('t${i}', () => {\n  assert.equal(f(${i}), ${n});\n});\n`;
  const entries = n =>
    Array.from({ length: 210 }, (_, i) => ({
      path: `tests/f${i}.test.mjs`,
      blob: put(file(i, n)),
      mode: 'file',
    }));
  const state = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    message: 'base',
    at: '2026-11-19T00:00:00.000Z',
  };
  const base = put(JSON.stringify({ ...state, files: entries(1) }));
  const scan = laneWeakenedTests(reads, root, base, entries(2), () => undefined);
  assert.ok(scan.unchecked >= 10, `${scan.unchecked} files past the 200-file bound`);
  assert.deepEqual(scan.flags, [], 'a changed expected value is not a weakening');
  const reply = laneWeakenedTestsReply(reads, root, base, entries(2));
  assert.match(reply.notChecked, /^not checked: \d+ files$/);
  assert.equal(reply.count, 0);
  // A head file over the size bound is skipped, not read and flagged.
  const big = `${STRICT}test('t0', () => {\n  // ${'x'.repeat(1 << 20)}\n});\n`;
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests/f0.test.mjs'), big);
  const head = entries(1);
  head[0] = { path: 'tests/f0.test.mjs', blob: put(big), mode: 'file' };
  assert.equal(laneWeakenedTestsReply(reads, root, base, head), undefined);
});
