// SPDX-License-Identifier: Apache-2.0
// The zoo run's generic choices (Issue 85d26a8b): probe files come from the tree shape alone,
// edits stay comments in every ecosystem, keep-both resolution and receipt reading. Synthetic trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLine,
  checkFacts,
  cliHead,
  controlCodeSource,
  preflightFacts,
  githubEquivalent,
  landPending,
  pickProbeFiles,
  probeLine,
  resolveKeepBoth,
  submodulePaths,
  summaryTable,
  tagLastLine,
} from '../scripts/bench-zoo/lib.mjs';
import { lastJson } from '../scripts/bench-zoo/exec.mjs';
import { resolutionFolder } from '../scripts/bench-zoo/run.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const f = (path, size = 100, extra = {}) => ({ path, size, ...extra });

test('probe files: two directories of the main source extension, tests and dot paths excluded', () => {
  const go = [
    f('README.md'),
    f('prometheus/counter.go'),
    f('prometheus/counter_test.go'),
    f('prometheus/promhttp/http.go'),
    f('api/client.go'),
    f('.github/x.go'),
    f('exp/api/remote/remote_api.go'),
  ];
  assert.deepEqual(pickProbeFiles(go), {
    ext: '.go',
    first: 'api/client.go',
    second: 'prometheus/counter.go',
  });
  const rust = [
    f('crates/core/main.rs'),
    f('crates/cli/src/lib.rs'),
    f('build.rs'),
    f('tests/feature.rs'),
    f('benches/b.rs'),
  ];
  assert.deepEqual(pickProbeFiles(rust), { ext: '.rs', first: 'build.rs', second: 'crates/core/main.rs' });
  const py = [
    f('tree_sitter/__init__.py'),
    f('tests/test_parser.py'),
    f('tree_sitter/binding/core.c'),
    f('setup.py'),
  ];
  assert.equal(pickProbeFiles(py).ext, '.py');
  assert.equal(pickProbeFiles(py).first, 'setup.py');
  assert.equal(pickProbeFiles(py).second, 'tree_sitter/__init__.py');
});

test('probe files skip symlinks, empty and huge files, and return null without source', () => {
  assert.equal(pickProbeFiles([f('README.md'), f('LICENSE')]), null);
  const picked = pickProbeFiles([
    f('a/x.kt', 100, { symlink: true }),
    f('b/y.kt', 0),
    f('c/z.kt', 10 << 20),
    f('d/w.kt'),
    f('e/v.kt'),
  ]);
  assert.deepEqual(picked, { ext: '.kt', first: 'd/w.kt', second: 'e/v.kt' });
});

test('probe line is a comment in the file language; append keeps a trailing newline', () => {
  assert.equal(probeLine('a/b.go', 'x'), '// forge-zoo probe x\n');
  assert.equal(probeLine('a/b.py', 'x'), '# forge-zoo probe x\n');
  assert.throws(() => probeLine('a/b.md', 'x'), /ZOO_NO_COMMENT_SYNTAX/);
  assert.equal(appendLine('a', 'b\n'), 'a\nb\n');
  assert.equal(appendLine('a\n', 'b\n'), 'a\nb\n');
  assert.equal(appendLine('', 'b\n'), 'b\n');
});

test('tagLastLine comments the last non-blank line, so two different tags conflict on one line', () => {
  assert.equal(tagLastLine('fn x() {\n}\n\n', 'a.rs', 'a'), 'fn x() {\n} // forge-zoo a\n\n');
  assert.equal(tagLastLine('x = 1', 'a.py', 'b'), 'x = 1 # forge-zoo b');
  assert.throws(() => tagLastLine('\n\n', 'a.go', 'a'), /ZOO_EMPTY_FILE/);
  assert.throws(() => tagLastLine('x', 'a.md', 'a'), /ZOO_NO_COMMENT_SYNTAX/);
});

test('keep-both resolution removes markers and the diff3 base, keeping ours then theirs', () => {
  const text = 'x\n<<<<<<< ours\n// a\n||||||| base\n=======\n// b\n>>>>>>> theirs\ny\n';
  assert.equal(resolveKeepBoth(text), 'x\n// a\n// b\ny\n');
  assert.equal(resolveKeepBoth('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n'), 'a\nb\n');
  assert.equal(
    resolveKeepBoth('x\n<<<<<<< ours\n} // forge-zoo b\n=======\n} // forge-zoo a\n>>>>>>> main\n'),
    'x\n} // forge-zoo b // forge-zoo a\n',
  );
  assert.throws(() => resolveKeepBoth('no markers\n'), /ZOO_NO_CONFLICT_MARKERS/);
  assert.throws(() => resolveKeepBoth('<<<<<<< a\nx\n'), /ZOO_UNTERMINATED_CONFLICT/);
});

