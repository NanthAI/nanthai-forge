// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/convex-deploy.yml', 'utf8');

test('dev Convex deploys only from main pushes inside the locked environment', () => {
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.match(workflow, /environment: convex-dev/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: '24\.22\.1'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /CONVEX_DEPLOY_KEY: \$\{\{ secrets\.CONVEX_DEPLOY_KEY \}\}/);
  assert.equal(workflow.match(/secrets\./g).length, 1);
});

// Convex imports shared reducers and transports from src; changes there must reach the server.
test('backend and shared source changes automatically deploy Convex', () => {
  for (const path of [
    'convex/**',
    'src/**',
    'package.json',
    'package-lock.json',
    '.github/workflows/convex-deploy.yml',
  ])
    assert(workflow.includes(`      - '${path}'`), `paths filter covers ${path}`);
});

// A mirror backlog drain starts one run per head; only the newest deploy-relevant head may deploy.
test('deploy job needs the stale-head check and keeps one queued run', () => {
  assert.match(workflow, /\n  check:\n/);
  assert.match(workflow, /\n  deploy:\n    needs: check\n    if: needs\.check\.outputs\.deploy == 'true'\n/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  const check = workflow.slice(workflow.indexOf('\n  check:'), workflow.indexOf('\n  deploy:'));
  assert.doesNotMatch(check, /secrets\.|CONVEX_DEPLOY_KEY|environment:/);
});

function runTipCheck(compare) {
  const dir = mkdtempSync(join(tmpdir(), 'convex-deploy-tip-'));
  try {
    const script = workflow
      .match(/- id: tip\n(?:.*\n)*?        run: \|\n((?:          .*\n)+)/)[1]
      .replace(/^ {10}/gm, '');
    // Fake gh: applies the workflow's own --jq filter to the fixture with the real jq.
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(compare ?? {}));
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/bash\n[ "$FAKE_GH_FAIL" = 1 ] && exit 1\nwhile [ $# -gt 0 ]; do [ "$1" = --jq ] && filter=$2; shift; done\njq -r "$filter" < "${dir}/fixture.json"\n`,
      { mode: 0o755 },
    );
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        REPO: 'o/r',
        SHA: 'abc',
        FAKE_GH_FAIL: compare === null ? '1' : '0',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return { output: readFileSync(out, 'utf8').trim(), stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const files = (...names) => names.map(filename => ({ filename }));

test('stale-head check skips only when a newer commit changes a watched path', () => {
  const skip = runTipCheck({
    status: 'ahead',
    files: files('docs/a.md', 'convex/x.ts'),
  });
  assert.equal(skip.output, 'deploy=false');
  assert.match(skip.stdout, /^::notice::Skipped: .*abc/m);
  for (const path of ['src/a.ts', 'package.json', 'package-lock.json', '.github/workflows/convex-deploy.yml'])
    assert.equal(runTipCheck({ status: 'ahead', files: files(path) }).output, 'deploy=false', path);
});

test('stale-head check deploys at the tip, after docs-only commits and on unclear answers', () => {
  assert.equal(runTipCheck({ status: 'identical', files: [] }).output, 'deploy=true');
  assert.equal(
    runTipCheck({
      status: 'ahead',
      files: files('docs/a.md', 'tests/b.mjs', 'xsrc/c.ts', 'convex-other/d.ts'),
    }).output,
    'deploy=true',
  );
  assert.equal(runTipCheck({ status: 'behind', files: files('convex/x.ts') }).output, 'deploy=true');
  assert.equal(runTipCheck({ status: 'diverged', files: files('convex/x.ts') }).output, 'deploy=true');
  const truncated = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
  assert.equal(runTipCheck({ status: 'ahead', files: files(...truncated) }).output, 'deploy=true');
  const failed = runTipCheck(null);
  assert.equal(failed.output, 'deploy=true');
  assert.match(failed.stdout, /^::warning::/m);
});

// The exit bench's own deployment (Issue 2e1f5fbd): deployed code may move only when the lead
// dispatches it, from a commit on main, with a key that reaches no other deployment.
test('bench Convex deploys only on dispatch, from a main commit, inside its own environment', () => {
  const bench = readFileSync('.github/workflows/convex-bench-deploy.yml', 'utf8');
  const on = bench.slice(bench.indexOf('\non:'), bench.indexOf('\npermissions:'));
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /push:|pull_request|schedule:|workflow_run/);
  assert.match(bench, /environment: convex-bench/);
  assert.doesNotMatch(bench, /environment: convex-dev/);
  assert.equal(bench.match(/secrets\./g).length, 1);
  assert.match(bench, /persist-credentials: false/);
  assert.match(bench, /cancel-in-progress: false/);
  assert.match(bench, /compare\/\$REF\.\.\.main/);
  // The guard runs before the checkout and the deploy.
  assert(bench.indexOf('Refuse a commit that is not on main') < bench.indexOf('actions/checkout'));
});
