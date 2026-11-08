// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { conflictReasons } from '../dist/hosted-agent-resolution.js';
import {
  firstSyntaxProblem,
  syntaxConflictReason,
  SYNTAX_GATE_MAX_BYTES,
} from '../dist/native-merge-syntax.js';

const at = '2026-01-01T00:00:00.000Z';
const PATH = 'tests/agent-action-parse.test.mjs';
function plan(s, left, right) {
  const inputs = buildComposePages([
    {
      laneId: randomUUID(),
      head: right.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: right, recipe: null },
    },
  ]);
  const dependencies = buildComposePages([]);
  for (const p of [...inputs.pages, ...dependencies.pages]) s.put(saveBytes(p.value));
  return {
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: left.sha256, receiptId: 'main-0' },
    main: { object: left, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'Native review composition',
    at,
  };
}
// Synthetic stand-in for the measured case (batch run 5f2d241b): two Lanes fix the
// same bug with adjacent, non-overlapping insertions, and each declares `root`.
const base = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  "test('parses an action', t => {",
  "  const input = 'sync';",
  '  const result = parse(input);',
  "  assert.equal(result, 'sync');",
  '});',
  '',
];
const withLine = (after, line) => [...base.slice(0, after), line, ...base.slice(after)].join('\n');
const mainSide = withLine(4, '  const root = nativeHelpRoot(t);');
const laneSide = withLine(6, '  const root = neutralRoot();');
async function compose(s, path, baseText, leftText, rightText) {
  const root = s.state([s.file(path, baseText)]);
  const left = s.state([s.file(path, leftText)], [root.sha256]),
    right = s.state([s.file(path, rightText)], [root.sha256]);
  const output = await s.compute(plan(s, left, right));
  return { output, result: JSON.parse(output.manifest).result, root, left, right };
}
function pages(s, result) {
  const found = [];
  for (let next = result.conflicts; next;) {
    const page = JSON.parse(s.objects.get(next.sha256));
    found.push(...page.paths);
    next = page.next;
  }
  return found;
}

test('replay: adjacent edits that merge cleanly as text but declare root twice are a typed conflict', async () => {
  const s = await composeFixture();
  const { result, left, right } = await compose(s, PATH, base.join('\n'), mainSide, laneSide);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.paths, [PATH]);
  const [entry] = pages(s, result);
  assert.equal(entry.path, PATH);
  assert.match(
    entry.reason,
    /^composed tests\/agent-action-parse\.test\.mjs:\d+:\d+ does not parse although each side does: /,
  );
  assert.match(entry.reason, /'root'/);
  const line = Number(entry.reason.match(/mjs:(\d+):/)[1]);
  assert([5, 8].includes(line), 'points at a declaration of root');
  // Exact side variants are retained, so resolution and retry work as for a text conflict.
  assert.equal(s.objects.get(entry.left.blob).toString(), mainSide);
  assert.equal(s.objects.get(entry.right.blob).toString(), laneSide);
  assert.equal(s.objects.get(entry.base.blob).toString(), base.join('\n'));
  const page = JSON.parse(s.objects.get(result.conflicts.sha256));
  assert.equal(page.left, left.sha256);
  assert.equal(page.right, right.sha256);
});

test('a clean adjacent compose that still parses stays allowed', async () => {
  const s = await composeFixture();
  const { result, output } = await compose(
    s,
    PATH,
    base.join('\n'),
    mainSide,
    withLine(6, '  const lane = neutralRoot();'),
  );
  assert.equal(result.status, 'clean');
  const merged = JSON.parse(s.objects.get(output.head));
  const text = s.objects.get(merged.files.find(f => f.path === PATH).blob).toString();
  assert.match(text, /nativeHelpRoot/);
  assert.match(text, /neutralRoot/);
  assert.equal(await firstSyntaxProblem(PATH, Buffer.from(text)), null);
});