test('checkFacts reads run ids, scope, reuse, CI time and conflicts wherever the receipt holds them', () => {
  const receipt = {
    result: {
      submission: {
        check: { runId: 'r1', plan: { scope: 'full', reason: 'Exact configured command' } },
        timing: { ciObservedAt: '2026-11-08T10:00:00Z', ciEndedAt: '2026-11-08T10:02:30Z' },
        reuse: { reused: true, runId: 'r0' },
      },
      conflicts: [{ path: 'a/b.go' }, 'c.go'],
    },
  };
  const facts = checkFacts(receipt);
  assert.deepEqual(facts.runIds, ['r1', 'r0']);
  assert.deepEqual(facts.scopes, ['full']);
  assert.equal(facts.reused, true);
  assert.equal(facts.ciSeconds, 150);
  assert.deepEqual(facts.conflictPaths, ['a/b.go', 'c.go']);
  assert.equal(checkFacts({ error: { code: 'LANDING_CONFLICT' } }).error, 'LANDING_CONFLICT');
  assert.equal(checkFacts(null).error, null);
});

test('GitHub-equivalent minutes: one full run per pushed PR head and per merge', () => {
  assert.deepEqual(githubEquivalent({ fullRunSeconds: 120, prPushes: 4, merges: 3 }), {
    runs: 7,
    minutes: 14,
  });
  assert.equal(githubEquivalent({ fullRunSeconds: undefined, prPushes: 1, merges: 1 }), null);
});

