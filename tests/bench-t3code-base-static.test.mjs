// SPDX-License-Identifier: Apache-2.0
// Synthetic repo with its own format check and fixer; no bench, service or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseStatic, formatScripts } from '../scripts/bench-t3code/base-static.mjs';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'base-static-'));
  const meta = join(dir, 'meta');
  mkdirSync(meta);
  git(meta, 'init', '-q');
  const all = {
    'package.json': JSON.stringify({ scripts: { 'fmt:check': 'node fmt.mjs --check', fmt: 'node fmt.mjs' } }),
    // The "formatter": a file is unformatted while it holds the word UGLY.
    'fmt.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\\n').filter(Boolean);
const word = 'UG' + 'LY';
const bad = files.filter(f => readFileSync(f, 'utf8').includes(word));
if (process.argv.includes('--check')) process.exit(bad.length ? 1 : 0);
for (const f of bad) writeFileSync(f, readFileSync(f, 'utf8').replaceAll(word, 'pretty'));
`,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(meta, path, '..'), { recursive: true });
    writeFileSync(join(meta, path), text);
  }
  git(meta, 'add', '-A');
  git(meta, 'commit', '-q', '-m', 'base');
  const baseSha = git(meta, 'rev-parse', 'HEAD');
  const baseCheckout = join(dir, 'base');
  execFileSync('git', ['clone', '-q', '--shared', meta, baseCheckout], { env });
  const work = join(dir, 'work');
  mkdirSync(work);
  return { dir, meta, baseSha, baseCheckout, work };
}

test('format scripts: the conventional check and its fixer', () => {
  assert.deepEqual(formatScripts(JSON.stringify({ scripts: { 'fmt:check': 'x', fmt: 'y' } })), {
    check: 'fmt:check',
    fix: 'fmt',
  });
  assert.equal(formatScripts(JSON.stringify({ scripts: { test: 'x' } })), null);
  assert.throws(() => formatScripts(JSON.stringify({ scripts: { 'format:check': 'x' } })), /no fixer/);
});

test('only bench-owned files are formatted, into a deterministic derived base commit', async () => {
  const f = fixture({ '.github/workflows/bench-ci.yml': 'on: UGLY\n', 'src/a.js': 'ok\n' });
  try {
    const run = () => baseStatic({ ...f, env });
    const out = await run();
    assert.notEqual(out.sha, f.baseSha);
    assert.deepEqual(out.fixed, ['.github/workflows/bench-ci.yml']);
    assert.equal(out.check, 'fmt:check');
    assert.equal(git(f.meta, 'rev-parse', `${out.sha}^`), f.baseSha);
    assert.equal(git(f.meta, 'show', `${out.sha}:.github/workflows/bench-ci.yml`), 'on: pretty');
    assert.equal(git(f.meta, 'show', `${out.sha}:src/a.js`), 'ok');
    assert.deepEqual(git(f.meta, 'diff', '--name-only', f.baseSha, out.sha).split('\n'), out.fixed);
    assert.equal((await run()).sha, out.sha, 'same base, same derived commit');
    assert.equal(git(f.baseCheckout, 'status', '--porcelain'), '', 'the base checkout is never edited');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('an upstream file that fails the check is refused, never edited', async () => {
  const f = fixture({ '.bench/ci.sh': 'UGLY\n', 'src/a.js': 'UGLY\n' });
  try {
    await assert.rejects(baseStatic({ ...f, env }), /outside bench-owned files \(src\/a\.js\)/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a base that already passes is kept as is', async () => {
  const f = fixture({ '.bench/ci.sh': 'fine\n' });
  try {
    assert.deepEqual(await baseStatic({ ...f, env }), {
      sha: f.baseSha,
      from: f.baseSha,
      check: 'fmt:check',
      fixed: [],
    });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
