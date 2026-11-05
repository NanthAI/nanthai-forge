// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { withWorkLockOptions } from '../dist/work-lock.js';
import { asAnotherProcess } from './another-process.mjs';
import { cleanupOwner } from './owner-cleanup.mjs';

const lockModule = new URL('../dist/work-lock.js', import.meta.url).href;

/** A separate process holds the Work lock, as a check child or main audit does. */
async function holdLock(path, ms) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { workLocked } from ${JSON.stringify(lockModule)};
       workLocked(process.argv[1], () => {
         process.stdout.write('held\\n');
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]));
       });`,
      path,
      String(ms),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  return { exited };
}

test('a peer write injected under the driver context admits like a separate process', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-another-process-'));
  t.after(() => cleanupOwner(root));
  writeFileSync(join(root, 'source.txt'), 'synthetic\n');
  initNative(root);
  // Same peer patience as the landing fixtures; the test runtime default is zero.
  const saved = process.env.FORGE_WORK_LOCK_WAIT_MS;
  process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
  t.after(() => {
    if (saved === undefined) delete process.env.FORGE_WORK_LOCK_WAIT_MS;
    else process.env.FORGE_WORK_LOCK_WAIT_MS = saved;
  });
  const { store } = new WorkService(root);
  const lock = join(store.directory, 'lock');
  await withWorkLockOptions({ nonblocking: true }, async () => {
    // The flake class: the driver's nonblocking context turns contention into WORK_BUSY.
    const holder = await holdLock(lock, 300);
    assert.throws(() => store.locked(() => 'driver context'), { code: 'WORK_BUSY' });
    // The helper waits with ordinary patience until the other process releases.
    assert.equal(await asAnotherProcess(async () => store.locked(() => 'peer')), 'peer');
    assert.equal(await holder.exited, 0);
  });
});

// Injected peer writes inside driver interceptors and acceptance hooks.
const peerWrite = /\b(?:person\.dispatch|cancelLandingEntry|updateHostState|bind)\(/g;
const driverBlock = /\.dispatch = async\b|drainLandingBatches\([^()]*,\s*async\b/g;

function blockAt(source, start, arrow = true) {
  const open = source.indexOf('{', arrow ? source.indexOf('=>', start) : start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return [open, index];
  }
  return [open, source.length];
}

test('every peer write injected into a landing driver uses asAnotherProcess', () => {
  const directory = new URL('./', import.meta.url);
  const offenders = [];
  const self = new URL(import.meta.url).pathname.split('/').at(-1);
  for (const name of readdirSync(directory).filter(file => file.endsWith('.test.mjs') && file !== self)) {
    const source = readFileSync(new URL(name, directory), 'utf8');
    for (const match of source.matchAll(driverBlock)) {
      const [from, to] = blockAt(source, match.index);
      for (const write of source.slice(from, to).matchAll(peerWrite)) {
        const at = from + write.index;
        if (!/asAnotherProcess\(\s*(?:async\s*)?\(\)\s*=>\s*$/.test(source.slice(at - 60, at)))
          offenders.push(`${name}:${source.slice(0, at).split('\n').length}`);
      }
    }
    // A shared helper that performs a peer acceptance must carry the same context.
    for (const match of source.matchAll(/function personAccept\b[^{]*/g)) {
      const [from, to] = blockAt(source, match.index + match[0].length, false);
      if (!source.slice(from, to).includes('asAnotherProcess('))
        offenders.push(`${name}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'wrap injected peer writes in asAnotherProcess (tests/another-process.mjs)',
  );
});
