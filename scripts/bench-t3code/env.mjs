// SPDX-License-Identifier: Apache-2.0
// B1.5d bench environment (Issue e082f30a): everything a bench needs that lives outside the
// harness code, built from scratch by `setup` and removed by `teardown`.
//   steps    ordered; each has isDone() (read-only), commands (printed by --dry), a cost, run()
//   manifest BENCH_ROOT/setup-manifest.json: one entry per thing setup created; written ahead
//            of each creation, so a crash leaves an entry teardown can resolve
//   teardown deletes only manifest entries, each re-verified as setup's own first
// Nothing here is a benchmark input: the base tree, tasks.json, PLAN.md and config.json stay
// private/owner-held (evals/bench-t3code/README.md); setup refuses to run without them.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { networkFetch } from '../../dist/network-fetch.js';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { checkPlan, planPath } from './plan.mjs';
import { sharedDeps, buildSharedDeps } from './deps.mjs';
import { repository, rulesetName } from './github-arm.mjs';
import { pinHarness, existingPin, cliDonor, cliCommit, parseMirror } from './pin.mjs';
import { benchCli, builderInstallations } from './cli-install.mjs';

export const UPSTREAM = 'pingdotgg/t3code';
export const MANIFEST = 'setup-manifest.json';
export const SETUP_COMMAND = 'scripts/bench-t3code/setup';
export const TEARDOWN_COMMAND = 'scripts/bench-t3code/teardown';
export const NODE_MIN = [24, 22, 1];
export const GH_SCOPES = ['repo', 'delete_repo', 'workflow'];
const INSTALLER_URL = 'https://viteplus.dev/install.sh';
const SHA40 = /^[0-9a-f]{40}$/;

/** The merge-queue ruleset the GitHub arm relies on (github-arm.mjs header: HEADGREEN, 10/10,
 * squash, required check `bench-check`). Fields the plan does not state use GitHub defaults. */
export const rulesetBody = () => ({
  name: rulesetName,
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    {
      type: 'merge_queue',
      parameters: {
        check_response_timeout_minutes: 30,
        grouping_strategy: 'HEADGREEN',
        max_entries_to_build: 10,
        max_entries_to_merge: 10,
        merge_method: 'SQUASH',
        min_entries_to_merge: 1,
        min_entries_to_merge_wait_minutes: 1,
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [{ context: 'bench-check' }],
      },
    },
  ],
});

/** The Forge bench project's check (plan "Same check": `bash .bench/ci.sh`, as the GitHub arm's
 * required `bench-check`) and the runner it runs on (Forge's GitHub Actions runner, forge-check.yml,
 * whose runs the Forge arm reads from this repository). */
export const BENCH_CHECK = Object.freeze({
  name: 'verify',
  executable: 'bash',
  args: ['.bench/ci.sh'],
  environmentLabel: 'B1.5d bench check',
});
/** The definition digest Forge records for BENCH_CHECK (src/hosted-check.ts hostedCheckDefinition). */
export const benchCheckDigest = () =>
  createHash('sha256')
    .update(
      JSON.stringify({
        name: BENCH_CHECK.name,
        executable: BENCH_CHECK.executable,
        args: BENCH_CHECK.args,
        environmentLabel: BENCH_CHECK.environmentLabel,
      }),
    )
    .digest('hex');
export const FORGE_RUNNER = Object.freeze({ repository: 'NanthAI/nanthai-forge', runsOn: 'ubuntu-latest' });

/** What check-settings still lacks for the bench: { done, missing[], problems[] }. Pure. */
export function checkSettingsState(s) {
  const missing = [];
  const problems = [];
  const verify = (s.definitions ?? []).find(d => d.name === BENCH_CHECK.name);
  if (!verify) missing.push('check');
  else if (verify.definition !== benchCheckDigest())
    problems.push(
      `check ${BENCH_CHECK.name} has definition ${String(verify.definition).slice(0, 12)}, not the bench check ${benchCheckDigest().slice(0, 12)}; setup does not overwrite a check it did not define`,
    );
  if (!s.runner) missing.push('runner');
  else if (s.actions?.repository !== FORGE_RUNNER.repository || s.actions?.runsOn !== FORGE_RUNNER.runsOn)
    problems.push(
      `runner is ${s.actions ? `${s.actions.repository} (${s.actions.runsOn})` : 'not GitHub Actions'}, the bench needs ${FORGE_RUNNER.repository} (${FORGE_RUNNER.runsOn})`,
    );
  if (s.agentLandsOnPass === false) missing.push('acceptance');
  if (s.checkCallbackConfigured === false)
    problems.push(
      'the deployment has no hosted check key (FORGE_HOSTED_CHECK_KEY_ID): the lead sets it, setup cannot',
    );
  const done = !missing.length && !problems.length;
  return {
    done,
    missing,
    ...(problems.length ? { problems } : {}),
    ...(done ? {} : missing.length ? { detail: `to configure: ${missing.join(', ')}` } : {}),
  };
}

/* ------------------------------------------------------------------ manifest */

export const manifestPath = B => join(B, MANIFEST);
export function readManifest(B) {
  try {
    const m = JSON.parse(readFileSync(manifestPath(B), 'utf8'));
    if (m?.schema === 1 && Array.isArray(m.entries)) return m;
  } catch {}
  return { schema: 1, bench: B, entries: [] };
}
export function writeManifest(B, m) {
  mkdirSync(B, { recursive: true });
  const tmp = `${manifestPath(B)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 1) + '\n');
  renameSync(tmp, manifestPath(B));
}
/** Record (or update by step+ref) one created thing, durably, before and after creation. */
export function record(B, entry) {
  const m = readManifest(B);
  const i = m.entries.findIndex(e => e.step === entry.step && e.ref === entry.ref);
  if (i >= 0) m.entries[i] = { ...m.entries[i], ...entry };
  else m.entries.push(entry);
  writeManifest(B, m);
}

/* ------------------------------------------------------------------ context */

const run = (cmd, args, { cwd, input, env } = {}) =>
  execFileSync(cmd, args, {
    cwd,
    input,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

/** The real context. Tests pass fakes for sh/forge/clock. */
export function realContext(B, flags = {}) {
  const counts = {};
  const counted = (cmd, args) => {
    const key =
      cmd.endsWith('/node') && /cli-entry/.test(args[0] ?? '') ? 'nforge (Convex)' : cmd.split('/').at(-1);
    counts[key] = (counts[key] ?? 0) + 1;
  };
  return {
    B,
    flags,
    counts,
    home: homedir(),
    now: () => new Date().toISOString(),
    sh: (cmd, args, opts) => (counted(cmd, args), run(cmd, args, opts)),
    // The command's stdout even when it exits non-zero (the Forge CLI prints its error as JSON).
    tryOut(cmd, args, opts) {
      try {
        counted(cmd, args);
        return run(cmd, args, opts);
      } catch (error) {
        return String(error.stdout ?? '') || null;
      }
    },
    // null on failure: reads that mean "not there yet".
    tryRun(cmd, args, opts) {
      try {
        counted(cmd, args);
        return run(cmd, args, opts);
      } catch {
        return null;
      }
    },
    diskFreeGb: () => {
      const line = run('df', ['-k', '/System/Volumes/Data']).split('\n').at(-1).trim().split(/\s+/);
      return Number(line[3]) / 1024 / 1024;
    },
    nodeVersion: () => process.version,
    fetchText: async url => (await networkFetch(url)).text(),
    log: console.log,
  };
}

const readConfig = B => JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
const writeConfig = (B, cfg) => {
  const tmp = join(B, `config.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, join(B, 'config.json'));
};
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => {
  const ks = p.split('.');
  const last = ks.pop();
  const parent = ks.reduce((a, k) => (a[k] ??= {}), o);
  if (v === undefined) delete parent[last];
  else parent[last] = v;
};
/** Patch config.json and record each key's previous value so teardown can restore it. */
function patchConfig(ctx, step, patches) {
  const cfg = readConfig(ctx.B);
  const m = readManifest(ctx.B);
  for (const [path, value] of Object.entries(patches)) {
    const before = getPath(cfg, path);
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    const prior = m.entries.find(e => e.kind === 'config-patch' && e.ref === path);
    record(ctx.B, {
      step,
      kind: 'config-patch',
      ref: path,
      before: prior ? prior.before : before === undefined ? null : before,
      hadKey: prior ? prior.hadKey : before !== undefined,
      after: value,
      at: ctx.now(),
    });
    setPath(cfg, path, value);
  }
  writeConfig(ctx.B, cfg);
}

