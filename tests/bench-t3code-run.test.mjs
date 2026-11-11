// SPDX-License-Identifier: Apache-2.0
// Synthetic subprocess stages only: never import or invoke a real preflight/driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  cpSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const harness = new URL('../scripts/bench-t3code/', import.meta.url);
const run = (script, root, args = []) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...(root ? { BENCH_ROOT: root } : {}) },
  });
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bench-run-synthetic-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = join(root, 'harness');
  mkdirSync(code);
  for (const name of ['run.mjs', 'bench-root.mjs', 'cells.mjs'])
    cpSync(new URL(name, harness), join(code, name));
  writeFileSync(
    join(code, 'plan.mjs'),
    `
    export const rng = () => () => 0;
    console.log('plan ok');
    if (process.env.BENCH_ROOT && (await import('node:fs')).existsSync(process.env.BENCH_ROOT + '/bad-plan')) process.exit(1);
  `,
  );
  writeFileSync(
    join(code, 'preflight.mjs'),
    `
    import { existsSync, writeFileSync } from 'node:fs';
    const root = process.env.BENCH_ROOT;
    writeFileSync(root + '/preflight-visited', 'synthetic');
    if (existsSync(root + '/no-go')) { console.log('NO-GO disk: synthetic disk reason'); process.exit(1); }
    console.log('GO');
  `,
  );
  writeFileSync(
    join(code, 'drive.mjs'),
    `
    import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
    const root = process.env.BENCH_ROOT, coord = process.argv.includes('--coordination');
    if (coord && !existsSync(root + '/scored-2')) throw Error('scored phase not finished');
    for (let i = 1; i <= 2; i++) {
      const file = root + '/' + (coord ? 'coordination' : 'scored') + '-' + i;
      if (!existsSync(file)) writeFileSync(file, JSON.stringify({ attempt: 1 }), { flag: 'wx' });
      if (!coord && existsSync(root + '/stop-once')) {
        rmSync(root + '/stop-once'); console.log('CELL STOP synthetic interruption'); process.exit(130);
      }
    }
    console.log('CELL ALL DONE');
  `,
  );
  writeFileSync(
    join(code, 'summarize.mjs'),
    `
    import { existsSync } from 'node:fs';
    const root = process.env.BENCH_ROOT;
    if (!existsSync(root + '/coordination-2')) throw Error('coordination not finished');
    if (existsSync(root + '/bad-summary')) { console.log('partial'); process.exit(1); }
    console.log(JSON.stringify({ synthetic: true, cells: 4 }));
  `,
  );
  return { root, script: join(code, 'run.mjs') };
}

test('run and progress refuse without BENCH_ROOT before reading inputs or starting work', () => {
  for (const entry of ['run.mjs', 'progress.mjs']) {
    const result = run(new URL(entry, harness).pathname);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /BENCH_ROOT_REQUIRED/);
    assert.equal(result.stdout, '');
  }
});

test('registered sequence checks plan, stops on NO-GO with its reason, and starts no cells', t => {
  const { root, script } = fixture(t);
  writeFileSync(join(root, 'no-go'), 'synthetic');
  const result = run(script, root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /NO-GO disk: synthetic disk reason/);
  assert.ok(!existsSync(join(root, 'scored-1')));
  assert.ok(!existsSync(join(root, 'summary.json')));
});

test('plan refusal precedes preflight and all bench work', t => {
  const { root, script } = fixture(t);
  writeFileSync(join(root, 'bad-plan'), 'synthetic');
  const result = run(script, root);
  assert.equal(result.status, 1);
  assert.ok(!existsSync(join(root, 'preflight-visited')));
  assert.ok(!existsSync(join(root, 'scored-1')));
});

test('resume after a stopped run preserves finished cells and completes coordination before summary', t => {
  const { root, script } = fixture(t);
  writeFileSync(join(root, 'stop-once'), 'synthetic');
  const first = run(script, root);
  assert.equal(first.status, 130, first.stderr);
  assert.ok(existsSync(join(root, 'scored-1')));
  assert.ok(!existsSync(join(root, 'coordination-1')));
  assert.ok(!existsSync(join(root, 'summary.json')));
  // A retained scored result must survive rerun byte for byte, without another attempt.
  writeFileSync(join(root, 'scored-1'), '{"attempt":1,"retained":true}');
  const second = run(script, root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(root, 'scored-1'), 'utf8'), '{"attempt":1,"retained":true}');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'summary.json'))), { synthetic: true, cells: 4 });
  assert.match(second.stdout, /BENCH DONE summary.json/);
  assert.doesNotMatch(second.stdout, /setup|teardown/);
});

test('failed summary retains the previous complete summary', t => {
  const { root, script } = fixture(t);
  writeFileSync(join(root, 'summary.json'), '{"retained":true}');
  writeFileSync(join(root, 'bad-summary'), 'synthetic');
  const result = run(script, root);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(root, 'summary.json'), 'utf8'), '{"retained":true}');
});

test('run never interprets a dry or partial-run flag as permission for the full scored sequence', t => {
  const { root, script } = fixture(t);
  for (const flags of [['--dry'], ['--only', 'n3-r1'], ['--live']]) {
    const result = run(script, root, flags);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /No flags are forwarded/);
    assert.ok(!existsSync(join(root, 'preflight-visited')));
    assert.ok(!existsSync(join(root, 'scored-1')));
  }
  assert.equal(run(script, undefined, ['--help']).status, 0);
});

test('stopping the runner forwards the signal to its active stage and starts no later stage', async t => {
  const { root, script } = fixture(t);
  writeFileSync(
    join(root, 'harness', 'drive.mjs'),
    `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {
      writeFileSync(process.env.BENCH_ROOT + '/stage-stopped', 'SIGTERM'); process.exit(143);
    });
    process.stdin.resume();
    console.log('SYNTHETIC STAGE READY');
  `,
  );
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, BENCH_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let output = '',
    error = '',
    signalled = false;
  child.stderr.on('data', d => {
    error += d;
  });
  child.stdout.on('data', d => {
    output += d;
    if (!signalled && output.includes('SYNTHETIC STAGE READY')) {
      signalled = true;
      child.kill('SIGTERM');
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 143, error);
  assert.equal(readFileSync(join(root, 'stage-stopped'), 'utf8'), 'SIGTERM');
  assert.ok(!existsSync(join(root, 'coordination-1')));
  assert.ok(!existsSync(join(root, 'summary.json')));
});
