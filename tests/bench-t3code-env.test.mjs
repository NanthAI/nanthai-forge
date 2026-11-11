// SPDX-License-Identifier: Apache-2.0
// Bench environment setup/teardown (Issue e082f30a). Fakes only: no GitHub, no Forge, no installs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST,
  buildSteps,
  readManifest,
  record,
  rulesetBody,
  runSetup,
  runTeardown,
  sumCosts,
  versionAtLeast,
  SETUP_COMMAND,
  benchCheckDigest,
  FORGE_RUNNER,
} from '../scripts/bench-t3code/env.mjs';
import { parseArgs } from '../scripts/bench-t3code/setup.mjs';
import { repository, rulesetName } from '../scripts/bench-t3code/github-arm.mjs';
import { parseMirror, pinHarness, resolvePin } from '../scripts/bench-t3code/pin.mjs';
import { cliGitCommit, snapshotProblems } from '../scripts/bench-t3code/versions.mjs';
import { setupHint } from '../scripts/bench-t3code/preflight.mjs';
import { importProject } from '../scripts/bench-t3code/forge-import.mjs';

const BASE = 'a'.repeat(40);
const STATE = 'b'.repeat(64);
const STATE2 = 'c'.repeat(64);
const GIT = 'd'.repeat(40);

const bench = (config = true) => {
  const B = mkdtempSync(join(tmpdir(), 'bench-env-'));
  if (config)
    writeFileSync(
      join(B, 'config.json'),
      JSON.stringify({
        github: { repository, mainBase: BASE },
        forge: {
          url: 'https://x.convex.cloud',
          deployment: 'x',
          cli: join(B, 'cli/dist/cli-entry.js'),
          projectName: 'p',
          mainBase: BASE,
        },
        agent: { provider: 'codex' },
      }),
    );
  return B;
};

/** Stateful fake of gh/git/node: records every call, mutates a tiny world. */
function fakeContext(B, flags = {}, world = {}) {
  const w = { repo: null, main: 'upstream', rulesets: 0, remotes: new Set(), ...world };
  const calls = [];
  const lines = [];
  const handle = (cmd, args, opts) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    const a = args.join(' ');
    if (cmd === 'gh') {
      if (a.startsWith(`api repos/${repository} --jq`)) {
        if (!w.repo) throw Error('HTTP 404');
        return JSON.stringify(w.repo);
      }
      if (a.startsWith(`api repos/${repository}/branches/main`)) return w.main;
      if (a.startsWith(`api repos/${repository}/rulesets --jq`)) return String(w.rulesets);
      if (a.startsWith('repo fork')) {
        w.repo = { id: 101, created_at: '2026-11-05T10:00:00Z', visibility: 'public' };
        return '';
      }
      if (a.startsWith('repo delete')) {
        w.repo = null;
        return '';
      }
      if (a.startsWith(`api -X POST repos/${repository}/rulesets`)) {
        w.rulesetBody = JSON.parse(opts.input);
        w.rulesets = 1;
        return '';
      }
      return '';
    }
    if (cmd === 'git') {
      if (a.includes('remote get-url fork')) {
        if (!w.remotes.has('fork')) throw Error('no remote');
        return 'x';
      }
      if (a.includes('remote add fork')) w.remotes.add('fork');
      if (a.includes(' push ') && a.includes('refs/heads/main')) w.main = BASE;
      if (a.includes('cat-file -e'))
        return w.baseHeld
          ? ''
          : (() => {
              throw Error('missing');
            })();
      if (a.includes('rev-parse FETCH_HEAD')) return w.fetched ?? BASE;
      if (a.includes(' fetch ') && w.refusesBareSha && a.endsWith(BASE)) throw Error('not our ref');
      if (a.includes(' fetch ')) w.baseHeld = true;
      return '';
    }
    return '';
  };
  const ctx = {
    B,
    flags,
    now: () => '2026-11-05T12:00:00.000Z',
    sh: (c, a, o) => handle(c, a, o),
    tryRun(c, a, o) {
      try {
        return handle(c, a, o);
      } catch {
        return null;
      }
    },
    diskFreeGb: () => 200,
    nodeVersion: () => 'v24.22.1',
    fetchText: async () => '#!/bin/sh\necho installer\n',
    log: l => lines.push(l),
  };
  return { ctx, calls, lines, world: w };
}
const MUTATING =
  /^(gh (repo|api -X)|git .*(push|clone|fetch|remote add)|\S*node \S*launcher\.mjs update |\S*node .* host |\S*node \S*forge-import\.mjs|\S*node \S+ clone |\S*node .* x .* (configure-check|configure-runner|set-policy) )/;

