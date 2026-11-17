// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runWithSecrets, unavailableRunSecrets } from '../dist/secret-run.js';
import { secretFileFolder } from '../dist/secret-run-files.js';

const fixture = fileURLToPath(new URL('./fixtures/secret-file-worker.mjs', import.meta.url));
const sink = () => {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString() };
};
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-run-test-'));
  const root = join(directory, 'tree'),
    tempRoot = join(directory, 'temp');
  mkdirSync(root);
  mkdirSync(tempRoot);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { root, tempRoot };
}
// The OS and Node's coverage runner can add instrumentation after spawn receives
// the explicit environment. These names carry no delivered secret or Forge session.
const deliveredNames = names =>
  names.filter(name => !['__CF_USER_TEXT_ENCODING', 'NODE_V8_COVERAGE'].includes(name));
const supplied = values => async () => ({
  secrets: Object.entries(values).map(([name, value]) => ({ name, kind: 'env', value: Buffer.from(value) })),
});

test('T12 T13 T14 T19 real child receives only selected names, no Forge/session material; exit status is retained', async t => {
  const { root, tempRoot } = setup(t);
  writeFileSync(join(root, '.env.example'), 'TOKEN\nLOCAL\nMISSING\nPATH=ignored\n');
  for (const only of [undefined, ['TOKEN', 'UNLISTED']]) {
    const out = sink(),
      err = sink();
    const code = await runWithSecrets(
      {
        root,
        only,
        command: [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify(Object.keys(process.env).sort())); process.exitCode = 7;',
        ],
      },
      supplied({
        TOKEN: 'synthetic-token',
        LOCAL: 'remote-value',
        UNLISTED: 'synthetic-unlisted',
        PATH: 'synthetic-denied',
      }),
      {
        tempRoot,
        stdout: out.stream,
        stderr: err.stream,
        source: {
          LOCAL: 'local-value',
          FORGE_AUTH_TOKEN: 'synthetic-forge',
          FORGE_SECRETS_KEY: 'synthetic-key',
          FORGE_AGENT_SESSION: 'synthetic-session',
          CODEX_THREAD_ID: 'synthetic-session',
        },
      },
    );
    assert.equal(code, 7);
    assert.deepEqual(deliveredNames(JSON.parse(out.text())), ['LOCAL', 'TOKEN']);
    assert.match(err.text(), /MISSING: no value/);
    assert.match(err.text(), /UNLISTED: arrives when its change lands/);
    assert.match(err.text(), /PATH: denied name/);
  }
});

test('T15 Checks machine delivery requires an explicit narrowing or supervisor declaration before project code runs', async t => {
  const { root, tempRoot } = setup(t);
  writeFileSync(join(root, '.env.example'), 'TOKEN\nOTHER');
  const command = [process.execPath, '-e', 'process.stdout.write(Object.keys(process.env).join(","))'];
  const provider = async () => ({
    ...(await supplied({ TOKEN: 'synthetic-token', OTHER: 'synthetic-other' })()),
    machine: true,
  });
  await assert.rejects(
    runWithSecrets({ root, set: 'checks', command }, provider, { source: {}, tempRoot }),
    /needs --only/,
  );
  for (const narrowing of [{ only: ['TOKEN'] }, { declaration: ['TOKEN'] }]) {
    const out = sink();
    assert.equal(
      await runWithSecrets({ root, set: 'checks', command, ...narrowing }, provider, {
        source: {},
        tempRoot,
        stdout: out.stream,
        stderr: sink().stream,
      }),
      0,
    );
    assert.deepEqual(deliveredNames(out.text().split(',')), ['TOKEN']);
  }
});

