// SPDX-License-Identifier: Apache-2.0
// The zoo run's generic choices (Issue 85d26a8b): probe files come from the tree shape alone,
// edits stay comments in every ecosystem, keep-both resolution and receipt reading. Synthetic trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLine,
  checkFacts,
  cliHead,
  githubEquivalent,
  landPending,
  pickProbeFiles,
  probeLine,
  resolveKeepBoth,
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
