// SPDX-License-Identifier: Apache-2.0
// Development-only: no provider calls, project code execution, or stored JAR.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { childEnv } from '../../scripts/child-env.mjs';

export const tlaTools = {
  version: '1.7.4',
  url: 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar',
  sha256: '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88',
};
const directory = dirname(fileURLToPath(import.meta.url));
const config = process.argv[2] ?? 'small';
if (!/^[a-z][a-z0-9-]*$/.test(config)) throw new Error('Select a model configuration name.');
if (config === 'all') {
  for (const name of [
    'small',
    'strict',
    'races',
    'submission',
    'six-slots',
    'reuse-core',
    'isolation',
    'wait',
    'wait-fixed',
    'cohort',
    'cohort-fixed',
    'stranded',
    'stranded-fixed',
    'orderwake',
    'orderwake-fixed',
    'outage',
    'outage-fixed',
    'moving',
    'reuse',
    'reuse-fixed',
    'prequeue',
    'prequeue-strict',
    'prequeue-platform',
    'prequeue-before',
    'prequeue-suffix',
    'prequeue-solo',
    'prequeue-solo-moved',
  ]) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), name], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) process.exit(1);
  }
  process.exit(0);
}
const cfg = await readFile(join(directory, `${config}.cfg`), 'utf8');
const disk = await statfs(tmpdir());
if (disk.bavail * disk.bsize < 40 * 1000 ** 3) throw new Error('TLC requires 40 GB free disk reserve.');
const scratch = await mkdtemp(join(tmpdir(), 'forge-landing-tlc-'));
try {
  const home = join(scratch, 'home'),
    temp = join(scratch, 'tmp');
  const configHome = join(scratch, 'config'),
    cache = join(scratch, 'cache'),
    data = join(scratch, 'data');
  await Promise.all([home, temp, configHome, cache, data].map(path => mkdir(path)));
  const environment = childEnv({
    extra: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
    },
  });
  const response = await fetch(tlaTools.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Official tla2tools download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== tlaTools.sha256)
    throw new Error('Official tla2tools checksum differs; refusing to execute it.');
  const jar = join(scratch, 'tla2tools.jar');
  await writeFile(jar, bytes);
  const module = cfg.includes('\\* Incident') ? 'Incidents' : 'LandingQueue';
  const args = [
    `-Duser.home=${home}`,
    `-Djava.io.tmpdir=${temp}`,
    '-Xmx2g',
    '-XX:+UseParallelGC',
    '-cp',
    jar,
    'tlc2.TLC',
    '-workers',
    '1',
    '-seed',
    '1',
    '-fp',
    '0',
    '-config',
    `${config}.cfg`,
    '-metadir',
    join(scratch, 'states'),
    `${module}.tla`,
  ];
  let java = 'java';
  if (process.platform === 'darwin') {
    try {
      java = join(
        execFileSync('/usr/libexec/java_home', [], {
          encoding: 'utf8',
          env: environment,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
        'bin',
        'java',
      );
    } catch {
      process.stdout.write('No registered macOS JDK; using Java from PATH.\n');
    }
  }
  const started = performance.now();
  let output = '';
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(java, args, {
      cwd: directory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config === 'small' ? 300_000 : undefined,
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', data => {
        output += data;
        process.stdout.write(data);
      });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const expected = cfg.match(/\\\* Expect: (.+)/)?.[1];
  const matched = expected
    ? exit.code === (expected.startsWith('Invariant') ? 12 : 13) &&
      output.includes(expected) &&
      /Error: (Invariant|Temporal properties)/.test(output)
    : exit.code === 0 && output.includes('Model checking completed. No error has been found.');
  const states = output.match(
    /([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left/,
  );
  console.log(
    JSON.stringify({
      config,
      ...exit,
      expected: expected ?? 'no violation',
      matched,
      states: states?.slice(1),
      wallSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    }),
  );
  if (!matched || exit.signal) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