test('T97 a non-file example starts no provider or child; a case-only example contributes no injected names and is reported', async t => {
  const { root, tempRoot } = setup(t);
  const marker = join(root, 'child-started');
  let reads = 0;
  const provider = async () => {
    reads++;
    return supplied({ TOKEN: 'synthetic-value' })();
  };
  const command = [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  ];
  writeFileSync(join(root, 'example-target'), 'TOKEN');
  symlinkSync('example-target', join(root, '.env.example'));
  await assert.rejects(runWithSecrets({ root, command }, provider, { source: {}, tempRoot }), {
    code: 'SECRETS_ENV_EXAMPLE_NOT_FILE',
  });
  rmSync(join(root, '.env.example'));
  mkdirSync(join(root, '.env.example'));
  await assert.rejects(runWithSecrets({ root, command }, provider, { source: {}, tempRoot }), {
    code: 'SECRETS_ENV_EXAMPLE_NOT_FILE',
  });
  assert.equal(reads, 0);
  assert(!existsSync(marker));
  rmSync(join(root, '.env.example'), { recursive: true });
  writeFileSync(join(root, '.ENV.example'), 'TOKEN');
  const out = sink(),
    err = sink();
  const code = await runWithSecrets(
    {
      root,
      command: [
        process.execPath,
        '-e',
        'process.stdout.write(process.env.TOKEN === undefined ? "absent" : "present")',
      ],
    },
    provider,
    { source: {}, tempRoot, stdout: out.stream, stderr: err.stream },
  );
  assert.equal(code, 0);
  assert.equal(out.text(), 'absent');
  assert.match(err.text(), /\.ENV\.example: not read/);
});

test('T16 stdout and stderr mask injected values for pipes, agent terminals and agent/MCP entry points; person show is explicit', async t => {
  const { root, tempRoot } = setup(t);
  writeFileSync(join(root, '.env.example'), 'TOKEN');
  for (const mode of [
    { terminal: false },
    { terminal: true, agent: true },
    { terminal: true, entryPoint: 'agent' },
    { terminal: true, entryPoint: 'mcp' },
  ]) {
    const out = sink(),
      err = sink();
    await runWithSecrets(
      {
        root,
        command: [
          process.execPath,
          '-e',
          'process.stdout.write(process.env.TOKEN); process.stderr.write(process.env.TOKEN)',
        ],
      },
      supplied({ TOKEN: 'synthetic-credential' }),
      { source: {}, tempRoot, stdout: out.stream, stderr: err.stream, ...mode },
    );
    assert.equal(out.text(), '[secret:TOKEN]');
    assert.equal(err.text(), '[secret:TOKEN]');
  }
  const out = sink();
  await runWithSecrets(
    { root, show: true, command: [process.execPath, '-e', 'process.stdout.write(process.env.TOKEN)'] },
    supplied({ TOKEN: 'synthetic-credential' }),
    { source: {}, tempRoot, stdout: out.stream, stderr: sink().stream },
  );
  assert.equal(out.text(), 'synthetic-credential');
  await assert.rejects(
    runWithSecrets({ root, show: true, command: ['unused'] }, supplied({}), { agent: true }),
    { code: 'PERSON_REQUIRED' },
  );
});

