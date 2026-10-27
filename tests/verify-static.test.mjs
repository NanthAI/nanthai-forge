// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const failure of ['none', 'exit', 'signal', 'ordinary', 'convex', 'schema']) {
  test(`synthetic static verification preserves ${failure} outcome with queued builds`, t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verify-static-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (path, text) => writeFileSync(join(root, path), text);
    for (const directory of [
      'scripts',
      'tests',
      'node_modules/typescript/bin',
      'node_modules/@typescript/native/bin',
    ])
      mkdirSync(join(root, directory), { recursive: true });
    for (const name of ['verify.mjs', 'verify-queue.mjs'])
      write(`scripts/${name}`, readFileSync(`scripts/${name}`));
    write('scripts/check-schema-compat.mjs', `process.exit(${failure === 'schema' ? 9 : 0});`);
    write(
      'scripts/oxc.mjs',
      `import { appendFileSync } from 'node:fs'; appendFileSync('oxc.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');`,
    );
    write('tests/worker-budget.mjs', 'export const workerBudget = () => 2;');
    write('scripts/test-files.mjs', 'export const fileTimeout = () => 1000;');
    write(
      'package.json',
      JSON.stringify({
        type: 'module',
        scripts: Object.fromEntries(
          ['build:core', 'build:web', 'check', 'format:check', 'lint'].map(name => [
            name,
            name === 'build:core'
              ? "node -e \"require('node:fs').writeFileSync('core-built', '')\""
              : 'node -e "process.exit(0)"',
          ]),
        ),
      }),
    );
    for (const [compiler, log] of [
      ['typescript', 'legacy'],
      ['@typescript/native', 'native'],
    ]) {
      const outcome =
        failure === 'signal'
          ? "process.kill(process.pid, 'SIGKILL');"
          : failure === 'convex'
            ? `process.exit(${log === 'legacy' ? "process.argv.includes('convex/tsconfig.json') ? 7 : 0" : '0'});`
            : `process.exit(${failure === 'exit' ? 137 : failure === 'ordinary' ? 7 : 0});`;
      write(
        `node_modules/${compiler}/bin/tsc`,
        `const fs = require('node:fs');
        fs.appendFileSync('${log}.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
        if (${log === 'legacy'} && process.argv.includes('convex/tsconfig.json') && !fs.existsSync('core-built'))
          throw Error('Convex compatibility check ran before core build');
        ${outcome}`,
      );
    }
    const result = spawnSync(process.execPath, ['scripts/verify.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        FORGE_STATIC_WORKERS: '2',
        FORGE_SELECTED_TESTS: JSON.stringify({ scope: 'full', tests: [] }),
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      failure === 'none' ? 0 : ['ordinary', 'convex', 'schema'].includes(failure) ? 1 : 137,
      result.stdout + result.stderr,
    );
    assert.match(result.stdout, /\[build:core\] ok/);
    assert.match(result.stdout, /\[test\] ok/);
    assert.match(
      result.stdout,
      new RegExp(`\\[schema compatibility\\] ${failure === 'schema' ? 'FAILED' : 'ok'}`),
    );
    const calls = name =>
      readFileSync(join(root, `${name}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
    assert.deepEqual(calls('oxc').sort(), [['format:check'], ['lint']]);
    assert.deepEqual(calls('legacy'), [
      ['-p', 'web/tsconfig.json'],
      ['-p', 'convex/tsconfig.json', '--noEmit'],
    ]);
    assert.match(
      result.stdout,
      new RegExp(`\\[typecheck:convex:tsc\\] ${['none', 'schema'].includes(failure) ? 'ok' : 'FAILED'}`),
    );
    assert.deepEqual(
      calls('native').map(args => args.slice(0, 2)),
      Array(3).fill(['--noUncheckedSideEffectImports', 'false']),
    );
    assert.equal(calls('native').filter(args => args.includes('*')).length, 2);
  });
}
