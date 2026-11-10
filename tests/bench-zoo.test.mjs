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
  tagLastLine,
  thrownRefusal,
} from '../scripts/bench-zoo/lib.mjs';
import { lastJson } from '../scripts/bench-zoo/exec.mjs';
import { resolutionFolder, sourceCommand } from '../scripts/bench-zoo/run.mjs';
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
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
    f('a/caf\ufffd.kt'), // not valid UTF-8: never addressable on both sides
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

// Issue 70a9bd2f: the conformance suite's generic rules. Synthetic data only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { compareTrees, platformLimits, walkTree } from '../scripts/bench-zoo/fidelity.mjs';
import { buildRepository, recipes } from '../scripts/bench-zoo/shapes.mjs';
import { latestResults } from '../scripts/bench-zoo/suite.mjs';
import {
  PATHS,
  baselineOf,
  ciScript,
  commitGaps,
  compareToBaseline,
  pathVerdicts,
  runEntry,
  suiteMarkdown,
  summarize,
  validateCatalog,
  workspacePrep,
  zooWorkflow,
} from '../scripts/bench-zoo/suite-lib.mjs';

const catalog = JSON.parse(
  readFileSync(new URL('../scripts/bench-zoo/catalog.json', import.meta.url), 'utf8'),
);

test('the catalog holds 20-30 repositories and covers every required shape', () => {
  assert.deepEqual(validateCatalog(catalog), []);
  const dropped = { ...catalog, repos: catalog.repos.filter(r => r.id !== 'shapes-nonutf8') };
  assert.match(validateCatalog(dropped).join(';'), /non-utf-8 paths/);
  assert.match(
    validateCatalog({ ...catalog, repos: catalog.repos.slice(0, 5) }).join(';'),
    /20-30 repositories/,
  );
});

test('every catalog entry yields a check script and a run entry; toolchains only when declared', () => {
  const shapes = recipes();
  for (const entry of catalog.repos) {
    assert.match(ciScript(entry, shapes), /^#!\/usr\/bin\/env bash\n.*\nset -euo pipefail\n.+/s);
    assert.equal(runEntry(entry).fork, `NanthAI/bench-zoo-${entry.id}`);
  }
  const dart = catalog.repos.find(r => r.id === 'dart');
  assert.deepEqual(runEntry(dart).check.actionsToolchains, [{ tool: 'dart', version: 'stable' }]);
  assert.equal(runEntry(catalog.repos.find(r => r.id === 'go')).check, undefined);
  assert.match(zooWorkflow('      - uses: x\n'), /- uses: x\n      - run: bash \.forge-zoo\/ci\.sh/);
});

test('the synthetic recipes write modes, symlinks, CRLF and a raw Latin-1 path that a file system could not hold', () => {
  const shapes = recipes();
  const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, maxBuffer: 1 << 26 });
  const posix = buildRepository(shapes.posix, []);
  const nonutf8 = buildRepository(shapes.nonutf8, []);
  const bigbin = buildRepository({ ...shapes.bigbin, commits: [shapes.bigbin.commits[0].slice(0, 2)] }, []);
  try {
    const tree = git(posix.dir, 'ls-tree', '-r', 'main').toString();
    assert.match(tree, /^100755 blob \w+\tbin\/run\.sh$/m);
    assert.match(tree, /^120000 blob \w+\tlink-dangling$/m);
    assert.match(git(posix.dir, 'show', 'main:src/beta/util.py').toString(), /\r\n/);
    assert.equal(git(posix.dir, 'log', '--format=%s', 'main').toString().trim().split('\n').length, 4);
    const raw = git(nonutf8.dir, 'ls-tree', '-r', '-z', '--name-only', 'main');
    assert.ok(
      raw.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x70, 0x79])),
      'raw 0xE9 byte in the path',
    );
    assert.equal(git(bigbin.dir, 'ls-tree', '-r', 'main').toString().split('\n').filter(Boolean).length, 2);
  } finally {
    for (const r of [posix, nonutf8, bigbin]) rmSync(r.dir, { recursive: true, force: true });
  }
});

