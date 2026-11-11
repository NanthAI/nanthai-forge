// SPDX-License-Identifier: Apache-2.0
// Explicit dev-only synthetic qualification. Run through nforge heavy.
// BASELINE_BUILD CURRENT_BUILD FIXTURE ADDRESS.json OUTPUT [PAIRS=11] [COHORT=3] [PAIR_OFFSET=0]
// Builds remain pinned; --import adds the same transport observer to both.
// Injects only observer callbacks into the two disposable compiled builds; records their hashes.
// The fixture must be owned synthetic source, already hosted, with its native object store intact.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { freemem, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [
  baseline,
  candidate,
  fixtureArg,
  addressFile,
  outputArg,
  pairsArg = '11',
  cohortArg = '3',
  offsetArg = '0',
] = process.argv.slice(2);
assert(baseline && candidate && fixtureArg && addressFile && outputArg, 'See usage at top of script');
const fixture = resolve(fixtureArg),
  output = resolve(outputArg),
  pairs = Number(pairsArg),
  cohort = Number(cohortArg),
  pairOffset = Number(offsetArg);
assert(Number.isSafeInteger(pairs) && pairs > 0);
assert(Number.isSafeInteger(cohort) && cohort >= 0 && Number.isSafeInteger(pairOffset) && pairOffset >= 0);
assert(!existsSync(join(output, 'runs.jsonl')), 'retain prior runs; use another output directory');
const address = JSON.parse(readFileSync(addressFile)),
  fixtureHead = JSON.parse(readFileSync(join(fixture, '.forge/work/init.json'))).head,
  state = JSON.parse(readFileSync(join(fixture, '.forge/work/objects', fixtureHead)));