test('a file that already fails to parse on one side is left to the check, not blocked', async () => {
  for (const [name, brokenSide] of [
    ['main', 'left'],
    ['lane', 'right'],
  ]) {
    const s = await composeFixture();
    const broken = withLine(4, '  const root = ((;'),
      other = withLine(6, '  const root = neutralRoot();');
    const { result } = await compose(
      s,
      PATH,
      base.join('\n'),
      brokenSide === 'left' ? broken : mainSide,
      brokenSide === 'left' ? other : withLine(6, '  const root = ((;'),
    );
    assert.equal(result.status, 'clean', `${name} side already broken`);
    assert.notEqual(broken, other);
  }
});

test('an import that a top-level declaration then redeclares conflicts; other languages never do', async () => {
  const s = await composeFixture();
  const original = [
    "import { a } from './a.mjs';",
    '',
    'export const keep = 1;',
    '',
    'export const tail = 2;',
    '',
  ];
  const edit = (index, line) => [...original.slice(0, index), line, ...original.slice(index)].join('\n');
  const clash = await compose(
    s,
    'src/y.mjs',
    original.join('\n'),
    edit(1, "import { b } from './b.mjs';"),
    edit(5, 'export const b = 1;'),
  );
  assert.equal(clash.result.status, 'conflict');
  assert.match(
    pages(s, clash.result)[0].reason,
    /Import declaration conflicts with local declaration of 'b'/,
  );
  // Prose and unknown languages are not parsed.
  const notes = ['one', 'two', 'three', 'four', 'five', 'six', ''];
  const text = (index, line) => [...notes.slice(0, index), line, ...notes.slice(index)].join('\n');
  const prose = await compose(
    s,
    'notes.md',
    notes.join('\n'),
    text(1, 'const root = 1;'),
    text(5, 'const root = 2;'),
  );
  assert.equal(prose.result.status, 'clean');
});

test('syntax gate never blocks on size, language or a parser fault', async () => {
  const dup = Buffer.from("import t from 'x';\nconst a = 1;\nconst a = 2;\n"),
    ok = Buffer.from("import t from 'x';\nconst a = 1;\n");
  assert.match(await syntaxConflictReason('a.mjs', dup, ok, ok), /^composed a\.mjs:2:\d+ does not parse/);
  assert.equal(await syntaxConflictReason('a.txt', dup, ok, ok), null);
  assert.equal(await syntaxConflictReason('a.mjs', dup, dup, ok), null, 'one side already broken');
  assert.equal(await syntaxConflictReason('a.mjs', dup, ok, dup), null, 'other side already broken');
  const huge = Buffer.concat([dup, Buffer.alloc(SYNTAX_GATE_MAX_BYTES, 10)]);
  assert.equal(await syntaxConflictReason('a.mjs', huge, ok, ok), null, 'over the size bound is skipped');
  for (const path of ['a.js', 'a.cjs', 'a.ts', 'a.mts', 'a.tsx', 'a.jsx'])
    assert.notEqual(await syntaxConflictReason(path, dup, ok, ok), null, path);
});

test('a 50-file compose parses its merged files within budget', async t => {
  const s = await composeFixture();
  const files = Array.from({ length: 50 }, (_, i) => `src/module-${i}.ts`);
  const lines = i => [
    `import { helper${i} } from './helper-${i}.js';`,
    '',
    ...Array.from(
      { length: 300 },
      (_, n) => `export function f${n}(x: number): number { return helper${i}(x) + ${n}; }`,
    ),
    '',
  ];
  const text = (i, edits = []) => {
    const all = lines(i);
    for (const [at, line] of edits) all.splice(at, 0, line);
    return all.join('\n');
  };
  const root = s.state(files.map((p, i) => s.file(p, text(i))));
  // Lane one inserts after the import, Lane two near the end: 50 disjoint text merges.
  const left = s.state(
      files.map((p, i) => s.file(p, text(i, [[1, `export const one${i} = 1;`]]))),
      [root.sha256],
    ),
    right = s.state(
      files.map((p, i) => s.file(p, text(i, [[300, `export const two${i} = 2;`]]))),
      [root.sha256],
    );
  const started = performance.now();
  const output = await s.compute(plan(s, left, right));
  const elapsed = performance.now() - started;
  t.diagnostic(
    `50 text-merged files (${text(0).length} bytes each) composed and parsed in ${elapsed.toFixed(0)} ms`,
  );
  assert.equal(JSON.parse(output.manifest).result.status, 'clean');
  assert(elapsed < 10000, 'merged files are parsed within a loose budget');
});

