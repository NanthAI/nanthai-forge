// SPDX-License-Identifier: Apache-2.0
// Synthetic repositories for the zoo shapes no small real repository has (Issue 70a9bd2f): CRLF text,
// file modes, symlinks, case-only renames, case-colliding, Unicode-folding and non-UTF-8 paths, large binaries.
// Each recipe is plain data: commits of { path (string or Buffer), mode, data }. They are written
// with git plumbing, so paths a macOS file system cannot hold (raw Latin-1 bytes) still reach GitHub.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const text = (...lines) => Buffer.from(lines.join('\n') + '\n');
const crlf = (...lines) => Buffer.from(lines.join('\r\n') + '\r\n');
const py = (name, crlfEnds = false) =>
  (crlfEnds ? crlf : text)(
    `"""${name}"""`,
    '',
    `def ${name}(value):`,
    '    return value + 1',
    '',
    `def ${name}_twice(value):`,
    `    return ${name}(${name}(value))`,
  );
const add = (path, data, mode = '100644') => ({ path, data, mode });
const remove = path => ({ path, mode: null });
const link = (path, target) => ({ path, data: Buffer.from(target), mode: '120000' });

/** Deterministic incompressible bytes (a SHA-256 counter stream), so the blob hash is stable. */
export function pseudoRandom(bytes, seed) {
  const out = Buffer.alloc(bytes);
  for (let at = 0, n = 0; at < bytes; n++) {
    const block = createHash('sha256').update(`${seed}:${n}`).digest();
    block.copy(out, at, 0, Math.min(block.length, bytes - at));
    at += block.length;
  }
  return out;
}
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** The recipe for each synthetic repository: `commits` and the `.forge-zoo/ci.sh` body that checks
 * the shape survived the trip through Forge (the check runs on the Candidate checkout). */
export function recipes() {
  const alpha = py('alpha', true);
  const beta = py('beta', true);
  const big1 = pseudoRandom(24 * 1024 * 1024, 'big-1');
  const big2 = pseudoRandom(24 * 1024 * 1024, 'big-2');
  const small = pseudoRandom(6 * 1024 * 1024, 'small');
  return {
    posix: {
      description:
        'CRLF sources, executable and plain scripts, symlinks (live and dangling), empty and unterminated files, spaces and non-ASCII (NFC) names, a mode change in history',
      commits: [
        [
          add('src/alpha/mod.py', alpha),
          add('src/beta/util.py', beta),
          add('bin/run.sh', text('#!/bin/sh', 'echo run'), '100755'),
          add('bin/data.sh', text('#!/bin/sh', 'echo data')),
          link('link-ok', 'src/alpha/mod.py'),
          link('link-dangling', 'does/not/exist'),
          add('empty.txt', Buffer.alloc(0)),
          add('no-newline.txt', Buffer.from('last line has no newline')),
          add('docs/résumé notes.md', text('# notes with a space and an accent')),
          add(
            'README.md',
            text('# bench-zoo posix shapes', '', 'Synthetic fixture for Forge conformance runs.'),
          ),
        ],
        [add('bin/data.sh', text('#!/bin/sh', 'echo data v2'), '100755')],
        [remove('empty.txt')],
        [add('empty.txt', Buffer.alloc(0))],
      ],
      ci: [
        'test -x bin/run.sh && test -x bin/data.sh',
        'test -L link-ok && test "$(readlink link-ok)" = "src/alpha/mod.py"',
        'test -L link-dangling && test ! -e link-dangling',
        'test -f empty.txt && test ! -s empty.txt',
        'test "$(tail -c 1 no-newline.txt)" = "e"',
        'test -f "docs/résumé notes.md"',
        'test "$(tr -cd "\\r" < src/beta/util.py | wc -c)" -ge 3',
        'python3 -m py_compile src/alpha/mod.py src/beta/util.py',
      ],
    },
    bigbin: {
      description:
        'large binaries (two 24 MiB and one 6 MiB incompressible blobs, one replaced in history) beside two source files',
      commits: [
        [
          add('src/alpha/mod.py', py('alpha')),
          add('src/beta/util.py', py('beta')),
          add('assets/first.bin', big1),
          add('assets/small.bin', small),
          add('README.md', text('# bench-zoo large binaries')),
        ],
        [add('assets/first.bin', big2), add('assets/second.bin', big1)],
      ],
      ci: [
        `test "$(sha256sum assets/first.bin | cut -d' ' -f1)" = "${sha256(big2)}"`,
        `test "$(sha256sum assets/second.bin | cut -d' ' -f1)" = "${sha256(big1)}"`,
        `test "$(sha256sum assets/small.bin | cut -d' ' -f1)" = "${sha256(small)}"`,
        'python3 -m py_compile src/alpha/mod.py src/beta/util.py',
      ],
    },
    case: {
      description:
        'case-only renames in history (a file and a directory); the final tree has no case collision',
      commits: [
        [
          add('Docs/Guide.md', text('# Guide')),
          add('LICENSE', text('Synthetic fixture, no license terms.')),
          add('src/Alpha/Mod.py', py('alpha')),
          add('src/Beta/Util.py', py('beta')),
        ],
        [
          remove('Docs/Guide.md'),
          add('docs/guide.md', text('# Guide')),
          remove('LICENSE'),
          add('license', text('Synthetic fixture, no license terms.')),
          remove('src/Alpha/Mod.py'),
          add('src/alpha/mod.py', py('alpha')),
          remove('src/Beta/Util.py'),
          add('src/beta/util.py', py('beta')),
        ],
      ],
      ci: [
        'test -f docs/guide.md && test -f license && test -f src/alpha/mod.py && test -f src/beta/util.py',
        'python3 -m py_compile src/alpha/mod.py src/beta/util.py',
      ],
    },
    collide: {
      description:
        'a tree with two paths that differ only by case (hazard: case-insensitive file systems cannot hold both)',
      commits: [
        [
          add('src/alpha/mod.py', py('alpha')),
          add('src/beta/util.py', py('beta')),
          add('src/Util.py', text('UPPER = 1')),
          add('src/util.py', text('lower = 1')),
          add('docs/ReadMe.md', text('# upper')),
          add('docs/readme.md', text('# lower')),
        ],
      ],
      ci: [
        'test -f src/Util.py && test -f src/util.py',
        'test "$(cat src/Util.py)" = "UPPER = 1" && test "$(cat src/util.py)" = "lower = 1"',
        'test -f docs/ReadMe.md && test -f docs/readme.md',
        'python3 -m py_compile src/alpha/mod.py src/beta/util.py',
      ],
    },
    nonutf8: {
      description: 'a path that is not valid UTF-8 (a raw Latin-1 byte) (hazard: macOS file names are UTF-8)',
      commits: [
        [
          add('src/alpha/mod.py', py('alpha')),
          add('src/beta/util.py', py('beta')),
          add(
            Buffer.concat([Buffer.from('src/caf'), Buffer.from([0xe9]), Buffer.from('.py')]),
            text('LATIN1 = 1'),
          ),
        ],
      ],
      ci: [
        "python3 - <<'PY'",
        'import os',
        'assert b"caf\\xe9.py" in os.listdir(b"src"), os.listdir(b"src")',
        'PY',
        'python3 -m py_compile src/alpha/mod.py src/beta/util.py',
      ],
    },
    unicode: {
      description: 'a composed and a decomposed Unicode name for one letter (hazard: macOS normalizes names)',
      commits: [
        [
          add('src/alpha/mod.py', py('alpha')),
          add('src/beta/util.py', py('beta')),
          add('docs/\u00e9.md', text('# composed')),
          add('docs/e\u0301.md', text('# decomposed')),
        ],
      ],
      ci: [
        "python3 - <<'PY'",
        'import os',
        'assert len(os.listdir(b"docs")) == 2, os.listdir(b"docs")',
        'PY',
        'python3 -m py_compile src/alpha/mod.py src/beta/util.py',
      ],
    },
  };
}