assert.equal(state.files.length, 29000, 'qualify the requested real-scale fixture');
mkdirSync(output, { recursive: true });
const builds = [baseline, candidate].map(path => resolve(path));
const pins = builds.map(build => readFileSync(join(build, '.commit'), 'utf8').trim());
const instrumentation = [];
for (const build of builds) {
  for (const name of readdirSync(join(build, 'dist')).filter(name => name.endsWith('.js'))) {
    const path = join(build, 'dist', name),
      before = readFileSync(path, 'utf8');
    let after = before.includes('globalThis.__forgePrepCliReady')
      ? before
      : before.replace(
          /(async function hostedAgentCli\([^\n]+\) \{)/,
          '$1\n globalThis.__forgePrepCliReady?.();',
        );
    after = after.includes('globalThis.__forgePrepWritePassWait')
      ? after
      : after.replace(
          'options.waited?.(performance.now() - start);',
          'globalThis.__forgePrepWritePassWait?.(performance.now() - start); options.waited?.(performance.now() - start);',
        );
    if (after === before && !before.includes('globalThis.__forgePrep')) continue;
    const sha = text => createHash('sha256').update(text).digest('hex');
    instrumentation.push({
      build: builds.indexOf(build),
      file: name,
      before: sha(before),
      after: sha(after),
    });
    writeFileSync(path, after);
  }
}
const traceModule = fileURLToPath(new URL('./workspace-prep-trace.mjs', import.meta.url));
let serial = pairOffset * 2,
  intentId;
const lanes = [];
const sample = () => ({
  at: new Date().toISOString(),
  load: loadavg(),
  freeBytes: freemem(),
  swap:
    process.platform === 'darwin'
      ? execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).trim()
      : null,
  vm:
    process.platform === 'darwin'
      ? execFileSync('vm_stat', [], { encoding: 'utf8' })
          .split('\n')
          .filter(line =>
            /Pages (free|active|inactive|occupied by compressor)|Pageouts|Swapins|Swapouts/.test(line),
          )
      : [],
});
async function cli(arm, root, action, input, tag, cache, extra = []) {
  const disk = statfsSync(output);
  assert(disk.bavail * disk.bsize >= 22 * 1024 ** 3, 'preserve the brief disk floor before each process');
  const trace = join(output, tag + '.trace.json');
  const before = sample();
  const start = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        traceModule,
        join(builds[arm], 'dist/cli-entry.js'),
        'agent',
        root,
        action,
        ...extra,
        JSON.stringify({ ...address, ...input }),
      ],
      {
        cwd: output,
        env: {
          ...process.env,
          FORGE_CLI_CANARY: pins[arm],
          FORGE_OBJECT_CACHE: cache,
          FORGE_PREP_TRACE: trace,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', bytes => (stdout += bytes));
    child.stderr.on('data', bytes => (stderr += bytes));
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  const wallMs = performance.now() - start,
    after = sample();
  writeFileSync(join(output, tag + '.log'), result.stdout + '\n' + result.stderr, { mode: 0o600 });
  const body = result.stdout
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .at(-1);
  const row = {
    wallMs,
    before,
    after,
    code: result.code,
    trace: existsSync(trace) ? JSON.parse(readFileSync(trace)) : null,
    body,
  };
  if (result.code !== 0) {
    appendFileSync(join(output, 'failures.jsonl'), JSON.stringify({ tag, ...row }) + '\n');
    throw Error(`${tag} failed (${result.code}); see private log`);
  }
  return row;
}
function verify(root) {
  const marker = JSON.parse(readFileSync(join(root, '.forge/hosted-lane.json')));
  assert.equal(marker.selection.head, fixtureHead);
  assert.equal(marker.state.files.length, state.files.length);
  for (const file of state.files) {
    const path = join(root, file.path),
      bytes = readFileSync(path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.blob);
    assert.equal(statSync(path).mode & 0o777, file.mode === 'executable' ? 0o755 : 0o644);
  }
  return { head: fixtureHead, verifiedFiles: state.files.length };
}
const anchor = join(output, 'anchor');
mkdirSync(anchor, { recursive: true });
const warm = join(output, 'warm');
mkdirSync(warm, { recursive: true, mode: 0o700 });
// Source objects are already digest-checked by native capture. Separate clones, never hardlinks.
for (const name of readdirSync(join(fixture, '.forge/work/objects')))
  if (/^[a-f0-9]{64}$/.test(name))
    copyFileSync(join(fixture, '.forge/work/objects', name), join(warm, name), constants.COPYFILE_FICLONE);
writeFileSync(
  join(output, 'plan.json'),
  JSON.stringify({
    pins,
    instrumentation,
    fixtureHead,
    pairs,
    cohort,
    pairOffset,
    order: 'ABAB',
    cache: 'alternating cold/warm by pair; cold means empty machine-object cache, not OS page cache',
    void: 'failed command, changed head, byte/mode mismatch or deployment drift; retain every void; do not silently replace',
    sourceBytes: state.files.reduce((n, file) => n + statSync(join(fixture, file.path)).size, 0),
    note: 'cohort timing is an observation; no dependencies or model agents',
  }),
);
async function start(arm, mode, pair) {
  const id = ++serial,
    tag = `${id}-${arm ? 'B' : 'A'}-${mode}`;
  const root = join(output, tag),
    cache = mode === 'cold' ? join(output, tag + '-cache') : warm;
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const started = await cli(
    arm,
    anchor,
    'start',
    {
      operationId: randomUUID(),
      open: false,
      ...(intentId ? { intentId } : { outcome: 'Synthetic workspace prep qualification' }),
    },
    tag + '-start',
    cache,
  );
  const laneId = JSON.stringify(started.body).match(/"laneId":"([a-f0-9-]{36})"/)?.[1];
  assert(laneId, 'start returned a Lane');
  lanes.push(laneId);
  intentId ??= JSON.stringify(started.body).match(/"intentId":"([a-f0-9-]{36})"/)?.[1];
  return { id, tag, root, cache, started, startedAt, laneId, pair, mode, arm };
}
async function open(run) {
  const { arm, root, tag, cache, started, laneId } = run;
  const opened = await cli(arm, root, 'open', { laneId, operationId: randomUUID() }, tag + '-open', cache);
  const verified = verify(root);
  const metric = readFileSync(root + '.forge-metrics.jsonl', 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter(row => row.kind === 'checkout')
    .at(-1);
  const row = {
    ...run,
    started,
    opened,
    checkout: metric.checkout,
    verified,
    prepMs: started.wallMs + opened.wallMs,
  };
  // Paths are private run bookkeeping, never public evidence.
  appendFileSync(join(output, 'runs.jsonl'), JSON.stringify(row) + '\n');
  console.log(
    JSON.stringify({
      id: run.id,
      arm: arm ? 'B' : 'A',
      mode: run.mode,
      pair: run.pair,
      prepMs: Math.round(row.prepMs),
      openMs: Math.round(opened.wallMs),
      waitMs: Math.round(metric.checkout.phasesMs.slotWait),
    }),
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(root + '.forge-client', { recursive: true, force: true });
  if (run.mode === 'cold') rmSync(cache, { recursive: true, force: true });
  return row;
}
try {
  for (let pair = pairOffset; pair < pairOffset + pairs; pair++) {
    const mode = pair % 2 ? 'warm' : 'cold';
    for (const arm of [0, 1]) await open(await start(arm, mode, pair));
  }
  for (const arm of [0, 1]) {
    const group = [];
    for (let i = 0; i < cohort; i++) group.push(await start(arm, 'concurrent', null));
    await Promise.all(group.map(open));
  }
} finally {
  writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ intentId, laneIds: lanes, address }));
  rmSync(warm, { recursive: true, force: true });
}