test('versionAtLeast compares left to right', () => {
  assert.ok(versionAtLeast('v24.22.1', [24, 22, 1]));
  assert.ok(versionAtLeast('v25.0.0', [24, 22, 1]));
  assert.ok(!versionAtLeast('v24.19.0', [24, 22, 1]));
  assert.ok(!versionAtLeast('v24.22.0', [24, 22, 1]));
});

test('ruleset body encodes the plan: merge queue HEADGREEN 10/10 squash, required bench-check', () => {
  const r = rulesetBody();
  assert.equal(r.name, rulesetName);
  assert.equal(r.enforcement, 'active');
  const q = r.rules.find(x => x.type === 'merge_queue').parameters;
  assert.deepEqual(
    [q.grouping_strategy, q.max_entries_to_build, q.max_entries_to_merge, q.merge_method],
    ['HEADGREEN', 10, 10, 'SQUASH'],
  );
  assert.deepEqual(r.rules.find(x => x.type === 'required_status_checks').parameters.required_status_checks, [
    { context: 'bench-check' },
  ]);
});

test('setup flags parse; unknown flags and missing values are refused', () => {
  assert.deepEqual(parseArgs(['--dry']).opt, { dry: true });
  const p = parseArgs(['--live', '--base-source', '/b', '--only', 'fork,deps', '--new-base']);
  assert.equal(p.flags.baseSource, '/b');
  assert.deepEqual(p.opt.only, ['fork', 'deps']);
  assert.equal(p.flags.newBase, true);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--base-source']), /needs a value/);
});

test('costs sum; an unmeasured Convex figure is flagged, never turned into a number', () => {
  const s = sumCosts([
    { repos: 1, ciMinutes: 0, convexCalls: 3, diskGb: 2, networkGb: 1, minutes: 4 },
    { repos: 0, convexCalls: null, diskGb: 1 },
  ]);
  assert.equal(s.repos, 1);
  assert.equal(s.diskGb, 3);
  assert.equal(s.convexCalls, 3);
  assert.equal(s.convexCallsUnmeasured, true);
});

test('dry run: prints every step with its cost, creates nothing, makes no mutating call', async () => {
  const B = bench();
  const before = readManifest(B);
  const { ctx, calls, lines } = fakeContext(B);
  const r = await runSetup(ctx, { dry: true });
  assert.equal(r.ok, true);
  const text = lines.join('\n');
  for (const id of [
    'prereqs',
    'inputs',
    'bench-cli',
    'pin',
    'meta',
    'base',
    'base-checkout',
    'deps',
    'fork',
    'forge-project',
    'forge-check',
    'dogfood',
  ])
    assert.match(text, new RegExp(`\\] ${id}:`), id);
  assert.match(text, /cost: repos 1 \| CI min 0 \| Convex calls 0/); // the fork step
  assert.match(text, /Convex calls 12 \| disk 0.6 GB/); // the GitHub import, measured 2026-11-07
  assert.match(text, /OUTWARD: public\/hosted/);
  assert.match(text, /from scratch: repos 1/);
  assert.match(text, /nothing was created/);
  assert.deepEqual(
    calls.filter(c => MUTATING.test(c)),
    [],
  );
  assert.equal(existsSync(join(B, MANIFEST)), false);
  assert.deepEqual(readManifest(B), before);
});

test('dry run without config.json says what is missing and still lists the steps', async () => {
  const B = bench(false);
  const { ctx, lines } = fakeContext(B);
  await runSetup(ctx, { dry: true });
  assert.match(lines.join('\n'), /config\.json is missing: owner-held/);
});

test('fork step: creates the public fork once, records it, and a rerun changes nothing', async () => {
  const B = bench();
  const f = fakeContext(B);
  const first = await runSetup(f.ctx, { only: ['fork'] });
  assert.equal(first.ok, true, f.lines.join('\n'));
  assert.equal(f.world.repo.id, 101);
  assert.equal(f.world.main, BASE);
  assert.equal(f.world.rulesetBody.name, rulesetName);
  const order = f.calls.filter(c => MUTATING.test(c));
  const forkAt = order.findIndex(c => c.startsWith('gh repo fork'));
  const pushAt = order.findIndex(c => / push /.test(c));
  const rulesetAt = order.findIndex(c => c.includes('rulesets'));
  assert.ok(
    forkAt >= 0 && forkAt < pushAt && pushAt < rulesetAt,
    'fork, then main to base, then the ruleset',
  );
  const entry = readManifest(B).entries.find(e => e.kind === 'github-repo');
  assert.equal(entry.ref, repository);
  assert.equal(entry.id, 101);
  assert.equal(entry.state, 'created');

  const again = fakeContext(
    B,
    {},
    { repo: f.world.repo, main: BASE, rulesets: 1, remotes: new Set(['fork']), baseHeld: true },
  );
  const second = await runSetup(again.ctx, { only: ['fork'] });
  assert.equal(second.ok, true);
  assert.deepEqual(
    again.calls.filter(c => MUTATING.test(c)),
    [],
  );
  assert.equal(readManifest(B).entries.length, 1);
});