const git = (cwd, args, input) =>
  execFileSync('git', args, { cwd, input, stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 1 << 28 });

/** Builds the recipe's history (plus `extra` files on a last commit) as a bare repository in a new
 * temporary folder and returns { dir, head }. The caller pushes it and removes `dir`. */
export function buildRepository(recipe, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'zoo-shape-'));
  try {
    git(dir, ['init', '-q', '--bare', '-b', 'main']);
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'zoo-index') };
    const run = (args, input) =>
      execFileSync('git', args, {
        cwd: dir,
        env,
        input,
        stdio: ['pipe', 'pipe', 'inherit'],
        maxBuffer: 1 << 28,
      });
    let parent = null;
    const commits = [...recipe.commits, extra];
    for (const [index, ops] of commits.entries()) {
      if (!ops.length) continue;
      const lines = [];
      for (const op of ops) {
        const path = Buffer.isBuffer(op.path) ? op.path : Buffer.from(op.path);
        if (op.mode === null)
          lines.push(Buffer.concat([Buffer.from('0 ' + '0'.repeat(40) + '\t'), path, Buffer.from([0])]));
        else {
          const blob = run(['hash-object', '-w', '--stdin'], op.data).toString().trim();
          lines.push(Buffer.concat([Buffer.from(`${op.mode} ${blob}\t`), path, Buffer.from([0])]));
        }
      }
      run(['update-index', '-z', '--add', '--index-info'], Buffer.concat(lines));
      const tree = run(['write-tree']).toString().trim();
      const message =
        index === commits.length - 1 && extra.length
          ? 'zoo: check script and workflow'
          : `shape commit ${index + 1}`;
      const args = [
        '-c',
        'user.name=zoo',
        '-c',
        'user.email=zoo@example.invalid',
        'commit-tree',
        tree,
        '-m',
        message,
        ...(parent ? ['-p', parent] : []),
      ];
      parent = run(args).toString().trim();
    }
    git(dir, ['update-ref', 'refs/heads/main', parent]);
    return { dir, head: parent };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