/* ------------------------------------------------------------------ steps */

const COST0 = { repos: 0, ciMinutes: 0, convexCalls: 0, diskGb: 0, networkGb: 0, minutes: 0 };

/** Derived locations and values, from config.json with the historical defaults. */
export function layout(B, cfg) {
  return {
    meta: cfg.meta ?? join(B, 'work/t3code-meta'),
    baseCheckout: cfg.baseCheckout ?? join(B, 'work/base-F'),
    // The bench project's clone (forge-project): check settings and policy run against it.
    forgeMain: cfg.forgeMain ?? join(B, 'work/forge-main'),
    importJournal: join(B, 'work/forge-import.json'),
    deps: join(B, 'deps'),
    installer: join(B, 'deps-installer.sh'),
    baseSha: cfg.github?.mainBase ?? null,
    forgeUrl: cfg.forge?.url ?? null,
    forgeName: cfg.forge?.projectName ?? 'b15d-t3code-hosted',
  };
}

/** `v24.22.1` >= [24,22,1], compared left to right. */
export function versionAtLeast(version, min) {
  const cur = String(version).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < min.length; i++) {
    if ((cur[i] ?? 0) > min[i]) return true;
    if ((cur[i] ?? 0) < min[i]) return false;
  }
  return true;
}

const sha256 = text => createHash('sha256').update(text).digest('hex');
/** The last JSON object line a command printed, or null. */
const jsonLast = out => {
  const line = String(out ?? '')
    .split('\n')
    .filter(l => l.startsWith('{'))
    .at(-1);
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
};