test('lastJson takes the last JSON line; resolutionFolder finds the folder holding markers', () => {
  assert.deepEqual(lastJson('note\n{"a":1}\nnot json\n{"b":2}\n'), { b: 2 });
  assert.equal(lastJson('nothing'), null);
  const dir = mkdtempSync(join(tmpdir(), 'zoo-'));
  try {
    const lane = join(dir, 'lane'),
      res = join(dir, '3f2b0c1e-0000-4000-8000-000000000000');
    mkdirSync(join(lane, 'p'), { recursive: true });
    mkdirSync(join(res, 'p'), { recursive: true });
    writeFileSync(join(lane, 'p/x.go'), '// a\n');
    writeFileSync(join(res, 'p/x.go'), '<<<<<<< ours\n// a\n=======\n// b\n>>>>>>> main\n');
    const found = resolutionFolder({ json: { recovery: { root: res } }, stderr: '' }, lane, 'p/x.go');
    assert.deepEqual(found, { path: res, laneId: '3f2b0c1e-0000-4000-8000-000000000000' });
    assert.equal(resolutionFolder({ json: {}, stderr: '' }, lane, 'p/x.go'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary table lists Forge next to git and the refusal when Forge did not run', () => {
  const md = summaryTable([
    {
      id: 'go',
      steps: {
        clone: { forge: { ok: true, seconds: 9.96 }, git: { seconds: 1.2 } },
        land: { forge: { ok: false, refusal: 'skipped: no runner' } },
      },
    },
  ]);
  assert.match(md, /\| go \| clone \| 10 \| 1\.2 \| ok \|/);
  assert.match(md, /\| go \| land \| – \| – \| skipped: no runner \|/);
});

test('cliHead reads the installed CLI build id and ignores anything else', () => {
  const head = 'e4a6f011acf7f97b8f18970d9e03abb0c3b20ea5d70ecb26d776272cff039e49';
  assert.equal(cliHead(JSON.stringify({ release: 7, head, at: 'x' })), head);
  assert.equal(cliHead('{"release":7}'), null);
  assert.equal(cliHead(JSON.stringify({ head: 'not hex!' })), null);
  assert.equal(cliHead('not json'), null);
});

test('an asynchronous SUBMITTED land (exit 0, inProgress) is followed by the wait; a settled one is not', () => {
  assert.equal(landPending({ code: 3, json: null }), true);
  assert.equal(landPending({ code: 0, json: { result: { phase: 'finish', inProgress: true } } }), true);
  assert.equal(landPending({ code: 0, json: { result: { status: 'terminal', successful: false } } }), false);
  assert.equal(landPending({ code: 1, json: null }), false);
});

test('wave-2 ecosystems: probe files and comment syntax (C#, Swift, Elixir, Ruby, PHP, Dart, Zig, C++)', () => {
  const pick = paths => pickProbeFiles(paths.map(p => f(p)));
  assert.deepEqual(pick(['src/G/Guard.cs', 'src/G/Extra/Ext.cs', 'test/G.UnitTests/GuardTests.cs']), {
    ext: '.cs',
    first: 'src/G/Guard.cs',
    second: 'src/G/Extra/Ext.cs',
  });
  assert.deepEqual(
    pick(['Sources/AP/Parsable.swift', 'Sources/Other/B.swift', 'Tests/APUnitTests/AUnitTests.swift']),
    { ext: '.swift', first: 'Sources/AP/Parsable.swift', second: 'Sources/Other/B.swift' },
  );
  assert.equal(pick(['lib/plug/conn.ex', 'lib/plug.ex', 'test/plug_test.exs']).ext, '.ex');
  assert.equal(pick(['lib/sinatra/base.rb', 'lib/sinatra.rb', 'spec/base_spec.rb']).first, 'lib/sinatra.rb');
  assert.equal(pick(['src/Utils.php', 'tests/UtilsTest.php']).second, 'tests/UtilsTest.php');
  assert.equal(
    pick(['lib/src/equatable.dart', 'test/equatable_test.dart']).second,
    'test/equatable_test.dart',
  );
  assert.equal(pick(['clap.zig', 'clap/args.zig', 'example/simple.zig']).second, 'clap/args.zig');
  assert.equal(
    pick(['include/fmt/core.h', 'include/fmt/format.h', 'src/format.cc', 'test/format-test.cc']).ext,
    '.h',
  );
  for (const [file, mark] of [
    ['a.cs', '//'],
    ['a.swift', '//'],
    ['a.dart', '//'],
    ['a.php', '//'],
    ['a.zig', '//'],
    ['a.hpp', '//'],
    ['a.ex', '#'],
    ['a.exs', '#'],
  ])
    assert.equal(probeLine(file, 'x'), `${mark} forge-zoo probe x\n`);
});

test('preflightFacts reads the land receipt selection; controlCodeSource reads the control checkout', () => {
  const receipt = {
    result: {
      preflight: { status: 'advised', selected: ['package:.:swift test'], tests: 1, estimateMinutes: 2 },
    },
  };
  assert.deepEqual(preflightFacts(receipt), {
    status: 'advised',
    selected: ['package:.:swift test'],
    tests: 1,
    estimateMinutes: 2,
    reason: null,
  });
  assert.equal(preflightFacts({ result: {} }), null);
  const own =
    '      - uses: actions/checkout@v4\n        with:\n          path: control\n          ref: ${{ github.sha }}\n          persist-credentials: false\n';
  assert.deepEqual(controlCodeSource(own), {
    repository: 'the runner repository itself',
    ref: '${{ github.sha }}',
    byDigest: false,
  });
  const sha = 'a'.repeat(40);
  const pinned = `      - uses: actions/checkout@v4\n        with:\n          repository: NanthAI/nanthai-forge\n          path: control\n          ref: ${sha}\n`;
  assert.deepEqual(controlCodeSource(pinned), {
    repository: 'NanthAI/nanthai-forge',
    ref: sha,
    byDigest: true,
  });
  assert.equal(controlCodeSource('jobs: {}'), null);
});

test('a one-module library (one source file plus its tests) still gets a second probe file', () => {
  const picked = pickProbeFiles([f('index.js'), f('test.js'), f('fixtures/fixture-cwd.js'), f('readme.md')]);
  assert.deepEqual(picked, { ext: '.js', first: 'index.js', second: 'test.js' });
  assert.equal(pickProbeFiles([f('a.js'), f('b.spec.js')]).second, 'b.spec.js');
  assert.equal(pickProbeFiles([f('src/a.js'), f('src/b.js'), f('test.js')]).second, 'src/b.js');
});

test('preflightFacts reads the plan of a preflight action receipt', () => {
  const receipt = {
    result: {
      plan: {
        status: 'planned',
        scope: 'scoped',
        tests: ['test.js'],
        estimateMinutes: 1,
        reason: 'project test runner node: 1 changed test file(s)',
      },
    },
  };
  assert.deepEqual(preflightFacts(receipt), {
    status: 'planned',
    scope: 'scoped',
    selected: ['test.js'],
    tests: 1,
    estimateMinutes: 1,
    reason: 'project test runner node: 1 changed test file(s)',
  });
});

test('submodule paths come from .gitmodules, so probes never land inside another repository', () => {
  const text =
    '[submodule "core"]\n\tpath = tree_sitter/core\n\turl = https://x\n[submodule "b"]\n  path=vendor/b/\n';
  assert.deepEqual(submodulePaths(text), ['tree_sitter/core', 'vendor/b']);
  assert.deepEqual(submodulePaths(''), []);
});

test('tagLastLine skips a last line too long to take a trailing comment inside a formatter limit', () => {
  const long = `internal expect fun StringBuilder.appendCodePoint(codePoint: CodePoint): StringBuilder`;
  assert.equal(
    tagLastLine(`a\nfun short() {}\n${long}\n`, 'x.kt', 'a'),
    `a\nfun short() {} // forge-zoo a\n${long}\n`,
  );
  // Two tags on the same text still hit the same line, so the conflict stays forced.
  const text = `x = 1\n${long}\n`;
  assert.equal(tagLastLine(text, 'x.py', 'a').split('\n')[0].endsWith('forge-zoo a'), true);
  assert.equal(tagLastLine(long, 'x.kt', 'b'), `${long} // forge-zoo b`);
});