test('T16 CLI detects an inherited agent marker before stripping it, even with attached terminals', t => {
  const { root } = setup(t);
  mkdirSync(join(root, '.forge'));
  writeFileSync(join(root, '.forge/hosted-lane.json'), '{}');
  writeFileSync(join(root, '.env.example'), 'TOKEN');
  const worker = fileURLToPath(new URL('./fixtures/secret-run-cli-worker.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [worker, root], {
    env: { CODEX_THREAD_ID: 'synthetic-session' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '[secret:TOKEN]');
  assert.equal(result.stderr, '[secret:TOKEN]');
});

test('file delivery has private modes outside the tree, masks contents, cleans on exit and zeros provider buffers', async t => {
  const { root, tempRoot } = setup(t);
  writeFileSync(join(root, '.env.example'), 'FILE');
  const out = sink(),
    err = sink();
  const value = Buffer.from('synthetic-file-content');
  const script =
    'const fs=require("node:fs"),p=require("node:path"); const f=process.env.FILE; process.stdout.write(JSON.stringify({path:f,file:fs.statSync(f).mode&511,dir:fs.statSync(p.dirname(f)).mode&511})); process.stderr.write(fs.readFileSync(f));';
  await runWithSecrets(
    { root, command: [process.execPath, '-e', script] },
    async () => ({ secrets: [{ name: 'FILE', kind: 'file', value }] }),
    { source: {}, tempRoot, stdout: out.stream, stderr: err.stream },
  );
  const info = JSON.parse(out.text());
  assert.equal(info.file, 0o600);
  assert.equal(info.dir, 0o700);
  assert(!info.path.startsWith(root + '/'));
  assert(!existsSync(dirname(info.path)));
  assert.equal(err.text(), '[secret:FILE]');
  assert(value.every(byte => byte === 0));
});

test('temporary file storage refuses source/output paths and links and never overwrites an existing value file', t => {
  const { root, tempRoot } = setup(t);
  assert.throws(() => secretFileFolder({ root, tempRoot: root }), { code: 'UNSAFE_PATH' });
  assert.throws(() => secretFileFolder({ root, tempRoot, keptPaths: [tempRoot] }), { code: 'UNSAFE_PATH' });
  const folder = secretFileFolder({ root, tempRoot });
  const file = folder.write('FILE', Buffer.from('synthetic-first'));
  assert.throws(() => folder.write('../outside', Buffer.from('synthetic')), { code: 'BAD_ARGUMENT' });
  assert.throws(() => folder.write('FILE', Buffer.from('synthetic-second')), { code: 'EEXIST' });
  assert.equal(readFileSync(file, 'utf8'), 'synthetic-first');
  const base = dirname(folder.path);
  folder.cleanup();
  rmSync(base, { recursive: true });
  symlinkSync(root, base);
  assert.throws(() => secretFileFolder({ root, tempRoot }), { code: 'UNSAFE_PATH' });
});

test('environment-only delivery does not require an otherwise unused private file folder', async t => {
  const { root } = setup(t);
  writeFileSync(join(root, '.env.example'), 'TOKEN');
  const out = sink();
  const code = await runWithSecrets(
    { root, command: [process.execPath, '-e', 'process.stdout.write(process.env.TOKEN)'] },
    supplied({ TOKEN: 'synthetic-env-only' }),
    { source: {}, tempRoot: root, stdout: out.stream, stderr: sink().stream },
  );
  assert.equal(code, 0);
  assert.equal(out.text(), '[secret:TOKEN]');
});

test('T17 SIGKILL leaves a file folder for the next run to sweep while a live owner folder remains', async t => {
  const { root, tempRoot } = setup(t);
  const worker = fork(fixture, [root, tempRoot, 'killed'], {
    stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    env: {},
  });
  t.after(() => worker.kill('SIGKILL'));
  const [ready] = await once(worker, 'message');
  assert(existsSync(ready.path));
  const live = secretFileFolder({ root, tempRoot });
  const exited = once(worker, 'exit');
  worker.kill('SIGKILL');
  await exited;
  await runWithSecrets({ root, command: [process.execPath, '-e', ''] }, supplied({}), {
    source: {},
    tempRoot,
    stdout: sink().stream,
    stderr: sink().stream,
  });
  assert(!existsSync(ready.path));
  assert(existsSync(live.path));
  live.cleanup();
});

test('file folders are removed on SIGINT, SIGTERM and SIGHUP and the child is signalled', async t => {
  const { root, tempRoot } = setup(t);
  writeFileSync(join(root, '.env.example'), 'FILE');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const worker = fork(fixture, [root, tempRoot, 'signal'], {
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
      env: {},
    });
    t.after(() => worker.kill('SIGKILL'));
    await once(worker, 'message');
    const base = join(tempRoot, `forge-run-secrets-${process.getuid?.() ?? 'user'}`);
    assert.equal(readdirSync(base).length, 1);
    const exited = once(worker, 'exit');
    worker.kill(signal);
    const [code] = await exited;
    assert(code >= 128);
    assert.deepEqual(readdirSync(base), []);
  }
});

test('spawn failure cleans private files and buffers; the public CLI never accepts plaintext stub input', async t => {
  const { root, tempRoot } = setup(t);
  writeFileSync(join(root, '.env.example'), 'FILE');
  const value = Buffer.from('synthetic-file-value');
  await assert.rejects(
    runWithSecrets(
      { root, command: [join(root, 'absent')] },
      async () => ({ secrets: [{ name: 'FILE', kind: 'file', value }] }),
      { source: {}, tempRoot, stdout: sink().stream, stderr: sink().stream },
    ),
    { code: 'BAD_ARGUMENT' },
  );
  assert(value.every(byte => byte === 0));
  assert.deepEqual(readdirSync(join(tempRoot, `forge-run-secrets-${process.getuid?.() ?? 'user'}`)), []);
  await assert.rejects(unavailableRunSecrets({ root, set: 'development' }), /not connected/);
  const help = spawnSync(process.execPath, ['dist/cli-entry.js', 'run', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /not connected/);
});