export function buildSteps(ctx) {
  const { B, flags } = ctx;
  const cfg = () => readConfig(B);
  const cfgSafe = () => {
    try {
      return readConfig(B);
    } catch {
      return {};
    }
  };
  const L = () => layout(B, cfgSafe());
  const donor = () => cliDonor({ explicit: process.env.FORGE_CLI_HOME, config: cfgSafe() });
  const forgeRoot = dirname(dirname(import.meta.dirname));
  const baseSource = flags.baseSource ?? null;
  const git = (dir, ...args) => ctx.sh('git', ['-C', dir, ...args]);
  const gitOk = (dir, ...args) => ctx.tryRun('git', ['-C', dir, ...args]);
  const gh = (...args) => ctx.sh('gh', args);
  const ghOk = (...args) => ctx.tryRun('gh', args);
  const forgeCap = () => {
    const probe = mkdtempSync(join(tmpdir(), 'forge-bench-setup-probe-'));
    try {
      const out = (ctx.tryOut ?? ctx.tryRun)('/usr/local/bin/node', [
        cfgSafe().forge?.cli ?? join(donor(), 'dist/cli-entry.js'),
        'agent',
        probe,
        'capabilities',
        JSON.stringify({ url: cfgSafe().forge?.url, projectId: cfgSafe().forge?.projectId }),
        '--detail',
      ]);
      const line = out
        ?.split('\n')
        .filter(l => l.startsWith('{'))
        .at(-1);
      try {
        return line ? JSON.parse(line) : null;
      } catch {
        return null;
      }
    } finally {
      for (const path of [probe, `${probe}.forge-client`, `${probe}.forge-metrics.jsonl`])
        rmSync(path, { recursive: true, force: true });
    }
  };
  const repoInfo = () => {
    const out = ghOk(
      'api',
      `repos/${repository}`,
      '--jq',
      '{id,created_at,default_branch,fork,visibility,parent:.parent.full_name}',
    );
    try {
      return out ? JSON.parse(out) : null;
    } catch {
      return null;
    }
  };
  const ownedRepo = () => {
    const e = readManifest(B).entries.find(x => x.kind === 'github-repo' && x.ref === repository);
    return e ?? null;
  };

  const steps = [];
  const step = s => steps.push(s);

  step({
    id: 'prereqs',
    title: 'Machine and credentials',
    outward: false,
    cost: { ...COST0, note: 'reads only: gh auth status (names), node version, tool presence, disk' },
    commands: () => [
      'gh auth status (scope names only)',
      'node >= 24.22.1',
      'git, rsync, curl present',
      'disk >= 40 GiB reserve + this setup',
    ],
    needsDiskGb: 12,
    isDone: async () => {
      const bad = [];
      if (!versionAtLeast(ctx.nodeVersion(), NODE_MIN))
        bad.push(`node ${ctx.nodeVersion()} is older than ${NODE_MIN.join('.')} (patched Node only)`);
      for (const tool of ['git', 'rsync', 'curl'])
        if (ctx.tryRun('which', [tool]) === null) bad.push(`${tool} not found`);
      const auth = ctx.tryRun('gh', ['auth', 'status']) ?? '';
      const scopes = (auth.match(/Token scopes:\s*(.*)/)?.[1] ?? '').replace(/'/g, '').split(/,\s*/);
      const missing = GH_SCOPES.filter(s => !scopes.includes(s));
      if (!auth) bad.push('gh is not logged in (gh auth login)');
      else if (missing.length)
        bad.push(`gh token lacks scope(s): ${missing.join(', ')} (gh auth refresh -s ${missing.join(',')})`);
      const need = 40 + 12;
      const free = ctx.diskFreeGb();
      if (free < need)
        bad.push(`disk ${free.toFixed(1)} GiB free, need ${need} (40 reserve + about 12 for this setup)`);
      return bad.length ? { done: false, problems: bad } : { done: true };
    },
    run: async () => {
      throw Error('prereqs are checked, not fixed: resolve the listed problems');
    },
    blocking: true,
  });

  step({
    id: 'inputs',
    title: 'Owner-held inputs: config.json, PLAN.md, tasks.json',
    outward: false,
    cost: {
      ...COST0,
      note: 'copies PLAN.md (byte for byte) from the committed plan if absent; nothing else is created',
    },
    commands: () => [
      `copy ${relative(forgeRoot, planPath())} -> BENCH_ROOT/PLAN.md (if absent)`,
      'require config.json (forge.url, forge.deployment, forge.cli, agent), tasks.json',
    ],
    isDone: async () => {
      const problems = [];
      let c;
      try {
        c = readConfig(B);
      } catch {
        return {
          done: false,
          problems: [
            `${join(B, 'config.json')} is missing: owner-held, see evals/bench-t3code/README.md ("What to recover")`,
          ],
        };
      }
      if (c.github?.repository !== repository)
        problems.push(
          `config.github.repository is ${c.github?.repository}, the GitHub arm is hard-wired to ${repository}`,
        );
      for (const k of ['forge.url', 'forge.deployment', 'forge.cli', 'agent.provider'])
        if (!getPath(c, k)) problems.push(`config.${k} missing`);
      if (!SHA40.test(c.github?.mainBase ?? ''))
        problems.push('config.github.mainBase is not a full Git commit id');
      if (!existsSync(join(B, 'tasks.json')))
        problems.push(
          `${join(B, 'tasks.json')} missing: owner-held frozen task set (README "What to recover")`,
        );
      if (problems.length) return { done: false, problems };
      if (!existsSync(join(B, 'PLAN.md'))) return { done: false, problems: [], canCopyPlan: true };
      const planProblems = checkPlan(B);
      return planProblems.length ? { done: false, problems: planProblems } : { done: true };
    },
    run: async () => {
      // Only the plan is ours to create; the rest are owner inputs.
      if (!existsSync(join(B, 'PLAN.md'))) {
        copyFileSync(planPath(), join(B, 'PLAN.md'));
        record(B, { step: 'inputs', kind: 'file', ref: join(B, 'PLAN.md'), at: ctx.now() });
      }
    },
    blocking: true,
  });

  // The bench's own CLI installation (Issue 2e1f5fbd): its measurement hold and updates stay
  // there, so the bench never holds builders' landings, launcher or hooks.
  const benchCliDir = join(B, 'cli');
  step({
    id: 'bench-cli',
    title: "The bench's own Forge CLI installation (BENCH_ROOT/cli)",
    outward: false,
    cost: {
      ...COST0,
      convexCalls: 3,
      diskGb: 1,
      networkGb: 0.2,
      minutes: 2,
      note: "one product CLI install from Forge main (release and signature read, paged source download); the builders' installation, launcher and hooks are not changed",
    },
    commands: () => [
      `copy <builders' installation>/source.json -> ${benchCliDir}/source.json (the Forge source project's url and id; no secret)`,
      `node <builders' installation>/launcher.mjs update --directory ${benchCliDir} --bin ${join(benchCliDir, 'bin', 'nforge')}`,
      `patch config.forge.cli -> ${join(benchCliDir, 'current', 'dist', 'cli-entry.js')}`,
    ],
    isDone: async () => {
      try {
        benchCli({ config: cfgSafe() });
        return { done: true };
      } catch (error) {
        return { done: false, detail: String(error.message).slice(0, 300) };
      }
    },
    run: async () => {
      const from = builderInstallations().find(dir => existsSync(join(dir, 'source.json')));
      if (!from)
        throw Error(
          'BENCH_SETUP_NO_CLI_SOURCE: no installed Forge CLI with a configured source to copy (nforge update FORGE_CHECKOUT, docs/operations/cli-update.md)',
        );
      if (!existsSync(benchCliDir)) {
        record(B, { step: 'bench-cli', kind: 'path', ref: benchCliDir, at: ctx.now() });
        mkdirSync(benchCliDir, { recursive: true, mode: 0o700 });
      }
      if (!existsSync(join(benchCliDir, 'source.json')))
        copyFileSync(join(from, 'source.json'), join(benchCliDir, 'source.json'));
      ctx.sh('/usr/local/bin/node', [
        join(from, 'launcher.mjs'),
        'update',
        '--directory',
        benchCliDir,
        '--bin',
        join(benchCliDir, 'bin', 'nforge'),
      ]);
      patchConfig(ctx, 'bench-cli', { 'forge.cli': join(benchCliDir, 'current', 'dist', 'cli-entry.js') });
    },
  });

  step({
    id: 'pin',
    title: 'Harness pin from Forge main (State head -> mirror Git commit)',
    outward: false,
    cost: {
      ...COST0,
      convexCalls: 1,
      networkGb: 0.05,
      diskGb: 0.05,
      minutes: 1,
      note: 'one capabilities read for the mirror record; one depth-1 fetch (~44 MB at B1.5d)',
    },
    commands: () => [
      'nforge agent <forge root> capabilities  # githubMirror.mirroredHead -> gitHead',
      'git fetch --depth 1 https://github.com/NanthAI/nanthai-forge <gitHead>',
      'link node_modules to the CLI build',
    ],
    isDone: async () => {
      const want = cliCommit(donor());
      const mirror =
        want && /^[0-9a-f]{64}$/.test(want) ? parseMirror(readCapsFor(ctx, forgeRoot, donor())) : null;
      const p = existingPin({ benchRoot: B, wanted: undefined, donor: donor(), mirror });
      return p.done
        ? { done: true, dir: p.dir }
        : p.reason
          ? { done: false, problems: [p.reason], waitsFor: p.waitsFor }
          : {
              done: false,
              detail: `would pin Git ${p.gitSha?.slice(0, 12)} (mirror record of State ${want?.slice(0, 12)}) at ${p.dir}`,
            };
    },
    run: async () => {
      const out = pinHarness({ benchRoot: B, donor: donor(), forgeRoot });
      record(B, { step: 'pin', kind: 'path', ref: out.dir, at: ctx.now() });
    },
  });

  step({
    id: 'meta',
    title: 'Meta repo (blobless clone of upstream t3code)',
    outward: false,
    cost: {
      ...COST0,
      networkGb: 0.6,
      diskGb: 1.0,
      minutes: 5,
      note: 'estimate: blobless history; blobs arrive on demand. No CI, no Convex.',
    },
    commands: () => [`git clone --filter=blob:none --no-checkout https://github.com/${UPSTREAM} ${L().meta}`],
    // config.meta is read directly by the gates, run-cell and preflight: done means it is set.
    isDone: async () => ({ done: existsSync(join(L().meta, '.git')) && Boolean(cfgSafe().meta) }),
    run: async () => {
      const dir = L().meta;
      if (!existsSync(join(dir, '.git'))) {
        record(B, { step: 'meta', kind: 'path', ref: dir, at: ctx.now(), state: 'creating' });
        mkdirSync(dirname(dir), { recursive: true });
        ctx.sh('git', [
          'clone',
          '-q',
          '--filter=blob:none',
          '--no-checkout',
          `https://github.com/${UPSTREAM}`,
          dir,
        ]);
        record(B, { step: 'meta', kind: 'path', ref: dir, state: 'created' });
      }
      patchConfig(ctx, 'meta', { meta: dir });
    },
  });

  step({
    id: 'base',
    title: 'Base commit in the meta repo (owner-held source)',
    outward: false,
    cost: {
      ...COST0,
      diskGb: 0.1,
      minutes: 1,
      note: 'fetched from the owner-held --base-source; fa3b7349 is in no retained upstream object',
    },
    commands: () => [
      baseSource
        ? `git -C ${L().meta} fetch ${baseSource} ${L().baseSha ?? '<base>'}  # a git repo or bundle holding the base commit`
        : 'requires --base-source PATH (git repo or bundle holding config.github.mainBase)',
    ],
    isDone: async () => {
      const sha = L().baseSha;
      if (!sha || !existsSync(join(L().meta, '.git'))) return { done: false };
      return { done: gitOk(L().meta, 'cat-file', '-e', `${sha}^{commit}`) !== null };
    },
    run: async () => {
      if (!baseSource)
        throw Error(
          `BENCH_SETUP_NEEDS_BASE: the base commit ${L().baseSha?.slice(0, 12) ?? '(config.github.mainBase unset)'} is not in the meta repo. ` +
            'Pass --base-source PATH (a git repo or bundle that holds it). The base is not rebuildable from upstream (evals/bench-t3code/README.md: fa3b7349 reconstruction is unproven); ' +
            'a rebuilt tree with a new commit id needs --new-base and is a new base: it must be registered in the plan before any scored cell.',
        );
      const sha = L().baseSha;
      // `--` so a source path can never be read as an option. A bundle or a server that does not
      // advertise the bare commit id is fetched by ref instead, then the id is verified.
      try {
        git(L().meta, 'fetch', '-q', '--', baseSource, flags.newBase ? 'HEAD' : sha);
      } catch (error) {
        if (flags.newBase) throw error;
        git(L().meta, 'fetch', '-q', '--', baseSource, '+refs/*:refs/bench/source/*');
      }
      const got = flags.newBase ? git(L().meta, 'rev-parse', 'FETCH_HEAD') : sha;
      if (gitOk(L().meta, 'cat-file', '-e', `${got}^{commit}`) === null)
        throw Error(`BENCH_SETUP_BASE_MISSING: ${baseSource} does not hold ${got}`);
      if (flags.newBase && got !== sha) {
        git(L().meta, 'update-ref', `refs/bench/base-${got.slice(0, 12)}`, got);
        patchConfig(ctx, 'base', {
          'github.previousMainBase': sha,
          'github.mainBase': got,
          'forge.previousMainBase': cfg().forge?.mainBase,
          'forge.mainBase': got,
        });
      } else git(L().meta, 'update-ref', `refs/bench/base-${sha.slice(0, 12)}`, sha);
      record(B, {
        step: 'base',
        kind: 'git-ref',
        ref: `${L().meta}#refs/bench/base-${got.slice(0, 12)}`,
        sha: got,
        newBase: Boolean(flags.newBase && got !== sha),
        at: ctx.now(),
      });
    },
    blocking: true,
  });

  step({
    id: 'base-checkout',
    title: 'Base checkout (config.baseCheckout, the lockfile source for deps)',
    outward: false,
    cost: {
      ...COST0,
      diskGb: 0.6,
      minutes: 2,
      networkGb: 0.2,
      note: 'full tree incl. .repos (~0.5 GB); missing blobs fetch from upstream',
    },
    commands: () => [
      `git clone --shared ${L().meta} ${L().baseCheckout}`,
      `git -C ${L().baseCheckout} checkout --detach <base>`,
    ],
    isDone: async () => {
      const dir = L().baseCheckout;
      return {
        done:
          existsSync(join(dir, '.git')) &&
          gitOk(dir, 'rev-parse', 'HEAD') === L().baseSha &&
          existsSync(join(dir, 'pnpm-lock.yaml')) &&
          Boolean(cfgSafe().baseCheckout),
      };
    },
    run: async () => {
      const dir = L().baseCheckout;
      if (!existsSync(join(dir, '.git'))) {
        record(B, { step: 'base-checkout', kind: 'path', ref: dir, at: ctx.now(), state: 'creating' });
        ctx.sh('git', ['clone', '-q', '--shared', '--no-checkout', L().meta, dir]);
        record(B, { step: 'base-checkout', kind: 'path', ref: dir, state: 'created' });
      }
      if (gitOk(dir, 'rev-parse', 'HEAD') !== L().baseSha)
        git(dir, 'checkout', '-q', '--detach', L().baseSha);
      patchConfig(ctx, 'base-checkout', { baseCheckout: dir });
    },
  });

  step({
    id: 'deps',
    title: 'Shared toolchain, filtered install and Chromium (deps/)',
    outward: false,
    cost: {
      ...COST0,
      diskGb: 8,
      networkGb: 3,
      minutes: 25,
      note: 'ESTIMATE (the B1.5d install was not size-recorded): Vite+ toolchain, pnpm store for six packages, Chromium headless shell. No CI, no Convex.',
    },
    commands: () => [
      `curl ${INSTALLER_URL} -> ${L().installer}  # then STOP: review it, re-run with --installer-sha256 <sha256 of that file>`,
      'bash <reviewed installer> with HOME/VP_HOME inside deps/ (never your shell profile)',
      `vp env use 26.12.1; vp install --filter <six packages>...; playwright install --only-shell chromium`,
    ],
    isDone: async () => ({
      done: Boolean(existsSync(join(L().baseCheckout, 'pnpm-lock.yaml')) && sharedDeps(B, L().baseCheckout)),
    }),
    run: async () => {
      const text = existsSync(L().installer)
        ? readFileSync(L().installer, 'utf8')
        : await ctx.fetchText(INSTALLER_URL);
      if (!existsSync(L().installer)) writeFileSync(L().installer, text);
      const hash = sha256(text);
      if (flags.installerSha256 !== hash)
        throw Error(
          `BENCH_SETUP_REVIEW_INSTALLER: ${L().installer} (sha256 ${hash}) is fetched from ${INSTALLER_URL} and runs as code. ` +
            `Read it, then re-run with --installer-sha256 ${hash}.`,
        );
      record(B, { step: 'deps', kind: 'path', ref: L().deps, at: ctx.now(), state: 'creating' });
      buildSharedDeps(B, L().baseCheckout, L().installer);
      record(B, { step: 'deps', kind: 'path', ref: L().deps, state: 'created' });
      record(B, { step: 'deps', kind: 'path', ref: L().installer, at: ctx.now() });
    },
    blocking: true,
  });

  step({
    id: 'fork',
    title: `Temporary public fork ${repository}: base on main, Actions, ruleset ${rulesetName}`,
    outward: true,
    cost: {
      ...COST0,
      repos: 1,
      ciMinutes: 0,
      networkGb: 0.05,
      minutes: 3,
      note: 'creates 1 PUBLIC repo (deleted by teardown after the bench: standing rule). Setup itself runs no CI; the base-green qualification belongs to the exit bench dry run (3 runs, ~2-2.5 min of free public-runner time each).',
    },
    commands: () => [
      `gh repo fork ${UPSTREAM} --org ${repository.split('/')[0]} --fork-name ${repository.split('/')[1]} --default-branch-only --clone=false`,
      `gh api -X PUT repos/${repository}/actions/permissions -F enabled=true -f allowed_actions=all`,
      `gh api -X PATCH repos/${repository} -F allow_auto_merge=true -F allow_squash_merge=true -F has_wiki=false -F has_issues=false`,
      `git -C ${L().meta} push --force fork ${L().baseSha?.slice(0, 12) ?? '<base>'}:refs/heads/main   # before the ruleset exists`,
      `gh api -X POST repos/${repository}/rulesets  # ${rulesetName}: merge queue HEADGREEN 10/10 squash + required check bench-check`,
    ],
    isDone: async () => {
      const info = repoInfo();
      if (!info) return { done: false };
      const own = ownedRepo();
      if (!own)
        return {
          done: false,
          conflict: `${repository} exists but is not in ${MANIFEST}: setup will not adopt or delete a repo it did not create (delete it by hand or choose another BENCH_ROOT)`,
        };
      const main = ghOk('api', `repos/${repository}/branches/main`, '--jq', '.commit.sha');
      const rs = ghOk(
        'api',
        `repos/${repository}/rulesets`,
        '--jq',
        `[.[] | select(.name=="${rulesetName}")] | length`,
      );
      return { done: main === L().baseSha && Number(rs) > 0 };
    },
    run: async () => {
      const existing = repoInfo();
      if (existing && !ownedRepo())
        throw Error(`BENCH_SETUP_REPO_NOT_OURS: ${repository} already exists and is not in the manifest`);
      const [org, name] = repository.split('/');
      if (!existing) {
        record(B, {
          step: 'fork',
          kind: 'github-repo',
          ref: repository,
          state: 'creating',
          startedAt: ctx.now(),
          public: true,
        });
        gh(
          'repo',
          'fork',
          UPSTREAM,
          '--org',
          org,
          '--fork-name',
          name,
          '--default-branch-only',
          '--clone=false',
        );
        let info = null;
        for (let i = 0; i < 10 && !info; i++) {
          info = repoInfo();
          if (!info) ctx.sh('sleep', ['3']);
        }
        if (!info)
          throw Error(
            'BENCH_SETUP_FORK_NOT_VISIBLE: fork created but not readable after 30 s; re-run setup (it resumes)',
          );
        record(B, {
          step: 'fork',
          kind: 'github-repo',
          ref: repository,
          state: 'created',
          id: info.id,
          createdAt: info.created_at,
          public: info.visibility === 'public',
        });
      }
      const info = repoInfo();
      const own = ownedRepo();
      if (String(own.id) !== String(info.id))
        throw Error('BENCH_SETUP_REPO_ID_MISMATCH: the repo is not the one recorded');
      gh(
        'api',
        '-X',
        'PUT',
        `repos/${repository}/actions/permissions`,
        '-F',
        'enabled=true',
        '-f',
        'allowed_actions=all',
      );
      gh(
        'api',
        '-X',
        'PATCH',
        `repos/${repository}`,
        '-F',
        'allow_auto_merge=true',
        '-F',
        'allow_squash_merge=true',
        '-F',
        'has_wiki=false',
        '-F',
        'has_issues=false',
      );
      const url = `https://github.com/${repository}.git`;
      if (gitOk(L().meta, 'remote', 'get-url', 'fork') === null) git(L().meta, 'remote', 'add', 'fork', url);
      else git(L().meta, 'remote', 'set-url', 'fork', url);
      const hasRuleset = Number(
        ghOk(
          'api',
          `repos/${repository}/rulesets`,
          '--jq',
          `[.[] | select(.name=="${rulesetName}")] | length`,
        ),
      );
      // Force main to the base first: the ruleset would block it afterwards (reset() does the same dance).
      if (!hasRuleset) git(L().meta, 'push', '-q', '--force', 'fork', `${L().baseSha}:refs/heads/main`);
      if (!hasRuleset)
        ctx.sh('gh', ['api', '-X', 'POST', `repos/${repository}/rulesets`, '--input', '-'], {
          input: JSON.stringify(rulesetBody()),
        });
      const main = gh('api', `repos/${repository}/branches/main`, '--jq', '.commit.sha');
      if (main !== L().baseSha) throw Error(`BENCH_SETUP_FORK_MAIN: ${main} is not the base ${L().baseSha}`);
    },
  });

  step({
    id: 'forge-project',
    title: 'Forge bench project at the base commit (GitHub import of the fork, then a clone)',
    outward: true,
    cost: {
      ...COST0,
      convexCalls: 12,
      diskGb: 0.6,
      minutes: 5,
      networkGb: 0.35,
      note: 'GitHub import of the public fork at the base commit (born hosted, server authority, agent-writable main): measured 2026-11-07 at 28,881 files / 333 MB in ~2:10 with 8 action calls, then `nforge clone` in ~61 s. A Git-format `nforge host` of a snapshot is NOT used: it leaves no schema-2 main (mainReady false), so agents cannot land. The configured bench deployment only.',
    },
    commands: () => [
      `node ${join(import.meta.dirname, 'forge-import.mjs')} ${L().importJournal} '{"url":"https://github.com/${cfgSafe().github?.repository ?? '<config.github.repository>'}","ref":"${L().baseSha ?? '<base>'}","name":"${L().forgeName}","deployment":"${L().forgeUrl ?? '<config.forge.url>'}"}'`,
      `nforge clone <projectId> ${L().forgeMain} --deployment ${L().forgeUrl ?? '<config.forge.url>'}`,
      'patch config.forge.projectId / mainBase',
    ],
    isDone: async () => {
      const c = cfgSafe();
      if (!c.forge?.projectId)
        return { done: false, detail: 'config.forge.projectId is unset: a new project would be imported' };
      const caps = forgeCap();
      if (!caps?.result || caps.result.mainReady !== true)
        return {
          done: false,
          detail: `config.forge.projectId ${c.forge.projectId.slice(0, 8)}… does not answer here with a ready main (${caps?.error?.code ?? (caps?.result ? 'mainReady false' : 'no reply')}); a live run imports a NEW project only with --replace-forge-project`,
        };
      if (!existsSync(join(L().forgeMain, '.forge')))
        return { done: false, detail: `no clone at ${L().forgeMain} yet` };
      return { done: true };
    },
    run: async () => {
      const c = cfg();
      const node = '/usr/local/bin/node';
      const answers = c.forge?.projectId ? forgeCap()?.result?.mainReady === true : false;
      if (c.forge?.projectId && !answers && !flags.replaceForgeProject)
        throw Error(
          `BENCH_SETUP_FORGE_PROJECT_EXISTS: config.forge.projectId names a project that does not answer from this account with a ready main. It may be unreachable rather than gone: check \`nforge auth status\` first, then pass --replace-forge-project to import a new one (the old one is not touched or deleted).`,
        );
      let projectId = answers ? c.forge.projectId : null;
      if (!projectId) {
        const journal = L().importJournal;
        // A finished journal of the project being replaced must not answer for the new one.
        if (existsSync(journal)) {
          const j = JSON.parse(readFileSync(journal, 'utf8'));
          if (j.status?.projectId && j.status.projectId === c.forge?.projectId)
            renameSync(journal, `${journal}.replaced-${Date.parse(ctx.now())}`);
        }
        // Write-ahead: if the import dies halfway, the journal holds its job id and teardown
        // can look for the project by name.
        record(B, {
          step: 'forge-project',
          kind: 'forge-project',
          ref: L().forgeName,
          state: 'creating',
          via: 'github-import',
          importJournal: journal,
          deployment: c.forge.deployment,
          url: c.forge.url,
          startedAt: ctx.now(),
        });
        const out = (ctx.tryOut ?? ctx.tryRun)(node, [
          join(import.meta.dirname, 'forge-import.mjs'),
          journal,
          JSON.stringify({
            url: `https://github.com/${c.github.repository}`,
            ref: L().baseSha,
            name: L().forgeName,
            deployment: c.forge.url,
          }),
        ]);
        const done = jsonLast(out);
        if (done?.phase !== 'ready' || !done.projectId)
          throw Error(
            `BENCH_SETUP_IMPORT_FAILED: the GitHub import ended ${done?.phase ?? 'with no result'}${done?.error ? ` (${JSON.stringify(done.error).slice(0, 300)})` : ''}. Re-run setup to resume it from ${journal}.`,
          );
        if (done.commit && done.commit !== L().baseSha)
          throw Error(`BENCH_SETUP_IMPORT_WRONG_BASE: imported ${done.commit}, plan base ${L().baseSha}`);
        projectId = done.projectId;
        record(B, {
          step: 'forge-project',
          kind: 'forge-project',
          ref: L().forgeName,
          state: 'created',
          via: 'github-import',
          projectId,
          root: L().forgeMain,
          files: done.files,
          bytes: done.bytes,
          report: done.report,
        });
        patchConfig(ctx, 'forge-project', { 'forge.projectId': projectId, 'forge.mainBase': L().baseSha });
      }
      const root = L().forgeMain;
      if (!existsSync(join(root, '.forge'))) {
        record(B, { step: 'forge-project', kind: 'path', ref: root, at: ctx.now(), state: 'creating' });
        mkdirSync(dirname(root), { recursive: true });
        ctx.sh(node, [c.forge.cli, 'clone', projectId, root, '--deployment', c.forge.url]);
        record(B, { step: 'forge-project', kind: 'path', ref: root, state: 'created' });
      }
    },
  });

  // The bench project's check: what both arms run (plan "Same check"), on the Forge runner the
  // Forge arm reads its CI evidence from (run-cell.mjs forgeCi), with agent landings accepted
  // on a pass (the prompt says `land --save` lands when the check passes).
  const checkSettings = () => {
    const out = (ctx.tryOut ?? ctx.tryRun)('/usr/local/bin/node', [
      cfgSafe().forge?.cli,
      'agent',
      L().forgeMain,
      'check-settings',
      JSON.stringify({ url: cfgSafe().forge?.url, projectId: cfgSafe().forge?.projectId }),
    ]);
    const line = out
      ?.split('\n')
      .filter(l => l.startsWith('{'))
      .at(-1);
    try {
      return line ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  };
  step({
    id: 'forge-check',
    title: `Forge bench project check: ${BENCH_CHECK.name} = ${BENCH_CHECK.executable} ${BENCH_CHECK.args.join(' ')}, runner ${FORGE_RUNNER.repository} (${FORGE_RUNNER.runsOn})`,
    outward: true,
    cost: {
      ...COST0,
      convexCalls: 8,
      note: 'check-settings is 3 reads (definitions page, current runner, policy); configure-check, configure-runner (one read-only GitHub App permission read) and set-policy are one write each, on the project setup hosted only. No CI runs here: the base-green qualification belongs to the exit bench dry run.',
    },
    commands: () => [
      `nforge agent ${L().forgeMain} check-settings '{}'   # read-only`,
      `nforge x ${L().forgeMain} configure-check '${JSON.stringify({ operationId: '<uuid>', command: BENCH_CHECK })}'`,
      `nforge github connect ${cfgSafe().forge?.projectId ?? '<projectId>'} --url ${L().forgeUrl ?? '<config.forge.url>'} --repo ${FORGE_RUNNER.repository}   # OWNER, once: browser authorisation of the runner repository`,
      `nforge x ${L().forgeMain} configure-runner '${JSON.stringify({ operationId: '<uuid>', provider: 'github-actions', ...FORGE_RUNNER })}'`,
      `nforge x ${L().forgeMain} set-policy '{"operationId":"<uuid>","preset":"trusted"}'   # only if agent landings wait for review`,
    ],
    isDone: async () => {
      if (!cfgSafe().forge?.projectId || !existsSync(join(L().forgeMain, '.forge')))
        return {
          done: false,
          detail: 'no bench project clone yet: configured right after forge-project imports it',
        };
      const s = checkSettings()?.result;
      if (!s)
        return { done: false, problems: ['check-settings gave no result (is the bench project reachable?)'] };
      return checkSettingsState(s);
    },
    run: async () => {
      const c = cfg();
      const own = readManifest(B).entries.find(
        e => e.kind === 'forge-project' && e.state === 'created' && e.projectId === c.forge?.projectId,
      );
      if (!own)
        throw Error(
          `BENCH_SETUP_CHECK_NOT_OURS: config.forge.projectId ${String(c.forge?.projectId).slice(0, 8)}… was not hosted by setup (no ${MANIFEST} entry), so setup will not change its check, runner or policy. Configure it by hand with the commands above, or host a new project with --replace-forge-project.`,
        );
      const node = '/usr/local/bin/node';
      const x = (action, request) =>
        ctx.sh(node, [
          c.forge.cli,
          'x',
          L().forgeMain,
          action,
          JSON.stringify({ operationId: randomUUID(), ...request }),
        ]);
      const s = checkSettings()?.result ?? {};
      const state = checkSettingsState(s);
      if (state.missing.includes('check')) x('configure-check', { command: BENCH_CHECK });
      if (state.missing.includes('runner'))
        try {
          x('configure-runner', { provider: 'github-actions', ...FORGE_RUNNER });
        } catch (error) {
          // The CLI prints its error JSON on stderr (stdout on some paths): read both.
          const code = (jsonLast(error.stderr) ?? jsonLast(error.stdout))?.error?.code;
          if (code !== 'GITHUB_REPOSITORY_UNBOUND') throw error;
          // The runner's repository runs the check through the Forge GitHub App, which the
          // owner authorises in a browser once per project: setup cannot do it for them.
          throw Error(
            `BENCH_SETUP_OWNER_STEP: connect the bench project to the runner repository, then re-run setup:\n` +
              `  nforge github connect ${c.forge.projectId} --url ${c.forge.url} --repo ${FORGE_RUNNER.repository}\n` +
              '(opens the GitHub authorisation in a browser; docs/operations/github-app.md)',
          );
        }
      if (state.missing.includes('acceptance')) x('set-policy', { preset: 'trusted' });
    },
  });

  step({
    id: 'dogfood',
    title: 'CLI mirror project in config',
    outward: false,
    cost: { ...COST0, note: 'config edit only' },
    commands: () => [
      'set config.dogfood.projectId from --dogfood-project ID (the project whose mirror maps the CLI State to Git)',
    ],
    isDone: async () => ({ done: Boolean(cfgSafe().dogfood?.projectId) }),
    run: async () => {
      if (!flags.dogfoodProject)
        throw Error(
          'BENCH_SETUP_NEEDS_DOGFOOD: pass --dogfood-project PROJECT_ID (the nanthai-forge project id: nforge agent <clone> capabilities shows it as projectId)',
        );
      patchConfig(ctx, 'dogfood', { 'dogfood.projectId': flags.dogfoodProject });
    },
  });

  return steps;
}

function readCapsFor(ctx, forgeRoot, donorDir) {
  const out = (ctx.tryOut ?? ctx.tryRun)('/usr/local/bin/node', [
    join(donorDir, 'dist/cli-entry.js'),
    'agent',
    forgeRoot,
    'capabilities',
    '{}',
    '--detail', // the slim receipt drops a synced mirror's mirroredHead/gitHead
  ]);
  const line = out
    ?.split('\n')
    .filter(l => l.startsWith('{'))
    .at(-1);
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ costs and dry */

export function sumCosts(list) {
  const total = { ...COST0 };
  let unmeasured = false;
  for (const c of list) {
    for (const k of Object.keys(COST0)) {
      if (c[k] === null) unmeasured = true;
      else total[k] += c[k] ?? 0;
    }
  }
  return { ...total, convexCallsUnmeasured: unmeasured };
}
const fmtCost = c =>
  [
    `repos ${c.repos}`,
    `CI min ${c.ciMinutes}`,
    `Convex calls ${c.convexCalls === null ? 'unmeasured' : c.convexCalls}`,
    `disk ${c.diskGb} GB`,
    `net ${c.networkGb} GB`,
    `~${c.minutes} min`,
  ].join(' | ');

/** Run (or dry-run) the steps. Returns { ok, results, total, remaining }. */
export async function runSetup(ctx, { dry = false, only = null } = {}) {
  const steps = buildSteps(ctx).filter(s => !only || only.includes(s.id));
  const results = [];
  const todo = [];
  ctx.log(`bench environment ${dry ? 'DRY RUN (reads only, nothing is created)' : 'setup'} in ${ctx.B}`);
  for (const s of steps) {
    let state;
    try {
      state = await s.isDone();
    } catch (error) {
      state = { done: false, problems: [`check failed: ${String(error.message).slice(0, 200)}`] };
    }
    const status = state.done ? 'done' : state.conflict ? 'CONFLICT' : 'todo';
    results.push({ id: s.id, status, state });
    ctx.log(`\n[${status}] ${s.id}: ${s.title}${s.outward ? '  (OUTWARD: public/hosted)' : ''}`);
    for (const c of s.commands()) ctx.log(`    ${c}`);
    ctx.log(`    cost: ${fmtCost(s.cost)}${s.cost.note ? `\n    basis: ${s.cost.note}` : ''}`);
    if (state.detail) ctx.log(`    now: ${state.detail}`);
    for (const p of state.problems ?? []) ctx.log(`    ! ${p}`);
    if (state.waitsFor) ctx.log(`    waits for: ${state.waitsFor}`);
    if (state.conflict) ctx.log(`    ! ${state.conflict}`);
    if (!state.done) todo.push(s);
    if (dry) continue;
    if (state.done) continue;
    if (state.conflict) return { ok: false, results, stoppedAt: s.id };
    if (s.blocking && state.problems?.length) return { ok: false, results, stoppedAt: s.id };
    try {
      await s.run();
      const after = await s.isDone();
      if (!after.done)
        throw Error(`step ${s.id} ran but its check still fails: ${(after.problems ?? []).join('; ')}`);
      results.at(-1).status = 'created';
      ctx.log(`    -> ${s.id} created`);
    } catch (error) {
      ctx.log(`    FAILED ${s.id}: ${error.message}`);
      return { ok: false, results, stoppedAt: s.id, error: error.message };
    }
  }
  const total = sumCosts(todo.map(s => s.cost));
  ctx.log(`\nremaining work: ${todo.length} step(s): ${todo.map(s => s.id).join(', ') || 'none'}`);
  ctx.log(
    `total for remaining steps: ${fmtCost({ ...total, convexCalls: total.convexCallsUnmeasured ? null : total.convexCalls })}${
      total.convexCallsUnmeasured
        ? ` (+ the unmeasured Convex spend of: ${todo
            .filter(s => s.cost.convexCalls === null)
            .map(s => s.id)
            .join(', ')})`
        : ''
    }`,
  );
  const all = sumCosts(steps.map(s => s.cost));
  ctx.log(
    `from scratch: ${fmtCost({ ...all, convexCalls: all.convexCallsUnmeasured ? null : all.convexCalls })}`,
  );
  if (dry && ctx.counts)
    ctx.log(
      `this dry run made these reads (no writes): ${Object.entries(ctx.counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
  if (dry) ctx.log('dry run: nothing was created. Live: scripts/bench-t3code/setup --live [flags]');
  return { ok: true, results, total, remaining: todo.map(s => s.id) };
}

/** Read-only: which environment pieces are missing (used by preflight). */
export async function missingSteps(ctx) {
  const out = [];
  for (const s of buildSteps(ctx)) {
    if (s.id === 'prereqs') continue;
    let st;
    try {
      st = await s.isDone();
    } catch (error) {
      st = { done: false, problems: [String(error.message).slice(0, 120)] };
    }
    if (!st.done)
      out.push({
        id: s.id,
        title: s.title,
        problems: st.problems ?? [],
        waitsFor: st.waitsFor,
        conflict: st.conflict,
      });
  }
  return out;
}

/* ------------------------------------------------------------------ teardown */

const inside = (root, p) => {
  const rel = relative(resolve(root), resolve(p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Delete only manifest entries, newest first, each re-verified. `keep` = step ids to leave. */
export async function runTeardown(ctx, { dry = false, keep = [] } = {}) {
  const B = ctx.B;
  const m = readManifest(B);
  const out = [];
  ctx.log(
    `bench teardown ${dry ? 'DRY RUN' : ''} in ${B}: ${m.entries.length} manifest entr${m.entries.length === 1 ? 'y' : 'ies'} (nothing outside the manifest is touched)`,
  );
  const entries = [...m.entries].reverse();
  const remove = ref => {
    const f = readManifest(B);
    f.entries = f.entries.filter(e => !(e.ref === ref));
    writeManifest(B, f);
  };
  for (const e of entries) {
    const tag = `${e.step}/${e.kind} ${e.ref}`;
    if (keep.includes(e.step)) {
      out.push({ ...e, result: 'kept' });
      ctx.log(`  keep    ${tag}`);
      continue;
    }
    try {
      if (e.kind === 'github-repo') {
        const info = ctx.tryRun('gh', ['api', `repos/${e.ref}`, '--jq', '{id,created_at}']);
        if (!info) {
          out.push({ ...e, result: 'already-gone' });
          ctx.log(`  gone    ${tag}`);
          if (!dry) remove(e.ref);
          continue;
        }
        const cur = JSON.parse(info);
        const same = e.id
          ? String(cur.id) === String(e.id)
          : e.startedAt && Date.parse(cur.created_at) >= Date.parse(e.startedAt) - 60_000;
        if (!same) {
          out.push({ ...e, result: 'REFUSED-not-ours' });
          ctx.log(`  REFUSE  ${tag}: the repo now has id ${cur.id}, not the one setup created`);
          continue;
        }
        ctx.log(`  ${dry ? 'would delete' : 'delete '} public repo ${e.ref}`);
        if (!dry) {
          ctx.sh('gh', ['repo', 'delete', e.ref, '--yes']);
          remove(e.ref);
        }
        out.push({ ...e, result: dry ? 'would-delete' : 'deleted' });
      } else if (e.kind === 'path' || e.kind === 'file') {
        if (!inside(B, e.ref)) {
          out.push({ ...e, result: 'REFUSED-outside-bench-root' });
          ctx.log(`  REFUSE  ${tag}: outside BENCH_ROOT`);
          continue;
        }
        let real = e.ref;
        try {
          real = realpathSync(e.ref);
        } catch {}
        if (existsSync(e.ref) && !inside(realpathSync(B), real)) {
          out.push({ ...e, result: 'REFUSED-link-escapes' });
          ctx.log(`  REFUSE  ${tag}: resolves outside BENCH_ROOT`);
          continue;
        }
        ctx.log(
          `  ${dry ? 'would delete' : 'delete '} ${e.ref}${existsSync(e.ref) ? '' : ' (already gone)'}`,
        );
        if (!dry) {
          rmSync(e.ref, { recursive: true, force: true });
          remove(e.ref);
        }
        out.push({ ...e, result: dry ? 'would-delete' : existsSync(e.ref) ? 'FAILED' : 'deleted' });
      } else if (e.kind === 'git-ref') {
        const [repo, ref] = e.ref.split('#');
        if (!inside(B, repo)) {
          out.push({ ...e, result: 'REFUSED-outside-bench-root' });
          continue;
        }
        ctx.log(`  ${dry ? 'would delete' : 'delete '} ${e.ref}`);
        if (!dry) {
          if (existsSync(join(repo, '.git'))) ctx.tryRun('git', ['-C', repo, 'update-ref', '-d', ref]);
          remove(e.ref);
        }
        out.push({ ...e, result: dry ? 'would-delete' : 'deleted' });
      } else if (e.kind === 'forge-project') {
        if (!e.projectId) {
          out.push({ ...e, result: 'UNRESOLVED-no-project-id' });
          ctx.log(
            `  UNRESOLVED ${tag}: hosting started but no project id was recorded; find it with nforge host ROOT --status, delete by hand`,
          );
          continue;
        }
        const cfg = (() => {
          try {
            return readConfig(B);
          } catch {
            return null;
          }
        })();
        ctx.log(
          `  ${dry ? 'would delete' : 'delete '} Forge project ${e.ref} (${e.projectId}) on ${e.deployment}`,
        );
        if (!dry) {
          ctx.sh('/usr/local/bin/node', [
            cfg?.forge?.cli,
            'host',
            e.root,
            '--delete-project',
            e.projectId,
            '--confirm',
            e.ref,
            '--deployment',
            e.url,
          ]);
          remove(e.ref);
        }
        out.push({ ...e, result: dry ? 'would-delete' : 'deleted' });
      } else if (e.kind === 'config-patch') {
        const cfg = readConfig(B);
        if (JSON.stringify(getPath(cfg, e.ref)) !== JSON.stringify(e.after)) {
          out.push({ ...e, result: 'kept-changed-since' });
          ctx.log(`  keep    ${tag}: edited since setup`);
          continue;
        }
        ctx.log(`  ${dry ? 'would restore' : 'restore'} config.${e.ref}`);
        if (!dry) {
          setPath(cfg, e.ref, e.hadKey ? e.before : undefined);
          writeConfig(B, cfg);
          remove(e.ref);
        }
        out.push({ ...e, result: dry ? 'would-restore' : 'restored' });
      } else {
        out.push({ ...e, result: 'UNKNOWN-kind' });
        ctx.log(`  skip    ${tag}: unknown kind`);
      }
    } catch (error) {
      out.push({ ...e, result: 'FAILED', error: error.message });
      ctx.log(`  FAILED  ${tag}: ${String(error.message).slice(0, 200)}`);
    }
  }
  const failed = out.filter(o => /FAILED|REFUSED|UNRESOLVED/.test(o.result));
  ctx.log(
    failed.length
      ? `teardown incomplete: ${failed.length} entr${failed.length === 1 ? 'y' : 'ies'} need attention`
      : 'teardown complete',
  );
  return { ok: !failed.length, results: out };
}