test('recovery advice carries the retained reasons next to the conflicting paths', () => {
  assert.deepEqual(
    conflictReasons([
      { path: 'a.mjs', reason: 'composed a.mjs:2:7 does not parse although each side does: x' },
      { path: 'b.txt' },
    ]),
    [{ path: 'a.mjs', reason: 'composed a.mjs:2:7 does not parse although each side does: x' }],
  );
  assert.deepEqual(conflictReasons([{ path: 'b.txt' }]), []);
});

// Any-ecosystem gate (Issue 60ff8adb): Python, Java, Rust and JSON follow the JS rule.
test('a Python merge that breaks indentation is a syntax conflict', async () => {
  const s = await composeFixture();
  const original =
    'def check(value):\n    if value:\n        first = 1\n        second = 2\n    return value\n';
  // Each side deletes a different line of the `if` body; together they leave it empty.
  const { result } = await compose(
    s,
    'pkg/check.py',
    original,
    original.replace('        first = 1\n', ''),
    original.replace('        second = 2\n', ''),
  );
  assert.equal(result.status, 'conflict');
  assert.match(
    pages(s, result)[0].reason,
    /^composed pkg\/check\.py:3:\d+ does not parse although each side does: /,
  );
  // The same disjoint edits that keep the body parse stay clean.
  const clean = await compose(
    s,
    'pkg/check.py',
    original,
    original.replace('        first = 1\n', '        first = 10\n'),
    original.replace('        second = 2\n', '        second = 20\n'),
  );
  assert.equal(clean.result.status, 'clean');
});

test('Python statements at an indentation no open block uses are reported', async () => {
  const ok = Buffer.from('def f():\n    x = 1\n    return x\n');
  for (const broken of [
    'def f():\n    x = 1\n  y = 2\n    return x\n',
    'def f():\n    x = 1\n      y = 2\n    return x\n',
    'x = 1\n    y = 2\n',
  ])
    assert.match(
      (await syntaxConflictReason('a.py', Buffer.from(broken), ok, ok)) ?? '',
      /^composed a\.py:\d+:\d+ does not parse/,
      broken,
    );
  // Valid layouts: continuation lines, inline bodies, comments, decorators and match.
  const valid = [
    'x = (1,\n        2)\nif x: y = 1; z = 2\nelse:\n    pass\n  # comment\n',
    '@decorator\ndef f(\n    a,\n):\n    return a\n',
    'match x:\n    case 1:\n        pass\n    case _:\n        pass\n',
    'class A:\n\tdef f(self):\n\t\treturn """\n  text\n"""\n',
  ];
  for (const text of valid) assert.equal(await firstSyntaxProblem('a.py', Buffer.from(text)), null, text);
});

test('Java, Rust and JSON merges that no longer parse are conflicts; a side that already fails never blocks', async () => {
  const cases = [
    ['A.java', 'class A {\n  void f() {\n  }\n', 'class A {\n  void f() {}\n}\n'],
    ['src/lib.rs', 'fn a() {\n    let x = 1;\n', 'fn a() {\n    let x = 1;\n}\n'],
    ['package.json', '{\n  "a": 1\n  "b": 2\n}\n', '{\n  "a": 1\n}\n'],
  ];
  for (const [path, broken, ok] of cases) {
    const merged = Buffer.from(broken),
      side = Buffer.from(ok);
    assert.match(
      (await syntaxConflictReason(path, merged, side, side)) ?? '',
      /does not parse although each side does/,
      path,
    );
    assert.equal(await syntaxConflictReason(path, merged, merged, side), null, `${path}: left already fails`);
    assert.equal(
      await syntaxConflictReason(path, merged, side, merged),
      null,
      `${path}: right already fails`,
    );
  }
  // Go, YAML and TOML have no parser in the dependencies and are never blocked.
  for (const path of ['main.go', 'a.yaml', 'Cargo.toml'])
    assert.equal(
      await syntaxConflictReason(path, Buffer.from('{{{'), Buffer.from('x'), Buffer.from('x')),
      null,
      path,
    );
});
