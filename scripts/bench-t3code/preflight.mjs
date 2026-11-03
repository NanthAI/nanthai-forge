#!/usr/bin/env node
// B1.5d preflight: local watcher signals, one Convex read (meter), one commit status
// on the fixed base commit (GitHub clock offset), and otherwise read-only checks.
//   node scripts/bench-t3code/preflight.mjs [--dry]
// Prints one OK / WARN / NO-GO line per check, then GO or NO-GO with the reasons; exit 0 = GO.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, loadavg } from 'node:os';
import { checkPlan, DESIGN, batches, loadTasks, schedule, repNs } from './plan.mjs';
import { snapshot, snapshotProblems, pinProblems, forgeInFlight, FREEZE } from './versions.mjs';
import { usageGate, diskFreeGb, diskNeed, filesystemEventGate } from './gates.mjs';
import { probeFilesystemEvents } from '../filesystem-event-health.mjs';
import { pathToFileURL } from 'node:url';
import { agentOf } from './agent.mjs';
import { sharedDeps } from './deps.mjs';
import { branches, foreignBranches, repository, rulesetName, measureSkew } from './github-arm.mjs';
import { convexMeter } from './meter.mjs';
import { rateLimit } from './samplers.mjs';
import { staleBenchFreeze, BUDGET_USD } from './drive.mjs';

