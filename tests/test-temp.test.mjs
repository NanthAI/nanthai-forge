// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

const runtime = fileURLToPath(new URL('./check-runtime.mjs', import.meta.url));
const helper = new URL('../scripts/test-temp.mjs', import.meta.url).href;
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const prefixes = [
  'forge-batch-',
  'forge-machine-check-',
  'forge-landing-tlc-',
  'forge-direct-job-',
  'scale-',
];
for (const fail of [false, true])
  test(`92f4bf04: shared temp fixture cleans leaking prefixes and checkout companions after ${fail ? 'failure' : 'success'}`, t => {
    const root = temporaryDirectory(t),
      file = join(root, 'fixture.mjs'),
      paths = join(root, 'paths.json');
    writeFileSync(
      file,
      `import test from 'node:test';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { temporaryDirectory } from ${JSON.stringify(helper)};
    test('fixture', t => {
      const paths = ${JSON.stringify(prefixes)}.map(prefix => temporaryDirectory(t, prefix));
      const all = paths.flatMap(path => {
        mkdirSync(path + '.forge-client');
        writeFileSync(path + '.forge-metrics.jsonl', '{}');
        return [path, path + '.forge-client', path + '.forge-metrics.jsonl'];
      });
      writeFileSync(${JSON.stringify(paths)}, JSON.stringify(all));
      ${fail ? "throw Error('synthetic fixture failure');" : ''}
    });`,
    );
    const result = spawnSync(process.execPath, ['--import', runtime, '--test', file], {
      encoding: 'utf8',
      env: childEnv,
    });
    assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
    assert(readFileSync(paths, 'utf8'));
    assert(JSON.parse(readFileSync(paths, 'utf8')).every(path => !existsSync(path)));
    assert.doesNotMatch(result.stdout + result.stderr, /FORGE_TEMP_LEAK/);
  });

test('92f4bf04: an unowned Forge temp directory fails the file and is reclaimed without touching peer temp files', t => {
  const root = temporaryDirectory(t),
    file = join(root, 'leak.mjs'),
    paths = join(root, 'paths.json');
  writeFileSync(
    file,
    `import test from 'node:test';
    import { mkdtempSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
    test('leaks', () => writeFileSync(${JSON.stringify(paths)}, JSON.stringify(${JSON.stringify(prefixes)}.map(prefix => mkdtempSync(join(tmpdir(), prefix))))));`,
  );
  const result = spawnSync(process.execPath, ['--import', runtime, '--test', file], {
    encoding: 'utf8',
    env: childEnv,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /FORGE_TEMP_LEAK: 5/);
  assert(JSON.parse(readFileSync(paths, 'utf8')).every(path => !existsSync(path)));
  assert(existsSync(root), 'a parent/peer fixture remains untouched');
});

test('92f4bf04: the runtime reclaims persistent product caches while unowned fixtures still fail', t => {
  const root = temporaryDirectory(t),
    file = join(root, 'cache.mjs'),
    paths = join(root, 'paths.json');
  const disk = new URL('../dist/forge-disk.js', import.meta.url).href;
  writeFileSync(
    file,
    `import test from 'node:test';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { peersCacheRoot } from ${JSON.stringify(disk)};
    test('persistent runtime cache', () => {
      mkdirSync(peersCacheRoot(), { recursive: true });
      writeFileSync(${JSON.stringify(paths)}, JSON.stringify([peersCacheRoot()]));
    });`,
  );
  const result = spawnSync(process.execPath, ['--import', runtime, '--test', file], {
    encoding: 'utf8',
    env: childEnv,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert(JSON.parse(readFileSync(paths, 'utf8')).every(path => !existsSync(path)));
});

test('92f4bf04: terminated worker runtime roots are reclaimed by their enclosing file owner', t => {
  const root = temporaryDirectory(t),
    file = join(root, 'worker.mjs'),
    paths = join(root, 'paths.json');
  writeFileSync(
    file,
    `import test from 'node:test'; import { Worker } from 'node:worker_threads';
    import { once } from 'node:events'; import { writeFileSync } from 'node:fs';
    test('worker termination', async () => {
      const worker = new Worker("import {parentPort} from 'node:worker_threads'; import {tmpdir} from 'node:os'; parentPort.on('message',()=>{}); parentPort.postMessage(tmpdir());", { eval:true, execArgv:['--import',${JSON.stringify(runtime)}] });
      const [path] = await once(worker, 'message');
      writeFileSync(${JSON.stringify(paths)}, JSON.stringify([path]));
      await worker.terminate();
    });`,
  );
  const result = spawnSync(process.execPath, ['--import', runtime, '--test', file], {
    encoding: 'utf8',
    env: childEnv,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert(JSON.parse(readFileSync(paths, 'utf8')).every(path => !existsSync(path)));
});

test('92f4bf04: measured precompiled children reuse the preparing parent cache', t => {
  const root = temporaryDirectory(t),
    file = join(root, 'precompiled.mjs');
  const compiler = new URL('./convex-module.mjs', import.meta.url).href;
  const schema = new URL('../convex/errors.ts', import.meta.url).href;
  writeFileSync(
    file,
    `import test from 'node:test'; import { execFileSync } from 'node:child_process';
    import { moduleUrl } from ${JSON.stringify(compiler)};
    test('prepared module', () => {
      moduleUrl(new URL(${JSON.stringify(schema)}));
      const code = ${JSON.stringify(`import {moduleUrl} from ${JSON.stringify(compiler)}; await import(moduleUrl(new URL(${JSON.stringify(schema)})));`)};
      execFileSync(process.execPath, ['--input-type=module','-e',code], { env: {...process.env, FORGE_TEST_PRECOMPILED:'1'} });
    });`,
  );
  const environment = { ...childEnv };
  delete environment.FORGE_TEST_MODULE_DIRECTORY;
  delete environment.FORGE_TEST_PRECOMPILED;
  const result = spawnSync(process.execPath, ['--import', runtime, '--test', file], {
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