test('a repo that exists but is not in the manifest is never adopted (and so never deleted)', async () => {
  const B = bench();
  const f = fakeContext(B, {}, { repo: { id: 7, created_at: '2026-01-01T00:00:00Z', visibility: 'public' } });
  const r = await runSetup(f.ctx, { only: ['fork'] });
  assert.equal(r.ok, false);
  assert.equal(r.stoppedAt, 'fork');
  assert.match(f.lines.join('\n'), /will not adopt or delete a repo it did not create/);
  assert.deepEqual(
    f.calls.filter(c => MUTATING.test(c)),
    [],
  );
  assert.equal(readManifest(B).entries.length, 0);
});

test('base step preserves the registered base until its exact source is supplied', async () => {
  const B = bench();
  const f = fakeContext(B);
  const r = await runSetup(f.ctx, { only: ['base'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /BENCH_SETUP_NEEDS_BASE/);
  assert.equal(JSON.parse(readFileSync(join(B, 'config.json'), 'utf8')).github.mainBase, BASE);
  assert.deepEqual(readManifest(B).entries, []);
  assert.deepEqual(
    f.calls.filter(c => MUTATING.test(c)),
    [],
  );
});

test('base step: --base-source keeps the commit id; --new-base patches config and records the old one', async () => {
  const B = bench();
  mkdirSync(join(B, 'work/t3code-meta/.git'), { recursive: true });
  const same = fakeContext(B, { baseSource: '/src/base.bundle' });
  assert.equal((await runSetup(same.ctx, { only: ['base'] })).ok, true, same.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(join(B, 'config.json'), 'utf8')).github.mainBase, BASE);

  const NEW = 'e'.repeat(40);
  const B2 = bench();
  mkdirSync(join(B2, 'work/t3code-meta/.git'), { recursive: true });
  const nb = fakeContext(B2, { baseSource: '/src/new', newBase: true }, { fetched: NEW });
  assert.equal((await runSetup(nb.ctx, { only: ['base'] })).ok, true, nb.lines.join('\n'));
  const cfg = JSON.parse(readFileSync(join(B2, 'config.json'), 'utf8'));
  assert.equal(cfg.github.mainBase, NEW);
  assert.equal(cfg.forge.mainBase, NEW);
  assert.equal(cfg.github.previousMainBase, BASE);
  assert.ok(
    readManifest(B2).entries.some(
      e => e.kind === 'config-patch' && e.ref === 'github.mainBase' && e.before === BASE,
    ),
  );
});

test('deps step stops at the installer and prints its hash; it never runs unreviewed code', async () => {
  const B = bench();
  mkdirSync(join(B, 'work/base-F'), { recursive: true });
  writeFileSync(join(B, 'work/base-F/pnpm-lock.yaml'), 'lock');
  const f = fakeContext(B);
  const r = await runSetup(f.ctx, { only: ['deps'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /BENCH_SETUP_REVIEW_INSTALLER/);
  assert.match(r.error, /--installer-sha256 [0-9a-f]{64}/);
  assert.ok(existsSync(join(B, 'deps-installer.sh')));
});

test('teardown deletes only manifest entries, each re-verified', async () => {
  const B = bench();
  const outside = mkdtempSync(join(tmpdir(), 'bench-outside-'));
  mkdirSync(join(B, 'work/t3code-meta'), { recursive: true });
  mkdirSync(join(B, 'work/other-private'), { recursive: true });
  writeFileSync(join(B, 'work/other-private/keep.txt'), 'owner data');
  writeFileSync(join(outside, 'precious.txt'), 'x');
  record(B, { step: 'meta', kind: 'path', ref: join(B, 'work/t3code-meta') });
  record(B, { step: 'evil', kind: 'path', ref: outside }); // a tampered manifest entry
  record(B, { step: 'fork', kind: 'github-repo', ref: repository, id: 101, state: 'created' });
  const f = fakeContext(B, {}, { repo: { id: 101, created_at: '2026-11-05T10:00:00Z' } });
  const dry = await runTeardown(f.ctx, { dry: true });
  assert.equal(dry.results.find(r => r.kind === 'github-repo').result, 'would-delete');
  assert.ok(existsSync(join(B, 'work/t3code-meta')) && f.world.repo, 'dry deletes nothing');

  const r = await runTeardown(f.ctx, {});
  assert.equal(r.ok, false); // the tampered entry is refused
  assert.equal(f.world.repo, null, 'the fork we created is deleted');
  assert.ok(!existsSync(join(B, 'work/t3code-meta')));
  assert.ok(existsSync(join(B, 'work/other-private/keep.txt')), 'not in the manifest: untouched');
  assert.ok(existsSync(join(outside, 'precious.txt')), 'outside the bench root: refused');
  assert.equal(r.results.find(x => x.step === 'evil').result, 'REFUSED-outside-bench-root');
  assert.deepEqual(
    readManifest(B).entries.map(e => e.step),
    ['evil'],
  );
  rmSync(outside, { recursive: true, force: true });
});

test('teardown never deletes a repo that is no longer the one setup created', async () => {
  const B = bench();
  record(B, { step: 'fork', kind: 'github-repo', ref: repository, id: 101, state: 'created' });
  const f = fakeContext(B, {}, { repo: { id: 999, created_at: '2026-12-01T00:00:00Z' } });
  const r = await runTeardown(f.ctx, {});
  assert.equal(r.results[0].result, 'REFUSED-not-ours');
  assert.ok(f.world.repo, 'still there');
  assert.ok(!f.calls.some(c => c.startsWith('gh repo delete')));
});

test('teardown --keep leaves whole steps; a half-created repo (no id yet) is matched by creation time', async () => {
  const B = bench();
  mkdirSync(join(B, 'deps'), { recursive: true });
  record(B, { step: 'deps', kind: 'path', ref: join(B, 'deps') });
  record(B, {
    step: 'fork',
    kind: 'github-repo',
    ref: repository,
    state: 'creating',
    startedAt: '2026-11-05T09:59:30Z',
  });
  const f = fakeContext(B, {}, { repo: { id: 5, created_at: '2026-11-05T10:00:00Z' } });
  const r = await runTeardown(f.ctx, { keep: ['deps'] });
  assert.ok(existsSync(join(B, 'deps')));
  assert.equal(f.world.repo, null);
  assert.deepEqual(
    readManifest(B).entries.map(e => e.step),
    ['deps'],
  );
  assert.equal(r.ok, true);
});

test('teardown restores config keys setup patched, unless they were edited since', async () => {
  const B = bench();
  const f = fakeContext(B, { dogfoodProject: 'proj123' });
  assert.equal((await runSetup(f.ctx, { only: ['dogfood'] })).ok, true, f.lines.join('\n'));
  assert.equal(JSON.parse(readFileSync(join(B, 'config.json'), 'utf8')).dogfood.projectId, 'proj123');
  await runTeardown(f.ctx, {});
  assert.equal(JSON.parse(readFileSync(join(B, 'config.json'), 'utf8')).dogfood?.projectId, undefined);

  const f2 = fakeContext(B, { dogfoodProject: 'proj123' });
  await runSetup(f2.ctx, { only: ['dogfood'] });
  const cfg = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  cfg.dogfood.projectId = 'edited-by-owner';
  writeFileSync(join(B, 'config.json'), JSON.stringify(cfg));
  await runTeardown(f2.ctx, {});
  assert.equal(JSON.parse(readFileSync(join(B, 'config.json'), 'utf8')).dogfood.projectId, 'edited-by-owner');
});

test('preflight hint names the setup command and the step', () => {
  assert.match(setupHint('fork'), new RegExp(`${SETUP_COMMAND} --dry names step "fork"`));
});

/* ---- harness pin from Forge main (State head -> mirror Git commit) ---- */

const mirror = (o = {}) => ({
  result: {
    githubMirror: {
      repository: 'NanthAI/nanthai-forge',
      status: 'synced',
      targetHead: STATE,
      mirroredHead: STATE,
      gitHead: GIT,
      lagging: false,
      ...o,
    },
  },
});

test('pin: a State head maps to its Git commit through the mirror record, no GitHub lookup', () => {
  const r = resolvePin({ wanted: STATE, mirror: parseMirror(mirror()) });
  assert.deepEqual([r.ok, r.gitSha, r.via], [true, GIT, 'mirror-record']);
  assert.deepEqual(resolvePin({ wanted: GIT, mirror: null }).gitSha, GIT);
});

test('pin: when the mirror lags it says exactly what it waits for', () => {
  const lag = parseMirror(
    mirror({
      targetHead: STATE2,
      mirroredHead: STATE,
      gitHead: GIT,
      status: 'pending',
      lagging: true,
      pendingSince: 1793914000000,
      nextAttemptAt: 1793914999000,
    }),
  );
  const r = resolvePin({ wanted: STATE2, mirror: lag });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BENCH_PIN_WAITS_FOR_MIRROR');
  assert.match(r.waitsFor, /NanthAI\/nanthai-forge main to contain State cccccccccccc/);
  assert.match(r.message, /mirrored bbbbbbbbbbbb/);
  assert.match(r.message, /nforge github-sync ROOT --push/);
  const stale = resolvePin({ wanted: 'f'.repeat(64), mirror: lag });
  assert.match(stale.message, /not the mirror target/);
  assert.equal(resolvePin({ wanted: STATE, mirror: null }).code, 'BENCH_PIN_NO_MIRROR_RECORD');
  assert.equal(resolvePin({ wanted: 'xyz', mirror: lag }).code, 'BENCH_PIN_USAGE');
});

test('pinHarness: fetches the mapped Git commit into harness/<12>, and refuses a lagging mirror before touching disk', () => {
  const B = bench();
  const donor = join(B, 'cli');
  mkdirSync(join(donor, 'node_modules'), { recursive: true });
  mkdirSync(join(donor, 'dist'), { recursive: true });
  writeFileSync(join(donor, '.commit'), STATE);
  const gitCalls = [];
  const git = (dir, ...args) => {
    gitCalls.push(args.join(' '));
    if (args[0] === 'rev-parse') return GIT;
    if (args[0] === 'init') mkdirSync(join(dir, '.git'), { recursive: true });
    return '';
  };
  const out = pinHarness({ benchRoot: B, donor, forgeRoot: B, forgeCapabilities: () => mirror(), git });
  assert.equal(out.dir, join(B, 'harness', GIT.slice(0, 12)));
  assert.equal(out.stateHead, STATE);
  assert.ok(gitCalls.some(c => c === `fetch -q --depth 1 origin ${GIT}`));
  assert.ok(existsSync(join(out.dir, 'node_modules')));
  assert.ok(existsSync(join(out.dir, 'dist')), 'the cells import the built CLI from the checkout');

  const B2 = bench();
  assert.throws(
    () =>
      pinHarness({
        benchRoot: B2,
        wanted: STATE2,
        donor,
        forgeRoot: B2,
        forgeCapabilities: () => mirror({ targetHead: STATE2, lagging: true }),
        git,
      }),
    e => e.code === 'BENCH_PIN_WAITS_FOR_MIRROR' && /contain State/.test(e.waitsFor),
  );
  assert.equal(existsSync(join(B2, 'harness')), false);
});

test('version record: a State-head CLI commit matches GitHub main through the mirror mapping', () => {
  const base = {
    cli: { commit: STATE, git: null },
    githubMain: GIT,
    convexTree: { cli: 't', deploy: 't' },
    checkWorkflow: { forge: 'a', github: 'b' },
    agent: 'x',
  };
  assert.match(snapshotProblems(base, { requireFreeze: false }).join(), /no mirror mapping/);
  assert.deepEqual(
    snapshotProblems({ ...base, cli: { commit: STATE, git: GIT } }, { requireFreeze: false }),
    [],
  );
  assert.equal(cliGitCommit(STATE, parseMirror(mirror())), GIT);
  assert.equal(cliGitCommit(STATE2, parseMirror(mirror())), null);
  assert.equal(cliGitCommit(GIT, null), GIT);
});

test('every step has an id, a title, commands and a complete cost (no hidden spend)', () => {
  const B = bench();
  const steps = buildSteps(fakeContext(B).ctx);
  const ids = new Set();
  for (const s of steps) {
    assert.ok(!ids.has(s.id));
    ids.add(s.id);
    assert.ok(s.title && s.commands().length && s.cost, s.id);
    for (const k of ['repos', 'ciMinutes', 'convexCalls', 'diskGb', 'networkGb', 'minutes'])
      assert.ok(k in s.cost, `${s.id}.${k}`);
  }
  assert.deepEqual(
    steps.filter(s => s.outward).map(s => s.id),
    ['fork', 'forge-project', 'forge-check'],
  );
});

test('forge project step: a configured project that does not answer is never silently replaced', async () => {
  const B = bench();
  const cfg = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  cfg.forge.projectId = 'mh7a85j8hc472zt9gyybqq51hn8habqd';
  writeFileSync(join(B, 'config.json'), JSON.stringify(cfg));
  const f = fakeContext(B);
  const r = await runSetup(f.ctx, { only: ['forge-project'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /BENCH_SETUP_FORGE_PROJECT_EXISTS/);
  assert.match(f.lines.join('\n'), /does not answer here/);
  assert.deepEqual(
    f.calls.filter(c => /host /.test(c)),
    [],
  );
  assert.equal(readManifest(B).entries.length, 0);
});

test('base step: a bundle that does not advertise the bare commit id is fetched by ref, then verified', async () => {
  const B = bench();
  mkdirSync(join(B, 'work/t3code-meta/.git'), { recursive: true });
  const f = fakeContext(B, { baseSource: '/src/base.bundle' }, { refusesBareSha: true });
  assert.equal((await runSetup(f.ctx, { only: ['base'] })).ok, true, f.lines.join('\n'));
  assert.ok(f.calls.some(c => c.includes('fetch -q -- /src/base.bundle +refs/*:refs/bench/source/*')));
});

/** A bench whose config names a hosted project, with a fake check-settings reply. */
function hostedBench({ own, settings }) {
  const B = bench();
  const cfg = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  cfg.forge.projectId = 'p'.repeat(32);
  writeFileSync(join(B, 'config.json'), JSON.stringify(cfg));
  mkdirSync(join(B, 'work/forge-main/.forge'), { recursive: true });
  if (own)
    record(B, {
      step: 'forge-project',
      kind: 'forge-project',
      ref: 'p',
      state: 'created',
      projectId: cfg.forge.projectId,
    });
  const f = fakeContext(B);
  let current = settings;
  const writes = [];
  const base = f.ctx.sh;
  f.ctx.sh = (c, a, o) => {
    if (a[1] === 'x') {
      writes.push(a[3]);
      if (a[3] === 'configure-check')
        current = { ...current, definitions: [{ name: 'verify', definition: benchCheckDigest() }] };
      if (a[3] === 'configure-runner')
        current = {
          ...current,
          runner: {},
          actions: { repository: FORGE_RUNNER.repository, runsOn: 'ubuntu-latest' },
        };
      if (a[3] === 'set-policy') current = { ...current, agentLandsOnPass: true };
      return '{}';
    }
    return base(c, a, o);
  };
  f.ctx.tryRun = (c, a) => {
    f.calls.push(`${c} ${a.join(' ')}`);
    return a[3] === 'check-settings' ? JSON.stringify({ result: current }) : null;
  };
  return { B, f, writes };
}
const fresh = {
  definitions: [],
  runner: null,
  actions: null,
  checkCallbackConfigured: true,
  agentLandsOnPass: false,
};

test('forge-check: dry reads check-settings only; live configures check, runner and acceptance once', async () => {
  const dry = hostedBench({ own: true, settings: fresh });
  await runSetup(dry.f.ctx, { dry: true, only: ['forge-check'] });
  assert.deepEqual(dry.writes, []);
  const probe = dry.f.calls.find(call => call.includes('check-settings'));
  const config = JSON.parse(readFileSync(join(dry.B, 'config.json'), 'utf8'));
  assert.ok(
    probe.includes(JSON.stringify({ url: config.forge.url, projectId: config.forge.projectId })),
    'setup reads the configured deployment even when a retained clone points elsewhere',
  );
  assert.match(dry.f.lines.join('\n'), /to configure: check, runner, acceptance/);
  assert.match(dry.f.lines.join('\n'), /bash \.bench\/ci\.sh/);
  const live = hostedBench({ own: true, settings: fresh });
  const r = await runSetup(live.f.ctx, { only: ['forge-check'] });
  assert.equal(r.ok, true, live.f.lines.join('\n'));
  assert.deepEqual(live.writes, ['configure-check', 'configure-runner', 'set-policy']);
  const again = await runSetup(live.f.ctx, { only: ['forge-check'] });
  assert.equal(again.results[0].status, 'done');
  assert.equal(live.writes.length, 3, 'a rerun changes nothing');
});

test('forge-check never changes a project setup did not host', async () => {
  const { f, writes } = hostedBench({ own: false, settings: fresh });
  const r = await runSetup(f.ctx, { only: ['forge-check'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /BENCH_SETUP_CHECK_NOT_OURS/);
  assert.deepEqual(writes, []);
});

/** A bench with no project yet, whose fake import and clone succeed. */
function importBench({ importResult, answers = false, projectId } = {}) {
  const B = bench();
  if (projectId) {
    const cfg = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
    cfg.forge.projectId = projectId;
    writeFileSync(join(B, 'config.json'), JSON.stringify(cfg));
  }
  const f = fakeContext(B, { replaceForgeProject: true });
  const base = f.ctx.sh;
  let imported = false;
  const out = (c, a, o) => {
    if (/forge-import\.mjs$/.test(a[0])) {
      f.calls.push(`${c} ${a.join(' ')}`);
      imported = true;
      return JSON.stringify(
        importResult ?? { projectId: 'n'.repeat(32), phase: 'ready', commit: BASE, files: 3 },
      );
    }
    if (a[1] === 'clone') {
      f.calls.push(`${c} ${a.join(' ')}`);
      mkdirSync(join(a[3], '.forge'), { recursive: true });
      return '';
    }
    if (a[1] === 'agent' && a[3] === 'capabilities') {
      f.calls.push(`${c} ${a.join(' ')}`);
      // The imported project answers with a ready main; a replaced one does not.
      return answers || imported
        ? JSON.stringify({ result: { mainReady: true } })
        : JSON.stringify({ error: { code: 'NOT_FOUND' } });
    }
    return base(c, a, o);
  };
  f.ctx.sh = out;
  f.ctx.tryOut = out;
  f.ctx.tryRun = (c, a, o) => {
    try {
      return out(c, a, o);
    } catch {
      return null;
    }
  };
  return { B, f };
}

test('forge-project: imports the fork at the base commit, clones it, patches config; a rerun changes nothing', async () => {
  const { B, f } = importBench();
  const r = await runSetup(f.ctx, { only: ['forge-project'] });
  assert.equal(r.ok, true, f.lines.join('\n'));
  const imp = f.calls.find(c => /forge-import\.mjs/.test(c));
  assert.ok(imp.includes(`"url":"https://github.com/${repository}"`) && imp.includes(`"ref":"${BASE}"`), imp);
  assert.ok(
    f.calls.some(c => c.includes(` clone ${'n'.repeat(32)} ${join(B, 'work/forge-main')} --deployment`)),
  );
  assert.equal(f.calls.filter(c => / host /.test(c)).length, 0, 'a Git-format host leaves no ready main');
  const cfg = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  assert.equal(cfg.forge.projectId, 'n'.repeat(32));
  const created = readManifest(B).entries.find(e => e.kind === 'forge-project' && e.state === 'created');
  assert.equal(created.via, 'github-import');
  assert.equal(created.root, join(B, 'work/forge-main'));
  // The project now answers with a ready main and the clone exists: nothing more to do.
  const again = importBench({ answers: true });
  again.f.ctx.B = B;
  const n = f.calls.length;
  const steps = buildSteps({ ...again.f.ctx, B });
  assert.equal((await steps.find(s => s.id === 'forge-project').isDone()).done, true);
  assert.equal(f.calls.length, n);
});

test('forge-project: a failed or wrong-base import stops before any clone or config change', async () => {
  for (const [importResult, code] of [
    [{ phase: 'failed', error: { code: 'X' } }, /BENCH_SETUP_IMPORT_FAILED/],
    [{ projectId: 'n'.repeat(32), phase: 'ready', commit: 'e'.repeat(40) }, /BENCH_SETUP_IMPORT_WRONG_BASE/],
  ]) {
    const { B, f } = importBench({ importResult });
    const r = await runSetup(f.ctx, { only: ['forge-project'] });
    assert.equal(r.ok, false);
    assert.match(r.error, code);
    assert.ok(!f.calls.some(c => / clone /.test(c)));
    assert.equal(JSON.parse(readFileSync(join(B, 'config.json'), 'utf8')).forge.projectId, undefined);
  }
});

test('forge-project: replacing a project sets its finished import journal aside, never reuses it', async () => {
  const old = 'o'.repeat(32);
  const { B, f } = importBench({ projectId: old });
  mkdirSync(join(B, 'work'), { recursive: true });
  writeFileSync(
    join(B, 'work/forge-import.json'),
    JSON.stringify({ status: { phase: 'ready', projectId: old } }),
  );
  assert.equal((await runSetup(f.ctx, { only: ['forge-project'] })).ok, true, f.lines.join('\n'));
  assert.equal(existsSync(join(B, 'work/forge-import.json')), false);
  assert.equal(JSON.parse(readFileSync(join(B, 'config.json'), 'utf8')).forge.projectId, 'n'.repeat(32));
});

test('forge-check: an unconnected runner repository names the owner step, with the exact command', async () => {
  const { B, f, writes } = hostedBench({ own: true, settings: {} });
  const base = f.ctx.sh;
  f.ctx.sh = (c, a, o) => {
    if (a[3] === 'configure-runner') {
      const e = Error('exit 1');
      // As the real CLI does: the error JSON on stderr, nothing on stdout.
      e.stdout = '';
      e.stderr = JSON.stringify({ error: { code: 'GITHUB_REPOSITORY_UNBOUND', message: 'x' } });
      throw e;
    }
    return base(c, a, o);
  };
  const r = await runSetup(f.ctx, { only: ['forge-check'] });
  assert.equal(r.ok, false);
  assert.match(r.error, /BENCH_SETUP_OWNER_STEP/);
  assert.match(
    r.error,
    new RegExp(
      `nforge github connect ${'p'.repeat(32)} --url https://x.convex.cloud --repo ${FORGE_RUNNER.repository}`,
    ),
  );
  assert.ok(writes.includes('configure-check'));
  rmSync(B, { recursive: true, force: true });
});

test('meta and base-checkout record their folders in config (the gates read config.meta / baseCheckout)', async () => {
  const B = bench();
  mkdirSync(join(B, 'work/t3code-meta/.git'), { recursive: true });
  const f = fakeContext(B);
  assert.equal((await runSetup(f.ctx, { only: ['meta'] })).ok, true, f.lines.join('\n'));
  assert.ok(!f.calls.some(c => / clone /.test(c)), 'an existing meta repo is not cloned again');
  const cfg = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  assert.equal(cfg.meta, join(B, 'work/t3code-meta'));
  const patch = readManifest(B).entries.find(e => e.kind === 'config-patch' && e.ref === 'meta');
  assert.deepEqual([patch.hadKey, patch.after], [false, cfg.meta]);
});

test('forge import: resumes on the journal job id, polls to ready, and a finished journal makes no call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-import-'));
  try {
    const journalPath = join(dir, 'j.json');
    const seen = [];
    const phases = ['fetching', 'ready'];
    const client = {
      action: async (name, args) => {
        seen.push([name, args]);
        if (name === 'start') return 'job1';
        const phase = phases.shift();
        return { phase, projectId: phase === 'ready' ? 'P' : null, commit: BASE, total: 3, totalBytes: 9 };
      },
    };
    let t = 0;
    const spec = { url: 'u', ref: BASE, name: 'n' };
    const r = await importProject({
      client,
      ref: n => n.split(':')[1],
      journalPath,
      spec,
      now: () => t,
      sleep: async ms => {
        t += ms;
      },
    });
    assert.deepEqual([r.projectId, r.phase, r.calls, r.files], ['P', 'ready', 3, 3]);
    assert.equal(seen[0][1].operationId, JSON.parse(readFileSync(journalPath, 'utf8')).operationId);
    const before = seen.length;
    const again = await importProject({ client, ref: n => n, journalPath, spec, sleep: async () => {} });
    assert.deepEqual([again.projectId, again.calls, seen.length], ['P', 0, before]);
    // A journal with a job id but no end resumes polling without a second start.
    writeFileSync(journalPath, JSON.stringify({ operationId: 'op', jobId: 'job1' }));
    phases.push('ready');
    seen.length = 0;
    await importProject({ client, ref: n => n.split(':')[1], journalPath, spec, sleep: async () => {} });
    assert.deepEqual(
      seen.map(s => s[0]),
      ['status'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bench scripts run through a symlinked install: the main guard compares real paths', async () => {
  const { isMainModule } = await import('../scripts/main-module.mjs');
  const { symlinkSync, realpathSync } = await import('node:fs');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const script = new URL('../scripts/bench-t3code/forge-import.mjs', import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), 'bench-link-'));
  symlinkSync(join(fileURLToPath(script), '..'), join(directory, 'current'));
  const linked = join(directory, 'current', 'forge-import.mjs');
  // Node names the main module by its real path, so argv[1] must be resolved before comparing.
  const real = pathToFileURL(realpathSync(fileURLToPath(script))).href;
  assert.notEqual(pathToFileURL(linked).href, real);
  assert.equal(isMainModule(real, linked), true);
  assert.equal(isMainModule(real, join(directory, 'missing.mjs')), false);
  assert.equal(isMainModule(real, undefined), false);
});