export async function main({
  benchRoot = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d'),
  filesystemProbe = probeFilesystemEvents,
  log = console.log,
} = {}) {
  const B = benchRoot;
  // Fail before network probes or any benchmark work when local event delivery is unhealthy.
  const workspaceVolume = join(B, 'ws');
  mkdirSync(workspaceVolume, { recursive: true });
  const { filesystemEvents, refusals } = await filesystemEventGate(workspaceVolume, filesystemProbe);
  if (refusals.length) {
    log(`NO-GO filesystem events: ${refusals.join('; ')}`);
    log('NO-GO (1): filesystem events');
    return 1;
  }
  const dry = process.argv.includes('--dry');
  const config = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
  const lines = [],
    nogo = [];
  const check = (name, ok, detail, warnOnly = false) => {
    const level = ok ? 'OK' : warnOnly ? 'WARN' : 'NO-GO';
    lines.push(`${level.padEnd(5)} ${name}: ${detail}`);
    if (!ok && !warnOnly) nogo.push(name);
  };
  const sh = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const tryRun = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      check(name, false, `check failed: ${String(error.message).slice(0, 200)}`);
    }
  };

  check('filesystem events', true, JSON.stringify(filesystemEvents));

  await tryRun('plan', () => {
    const p = checkPlan(B);
    check(
      'plan',
      !p.length,
      p.length
        ? p.join('; ')
        : `PLAN.md in BENCH_ROOT matches the committed plan; tasks sha ${DESIGN.tasksSha256.slice(0, 12)}`,
    );
  });
  await tryRun('design', () => {
    const ids = loadTasks(B).map(t => t.id);
    const all = batches(ids, [1, 2, 3]);
    const over = all.filter(b => b.agentsAtOnce > DESIGN.maxAgents);
    const paired = all.every(b => b.cells.length === 2 && b.cells.every(c => c.order === b.order));
    check(
      'design',
      !over.length && paired && schedule(ids).length === all.length * 2,
      `${all.length / 3} batches per rep (N order rep 1 ${repNs(1).join(',')}, rep 2 ${repNs(2).join(',')}, rep 3 ${repNs(3).join(',')}; concurrent N ${DESIGN.concurrentNs.join(',')}; others sequential, first arm alternating), at most ${Math.max(...all.map(b => b.agentsAtOnce))} agents at once (cap ${DESIGN.maxAgents}); reps 1-2, rep 3 by rule${over.length ? `; over cap: ${over.map(b => b.key).join(',')}` : ''}`,
    );
  });
  const s = await snapshot(config);
  // --dry: builders still land on main, so main-tracking readings only warn (as in dry cells).
  // The driver takes the freeze per batch, so it is not required here.
  const vp = snapshotProblems(s, { requireFreeze: false });
  check(
    'versions',
    !vp.length,
    vp.length
      ? vp.join('; ')
      : `CLI ${s.cli.commit?.slice(0, 12)} = GitHub main; deploy ${s.deploy?.headSha?.slice(0, 12)} convex/ = CLI convex/; agent ${s.agent}`,
    dry && !snapshotProblems(s, { requireFreeze: false, liveMain: true }).length,
  );
  const freezeText = existsSync(FREEZE) ? readFileSync(FREEZE, 'utf8').trim() : null;
  check(
    'freeze',
    !freezeText || !staleBenchFreeze(freezeText),
    !freezeText
      ? `${FREEZE} absent; the driver holds it for each batch (first cell start to last grade) and releases it between batches`
      : staleBenchFreeze(freezeText)
        ? `stale bench freeze (${freezeText}): its process is gone; the driver removes it at start`
        : `held: ${freezeText}`,
    Boolean(freezeText && staleBenchFreeze(freezeText)),
  );
  await tryRun('landing hold', () => {
    const wrapper = join(homedir(), '.npm-global/bin/nforge');
    const laneSh = join(homedir(), 'NanthAI/forge-phase5/agents/tools/lane.sh');
    const holds = [wrapper, laneSh].map(f => [
      f,
      existsSync(f) && readFileSync(f, 'utf8').includes('forge-cli/.freeze'),
    ]);
    check(
      'landing hold',
      holds.every(([, ok]) => ok),
      holds
        .map(
          ([f, ok]) => `${f.split('/').slice(-1)[0]} ${ok ? 'waits on .freeze' : 'does NOT wait on .freeze'}`,
        )
        .join('; ') + ' (bench agents call the CLI by path and are not held)',
    );
  });
  const pp = await pinProblems(s.harness);
  check(
    'harness pinned',
    !pp.length,
    pp.length ? pp.join('; ') : `${s.harness.dir} at ${s.harness.commit?.slice(0, 12)}`,
  );
  if (!dry)
    check(
      'harness qualified',
      config.qualifiedHarness === s.harness.commit,
      `config.qualifiedHarness ${config.qualifiedHarness?.slice?.(0, 12)} (a passing dry run of this exact harness)`,
    );
  await tryRun('in-flight', async () => {
    const f = await forgeInFlight();
    check(
      'no in-flight landings',
      !f.length,
      f.length
        ? `${f.length} nanthai-forge run(s) queued/in progress: ${f.map(r => r.workflowName).join(', ')}`
        : 'nanthai-forge has no queued or running workflow',
      dry,
    );
  });
  const disk = diskFreeGb(),
    need = diskNeed('github', 10, dry).requiredGb;
  check('disk', disk >= need, `${disk.toFixed(1)} GB free, largest cell needs ${need.toFixed(1)} GB`);
  await tryRun('memory', () => {
    const free = Number(sh('memory_pressure', ['-Q']).match(/(\d+)%/)?.[1]);
    check('memory', free >= 20, `system-wide free ${free}% (need >= 20%)`);
  });
  const load = loadavg()[1];
  check(
    'load',
    load <= 16,
    `5-min load ${load.toFixed(1)} (recorded per cell; high load slows both arms)`,
    true,
  );
  const agent = agentOf(config);
  const u = usageGate(agent.provider);
  check('agent', true, `${agent.provider} ${agent.model} effort ${agent.effort} (config.agent), both arms`);
  if (!dry) {
    check(
      'usage weekly',
      u.weekly !== null && u.weekly < 85,
      `${u.provider} weekly ${u.weekly}% (stop at 85%)`,
    );
    if (u.has5h)
      check(
        'usage 5h',
        u.session5h !== null && u.session5h <= 40,
        `${u.provider} 5h ${u.session5h}% (the driver waits for <= 40%)`,
        true,
      );
  }
  await tryRun('fork', async () => {
    const names = await branches();
    const foreign = foreignBranches(names);
    check(
      'fork branches clean',
      !foreign.length,
      foreign.length
        ? `${foreign.length} non-agent branches: ${foreign.slice(0, 8).join(' ')}`
        : `only main${names.length > 1 ? ' + agent-*' : ''}`,
    );
    const main = sh('gh', ['api', `repos/${repository}/branches/main`, '--jq', '.commit.sha']);
    check(
      'fork main',
      true,
      main === config.github.mainBase
        ? 'at base'
        : `${main.slice(0, 12)} (the first cell's reset restores base)`,
    );
    const rs = JSON.parse(sh('gh', ['api', `repos/${repository}/rulesets`])).find(
      r => r.name === rulesetName,
    );
    check('fork ruleset', rs?.enforcement === 'active', `${rulesetName} ${rs?.enforcement}`);

    const queued = JSON.parse(
      sh('gh', ['run', 'list', '-R', repository, '--status', 'queued', '-L', '20', '--json', 'databaseId']),
    );
    check('fork runner backlog', !queued.length, `${queued.length} queued run(s)`);
  });
  await tryRun('GitHub clock', async () => {
    const c = await measureSkew(config.github.mainBase);
    check(
      'GitHub clock',
      Math.abs(c.skewMs) < 5000,
      `stored timestamps ${(c.skewMs / 1000).toFixed(1)} s from real time (round trip ${c.roundTripMs} ms); every cell measures and corrects it, and voids if it moves`,
      true,
    );
  });
  await tryRun('runners', async () => {
    const res = await fetch('https://www.githubstatus.com/api/v2/components.json');
    const actions = (await res.json()).components.find(c => c.name === 'Actions');
    check('GitHub Actions status', actions?.status === 'operational', actions?.status ?? 'unknown');
  });
  await tryRun('gh budget', async () => {
    const r = await rateLimit();
    check('GitHub API budget', r && r.core >= 1000 && r.graphql >= 2000, JSON.stringify(r));
  });
  check(
    'one base tree',
    config.forge.mainBase === config.github.mainBase,
    `forge ${config.forge.mainBase?.slice(0, 12)} github ${config.github.mainBase?.slice(0, 12)}`,
  );
  check('shared deps', Boolean(sharedDeps(B, config.baseCheckout)), 'deps/ toolchain and install');
  check('meta repo', existsSync(join(config.meta, '.git')), config.meta);
  check('no driver running', !existsSync(join(B, 'drive.lock')), 'drive.lock absent', true);
  await tryRun('budget', () => {
    const runs = join(B, 'runs');
    const spent = readdirSync(runs)
      .filter(d => d.startsWith('forge-') && /-a\d+-/.test(d) && !d.includes('-dry-'))
      .reduce((sum, d) => {
        try {
          return sum + (JSON.parse(readFileSync(join(runs, d, 'result.json'), 'utf8')).convex?.costUsd ?? 0);
        } catch {
          return sum;
        }
      }, 0);
    check(
      'Convex budget',
      spent < BUDGET_USD,
      `scored Forge cells so far $${spent.toFixed(3)} of the $${BUDGET_USD} stop`,
    );
  });
  const probeRoot = join(B, 'ws', '.preflight');
  mkdirSync(probeRoot, { recursive: true });
  const forgeAgent = (verb, body) =>
    JSON.parse(
      sh('/usr/local/bin/node', [
        config.forge.cli,
        'agent',
        probeRoot,
        verb,
        JSON.stringify({ url: config.forge.url, projectId: config.forge.projectId, ...body }),
      ])
        .split('\n')
        .filter(l => l.startsWith('{'))
        .at(-1),
    );
  await tryRun('Forge bench project', () => {
    const caps = forgeAgent('capabilities', {});
    check(
      'Forge bench project',
      caps.result?.mainReady !== false,
      `capabilities: ${(caps.result?.actions ?? []).length} actions, mainReady ${caps.result?.mainReady}`,
    );
  });
  await tryRun('Convex meter', async () => {
    const meter = convexMeter({
      deployment: config.forge.deployment,
      projectId: config.forge.projectId,
      name: config.forge.projectName,
      cwd: s.harness.dir,
    });
    try {
      // `metrics` always reads the project (capabilities may answer from the CLI cache).
      const ready = await meter.ready(async () => {
        forgeAgent('metrics', {
          from: new Date(Date.now() - 60_000).toISOString(),
          to: new Date().toISOString(),
        });
      }, 120_000);
      check(
        'Convex meter',
        true,
        `live after ${ready.liveAfterSeconds.toFixed(0)} s (${ready.probes} probe)`,
      );
    } finally {
      meter.stop();
    }
  });
  log(lines.join('\n'));
  log(nogo.length ? `NO-GO (${nogo.length}): ${nogo.join(', ')}` : 'GO');
  return nogo.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