test('tree fidelity: Forge clone against git checkout flags a missing file, a lost mode, a CRLF size change and a changed link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zoo-fidelity-'));
  try {
    const make = (name, edit) => {
      const root = join(dir, name);
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, '.forge'));
      writeFileSync(join(root, 'src/a.txt'), 'one\r\ntwo\r\n');
      writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(join(root, 'keep.txt'), 'k');
      symlinkSync('src/a.txt', join(root, 'link'));
      // A name that is not valid UTF-8 (git can write one on some volumes) is read as bytes, not lost.
      try {
        writeFileSync(
          Buffer.concat([Buffer.from(`${root}/src/caf`), Buffer.from([0xe9]), Buffer.from('.py')]),
          'x',
        );
      } catch {
        /* this volume refuses such names (EILSEQ); the tree simply lacks the file */
      }
      edit?.(root);
      return walkTree(root);
    };
    const git = make('git');
    assert.equal(git.has('.forge'), false);
    assert.deepEqual(compareTrees(git, make('same')).counts, {
      missing: 0,
      extra: 0,
      kind: 0,
      size: 0,
      target: 0,
    });
    const bad = compareTrees(
      git,
      make('bad', root => {
        rmSync(join(root, 'keep.txt'));
        chmodSync(join(root, 'run.sh'), 0o644);
        writeFileSync(join(root, 'src/a.txt'), 'one\ntwo\n');
        rmSync(join(root, 'link'));
        symlinkSync('keep.txt', join(root, 'link'));
        writeFileSync(join(root, 'stray.txt'), 'x');
      }),
    );
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.counts, { missing: 1, extra: 1, kind: 1, size: 1, target: 1 });
    assert.deepEqual(bad.examples.kind, ['run.sh (exec -> file)']);
    // A path git itself could not write here is a platform limit, never a Forge fault.
    assert.deepEqual(
      platformLimits(
        '100644 blob abc\tsrc/a.txt\u0000100644 blob abc\tcaf\ufffd.py\u0000160000 commit abc\tmod\u0000',
        git,
      ),
      ['caf\ufffd.py'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const step = (forge, git) => ({
  forge: { ok: true, ...forge },
  ...(git ? { git: { ok: true, ...git } } : {}),
});
const passing = () => ({
  id: 'x',
  fidelity: { ok: true },
  steps: {
    import: step({ seconds: 20 }, { seconds: 1 }),
    clone: step({ seconds: 3 }, { seconds: 1 }),
    start: step({ seconds: 4 }),
    save: step({ seconds: 5 }, { seconds: 1 }),
    sync: step({ seconds: 6 }, { seconds: 1 }),
    land: step({ seconds: 90 }, { seconds: 2 }),
    landReuse: step({ seconds: 70 }, { seconds: 2 }),
    conflict: step({ seconds: 12 }, { seconds: 1 }),
    resolve: step({ seconds: 80 }, { seconds: 2 }),
  },
  runs: [{ runId: 'r1', endedAt: '2026-11-10T10:01:00Z', executionSeconds: 30 }],
  landings: [{ lane: 'a', checkRunIds: ['r1'], committedAt: '2026-11-10T10:01:09Z' }],
  forgeChecks: { jobs: 1, jobSeconds: 50 },
});

test('a land that exits 0 with a terminal CHECK_FAILED is a failed path, and later paths are not reached', () => {
  const ok = summarize(passing());
  assert.equal(ok.pass, true);
  const failed = passing();
  failed.steps.land.forge.error = 'CHECK_FAILED';
  delete failed.steps.resolve;
  const v = pathVerdicts(failed);
  assert.deepEqual([v.land.v, v.land.why, v.resolve.v], ['fail', 'CHECK_FAILED', 'skip']);
  assert.equal(summarize(failed).pass, false);
  assert.equal(pathVerdicts({ id: 'y', steps: {}, crash: 'Error: boom\n at x' }).crash.why, 'Error: boom');
  // An import refusal is an object ({code, message}); the report names its code.
  const refused = pathVerdicts({
    id: 'z',
    steps: { import: { forge: { ok: false, error: { code: 'GITHUB_LFS_OBJECT_MISSING' } } } },
  });
  assert.deepEqual(refused.import, { v: 'fail', why: 'GITHUB_LFS_OBJECT_MISSING' });
});

test('a hazard repository passes by a named clone refusal; a plain repository that is refused fails', () => {
  const refused = {
    id: 'shapes-collide',
    steps: { import: step({ seconds: 14 }) },
    refusals: [{ where: 'clone', code: 'INVALID_NATIVE_SOURCE' }],
  };
  const hazard = summarize(refused, { hazard: true });
  assert.equal(hazard.paths.clone.v, 'refused');
  assert.equal(hazard.pass, true);
  assert.equal(summarize(refused, {}).pass, false);
  const baseline = baselineOf([hazard]);
  assert.deepEqual(compareToBaseline([hazard], baseline), []);
  const broke = summarize({ ...refused, refusals: [] }, { hazard: true });
  assert.deepEqual(
    compareToBaseline([broke], baseline).map(x => `${x.op}:${x.was}->${x.now}`),
    ['clone:refused->skip'],
  );
  // Issue 6a0dd2e8: a non-UTF-8 path is refused at import by name; the scenario ends there.
  // The generic IMPORT_FAILED (no code from the import) never counts as a named refusal.
  const atImport = {
    id: 'shapes-nonutf8',
    steps: { import: { forge: { ok: false, error: { code: 'GITHUB_SOURCE_UNSUPPORTED' } } } },
    refusals: [{ where: 'import', code: 'GITHUB_SOURCE_UNSUPPORTED' }],
  };
  const nonutf8 = summarize(atImport, { hazard: true });
  assert.deepEqual([nonutf8.paths.import.v, nonutf8.paths.clone.v, nonutf8.pass], ['refused', 'skip', true]);
  assert.equal(summarize(atImport, {}).pass, false);
  const unnamed = { ...atImport, refusals: [{ where: 'import', code: 'IMPORT_FAILED' }] };
  assert.equal(summarize(unnamed, { hazard: true }).pass, false);
  for (const op of ['import', 'clone'])
    for (const code of [
      'AUTH_REQUIRED',
      'GITHUB_RATE_LIMIT',
      'SOMETHING_UNKNOWN',
      op === 'import' ? 'INVALID_NATIVE_SOURCE' : 'GITHUB_SOURCE_UNSUPPORTED',
    ]) {
      const unrelated = {
        id: 'hazard',
        steps: { [op]: { forge: { ok: false, error: { code } } } },
        refusals: [{ where: op, code }],
      };
      assert.equal(summarize(unrelated, { hazard: true }).pass, false, `${op}:${code}`);
    }
  // The refusal reaches the harness as a thrown ConvexError: its code is read, other errors are not.
  const refusal = { code: 'GITHUB_SOURCE_UNSUPPORTED', message: 'names src/caf\\uFFFD.py' };
  assert.deepEqual(
    thrownRefusal(Object.assign(new Error('Server Error'), { data: JSON.stringify(refusal) })),
    refusal,
  );
  assert.deepEqual(
    thrownRefusal(
      new Error(
        `[Request ID: x] Server Error\nUncaught ConvexError: ${JSON.stringify(refusal)}\n    at handler`,
      ),
    ),
    refusal,
  );
  assert.equal(thrownRefusal(new Error('fetch failed')), null);
});

test('the result-to-commit gap is the time from the last check run end to the commit; prep reads start, clone and job overhead', () => {
  assert.deepEqual(commitGaps(passing()), [{ lane: 'a', seconds: 9 }]);
  assert.deepEqual(workspacePrep(passing()), { startSeconds: 4, cloneSeconds: 3, jobOverheadSeconds: 20 });
  assert.deepEqual(workspacePrep({ id: 'z', steps: {} }), {
    startSeconds: null,
    cloneSeconds: null,
    jobOverheadSeconds: null,
  });
});

test('baseline comparison reports a path that stopped passing and a much slower operation, not noise', () => {
  const rows = [summarize(passing())];
  const baseline = baselineOf(rows, { stamp: 's' });
  assert.deepEqual(compareToBaseline(rows, baseline), []);
  const worse = passing();
  worse.steps.sync.forge.seconds = 40;
  worse.steps.save.forge.seconds = 8;
  worse.steps.conflict.forge.ok = false;
  const regressions = compareToBaseline([summarize(worse)], baseline);
  assert.deepEqual(regressions.map(r => `${r.kind}:${r.op}`).sort(), ['path:conflict', 'seconds:sync']);
  assert.deepEqual(compareToBaseline([{ ...summarize(worse), id: 'new-repo' }], baseline), []);
  const md = suiteMarkdown(rows, { stamp: 's' });
  assert.match(md, /1 of 1 repositories pass every path/);
  assert.match(md, new RegExp(`\\| x \\| ${PATHS.map(() => '✓').join(' \\| ')} \\|`));
  assert.match(md, /\| land \| 90 \| 2 \| 45 \| 1 \|/);
});

test('the report takes the newest result per repository across run folders', () => {
  const root = mkdtempSync(join(tmpdir(), 'zoo-root-'));
  try {
    for (const [stamp, ids] of [
      ['20261110T010000', ['a', 'b']],
      ['20261110T020000', ['b']],
    ]) {
      mkdirSync(join(root, 'runs', stamp), { recursive: true });
      writeFileSync(
        join(root, 'runs', stamp, 'RESULT.json'),
        JSON.stringify({ cliCommits: [stamp], results: ids.map(id => ({ id })) }),
      );
    }
    assert.deepEqual(
      latestResults(root).map(r => `${r.id}@${r.stamp}`),
      ['a@20261110T010000', 'b@20261110T020000'],
    );
    assert.deepEqual(
      latestResults(root, '20261110T010000').map(r => r.id),
      ['a', 'b'],
    );
    // A full run on a project a --prepare-only pass imported keeps that pass's import timing.
    mkdirSync(join(root, 'runs', '20261110T030000'), { recursive: true });
    writeFileSync(
      join(root, 'runs', '20261110T010000', 'RESULT.json'),
      JSON.stringify({
        results: [{ id: 'a', projectId: 'p', steps: { import: { forge: { seconds: 20 } } } }],
      }),
    );
    writeFileSync(
      join(root, 'runs', '20261110T030000', 'RESULT.json'),
      JSON.stringify({ results: [{ id: 'a', projectId: 'p', steps: { clone: { forge: { seconds: 2 } } } }] }),
    );
    assert.deepEqual(Object.keys(latestResults(root).find(r => r.id === 'a').steps).sort(), [
      'clone',
      'import',
    ]);
    // ...even when an earlier full run of the same project crashed before it recorded any step.
    mkdirSync(join(root, 'runs', '20261110T025000'), { recursive: true });
    writeFileSync(
      join(root, 'runs', '20261110T025000', 'RESULT.json'),
      JSON.stringify({ results: [{ id: 'a', projectId: 'p', crash: 'boom' }] }),
    );
    assert.equal(latestResults(root).find(r => r.id === 'a').steps.import.forge.seconds, 20);
    // An interrupted run keeps the repositories that ended, one file each.
    rmSync(join(root, 'runs', '20261110T030000', 'RESULT.json'));
    writeFileSync(join(root, 'runs', '20261110T030000', 'c.result.json'), JSON.stringify({ id: 'c' }));
    assert.deepEqual(
      latestResults(root).map(r => r.id),
      ['a', 'b', 'c'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Issue 70a9bd2f: the machine is shared; no repository of the suite starts under the disk reserve.
import { waitForDisk } from '../scripts/bench-zoo/exec.mjs';

test('a repository waits for the disk reserve and the run stops when it never returns', async () => {
  const readings = [16, 19, 23];
  let reads = 0;
  await waitForDisk(22, { pollMs: 0, free: () => readings[Math.min(reads++, readings.length - 1)] });
  assert.equal(reads, 3, 'polled until 23 GiB were free, no longer');
  await assert.rejects(waitForDisk(22, { pollMs: 0, timeoutMs: -1, free: () => 10 }), /ZOO_DISK_RESERVE/);
});

import { teardown } from '../scripts/bench-zoo/teardown.mjs';

test('zoo teardown deletes suffixed and forgotten imports by their exact current slugs and retains purge receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zoo-teardown-'));
  try {
    writeFileSync(join(root, 'zoo.json'), JSON.stringify({ deployment: 'https://example.invalid' }));
    writeFileSync(join(root, 'state.json'), JSON.stringify({ repos: { go: { projectId: 'new' } } }));
    const gone = [];
    const result = await teardown(root, [{ id: 'go', fork: 'example/zoo-go' }], {
      projectsOnly: true,
      list: async () => [
        { id: 'old', name: 'bench-zoo-go', slug: 'bench-zoo-go' },
        { id: 'new', name: 'bench-zoo-go', slug: 'bench-zoo-go-2' },
        { id: 'other', name: 'bench-zoo-python', slug: 'bench-zoo-python' },
      ],
      run: async (cmd, args) => {
        const projectId = args[args.indexOf('--delete-project') + 1];
        const slug = args[args.indexOf('--confirm') + 1];
        gone.push([projectId, slug]);
        return { code: 0, json: { projectId, operationId: `op-${projectId}`, purgeComplete: true } };
      },
    });
    assert.deepEqual(gone, [
      ['old', 'bench-zoo-go'],
      ['new', 'bench-zoo-go-2'],
    ]);
    assert.equal(
      result.every(r => r.project === 'deleted'),
      true,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).repos, {});
    const journal = JSON.parse(readFileSync(join(root, 'teardown.json'), 'utf8'));
    assert.equal(journal.new.receipt.operationId, 'op-new');
    assert.equal(journal.new.confirmed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zoo teardown reconciles pending purges with the same slug and keeps state until completion is confirmed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zoo-teardown-'));
  try {
    writeFileSync(join(root, 'zoo.json'), JSON.stringify({ deployment: 'https://example.invalid' }));
    const state = { repos: { go: { projectId: 'p' } } };
    writeFileSync(join(root, 'state.json'), JSON.stringify(state));
    writeFileSync(join(root, 'teardown.json'), JSON.stringify({ p: { slug: 'bench-zoo-go-2' } }));
    const replies = [
      { code: 1, stderr: 'HOST_DELETE_PENDING', stdout: '' },
      { code: 0, json: { purgeComplete: false }, stdout: '{}', stderr: '' },
    ];
    const calls = [];
    const result = await teardown(root, [{ id: 'go' }], {
      projectsOnly: true,
      list: async () => [{ id: 'p', removal: 'deleting' }],
      sleep: async () => {},
      run: async (cmd, args) => {
        calls.push(args);
        return replies.shift();
      },
    });
    assert.deepEqual(calls[0], calls[1], 'pending purge retries the exact confirmed identity');
    assert.match(result[0].project, /NOT DELETED/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')), state);
    const tombstone = await teardown(root, [{ id: 'go' }], {
      projectsOnly: true,
      list: async () => [{ id: 'p', removal: 'deleted' }],
      run: async () => {
        throw Error('a confirmed tombstone needs no deletion call');
      },
    });
    assert.equal(tombstone[0].project, 'deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zoo teardown starts every purge before waiting for upload leases, avoiding serial lease waits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zoo-teardown-'));
  try {
    writeFileSync(join(root, 'zoo.json'), JSON.stringify({ deployment: 'https://example.invalid' }));
    const started = new Set();
    const result = await teardown(root, [{ id: 'go' }, { id: 'python' }], {
      projectsOnly: true,
      list: async () =>
        ['go', 'python'].map(id => ({ id, name: `bench-zoo-${id}`, slug: `bench-zoo-${id}-2` })),
      sleep: async () => {
        assert.deepEqual([...started], ['go', 'python']);
      },
      run: async (cmd, args) => {
        const id = args[args.indexOf('--delete-project') + 1];
        if (!started.has(id)) {
          started.add(id);
          return { code: 1, stdout: '', stderr: 'HOST_DELETE_PENDING' };
        }
        return { code: 0, json: { purgeComplete: true }, stdout: '', stderr: '' };
      },
    });
    assert.equal(
      result.every(r => r.project === 'deleted'),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { importAfterReset, makeIo } from '../scripts/bench-zoo/io.mjs';

test('zoo imports retain provider-reset setup voids and wait locally before resuming the same operation', async () => {
  let clock = 0;
  const resumes = [],
    waits = [],
    observed = [];
  const result = await importAfterReset({
    now: () => clock,
    sleep: async ms => {
      waits.push(ms);
      clock += ms;
    },
    observe: event => observed.push(event),
    attempt: async ({ resume }) => {
      resumes.push(resume);
      clock += 10;
      if (resumes.length === 1)
        throw Object.assign(Error('provider'), {
          data: { code: 'GITHUB_RATE_LIMIT', message: 'reset', retryAt: 70_000 },
        });
      if (resumes.length === 2)
        return { phase: 'error', error: { code: 'GITHUB_RATE_LIMIT', retryAt: 80_000 } };
      return { phase: 'ready', projectId: 'same-project' };
    },
  });
  assert.deepEqual(resumes, [false, true, true]);
  assert.deepEqual(waits, [60_000, 9_990, 9_990]);
  assert.equal(result.projectId, 'same-project');
  assert.equal(result.seconds, 0.01);
  assert.equal(result.wallSeconds, 80.01);
  assert.deepEqual(
    result.setupVoids.map(v => v.waitSeconds),
    [69.99, 9.99],
  );
  assert.equal(observed.length, 2);
});

test('zoo healthy imports make one attempt, and non-rate refusals and unknown errors are never retried', async () => {
  let calls = 0;
  const sleep = async () => {
    throw Error('unexpected wait');
  };
  const result = await importAfterReset({
    sleep,
    attempt: async () => {
      calls++;
      return { phase: 'ready' };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.setupVoids, []);
  const refusal = {
    phase: 'error',
    error: { code: 'GITHUB_SOURCE_UNSUPPORTED', retryAt: Date.now() + 1000 },
  };
  assert.equal((await importAfterReset({ sleep, attempt: async () => refusal })).error, refusal.error);
  await assert.rejects(
    importAfterReset({
      sleep,
      attempt: async () => {
        throw Error('network');
      },
    }),
    /network/,
  );
});

test('zoo stored-job recovery resumes its pinned import and never creates a second project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zoo-import-reset-'));
  try {
    const { importProject } = await import('../scripts/bench-t3code/forge-import.mjs');
    let clock = 0,
      ready = false;
    const projects = new Map();
    const backend = {
      setAuth() {},
      async action(name, args) {
        if (name === 'projectGithubImport:start') {
          const request = JSON.stringify([args.url, args.ref, args.name]);
          if (projects.has(args.operationId)) {
            assert.equal(projects.get(args.operationId), request, 'retry keeps its original source');
            ready = true;
          } else projects.set(args.operationId, request);
          return 'original-job';
        }
        assert.equal(args.id, 'original-job');
        return {
          phase: ready ? 'ready' : 'error',
          projectId: 'original-project',
          error: ready ? null : { code: 'GITHUB_RATE_LIMIT', retryAt: 70_000 },
        };
      },
    };
    const load = async (checkout, path) => {
      if (path.includes('forge-import')) return { importProject };
      if (path.includes('auth-store')) return { resolveAuthToken: () => 'synthetic-token' };
      if (path.includes('network-convex-client')) return { deadlineConvexClient: () => backend };
      return { makeFunctionReference: name => name };
    };
    const io = makeIo({
      cfg: { forgeCheckout: 'synthetic', deployment: 'https://example.invalid' },
      root,
      runDir: root,
      state: { repos: {} },
      statePath: join(root, 'state.json'),
      load,
      importClock: () => clock,
      importSleep: async ms => {
        clock += ms;
      },
    });
    const result = await io.importProject(
      { id: 'fixture', fork: 'example/public', ref: 'main' },
      join(root, 'journal.json'),
    );
    assert.equal(result.phase, 'ready');
    assert.equal(result.projectId, 'original-project');
    assert.equal(projects.size, 1, 'the failed stored import owns the sole created project');
    assert.equal(result.setupVoids.length, 1);
    const raw = passing();
    Object.assign(raw.steps.import.forge, result);
    const row = summarize(raw);
    assert.equal(row.importWallSeconds, 70);
    assert.equal(row.seconds.import.forge, 70, 'provider waits remain in end-to-end import timing');
    assert.equal(
      compareToBaseline([row], baselineOf([summarize(passing())])).some(
        r => r.kind === 'seconds' && r.op === 'import',
      ),
      true,
      'the regression guard cannot hide a slow import behind a fast successful retry',
    );
    assert.equal(row.importSetupVoids[0].waitSeconds, 70);
    assert.match(suiteMarkdown([row]), /GITHUB_RATE_LIMIT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('timed-out source resolution reconciles its original operation before returning, including all wall time', async () => {
  const operationId = '17adac72-808e-4f79-a2c7-ce9f2ac51f06';
  const calls = [],
    receipts = [];
  const replies = [
    { code: 3, seconds: 30, stderr: 'timeout', json: { error: { code: 'EXCHANGE_REQUEST_TIMEOUT' } } },
    { code: 0, seconds: 7, stderr: '', json: { result: { head: 'resolved' } } },
  ];
  const io = {
    cli: async args => {
      calls.push(args);
      return replies.shift();
    },
    receipt: (_id, value) => receipts.push(value),
  };
  const result = await sourceCommand(io, 'fixture', '/synthetic/lane', 'resolve', {
    operationId,
    laneId: 'synthetic',
    paths: ['a.rs'],
  });
  assert.equal(result.seconds, 37);
  assert.equal(result.json.result.head, 'resolved');
  assert.equal(calls[1][2], 'wait');
  assert.deepEqual(JSON.parse(calls[1][3]), { operationIds: [operationId] });
  assert.equal(receipts[0].body.operationId, operationId);
  assert.equal(receipts[1].operationId, operationId);
});

test('unfinished source operations retain replay data and terminal source failures stay failed', async () => {
  const body = { operationId: '17adac72-808e-4f79-a2c7-ce9f2ac51f06', laneId: 'synthetic' };
  const pending = { code: 3, seconds: 1, stderr: '', json: { inProgress: true } };
  await assert.rejects(
    sourceCommand({ cli: async () => pending, receipt() {} }, 'fixture', '/synthetic/lane', 'resolve', body),
    error => {
      assert.deepEqual(error.pendingSource, {
        verb: 'resolve',
        operationId: body.operationId,
        body,
        flags: [],
      });
      return true;
    },
  );
  const failure = { code: 2, seconds: 1, stderr: '', json: { error: { code: 'RESOLUTION_REQUIRED' } } };
  assert.equal(
    await sourceCommand(
      { cli: async () => failure, receipt() {} },
      'fixture',
      '/synthetic/lane',
      'resolve',
      body,
    ),
    failure,
  );
});
