#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Cross-ecosystem zoo run (Issue 85d26a8b): for every repository in ZOO_ROOT/zoo.json, the same
// generic scenario on Forge and on plain git + GitHub, with timings side by side.
//   node scripts/bench-zoo/run.mjs ZOO_ROOT [--repos go,rust] [--reimport] [--no-github-run]
// Forge: GitHub import, clone, three Lanes (two agents on one file, one disjoint), save, check-only,
// land, clean sync after an overtake, land again (check reuse expected), forced conflict, keep-both
// resolution, land. Plain git: the same edits on clones of the public fork (scratch branch).
// Every refusal is recorded with its code; nothing is retried with different parameters.
// Writes ZOO_ROOT/runs/STAMP/{RESULT.json, REPO.receipts.jsonl}; the import state is kept in
// ZOO_ROOT/state.json so a re-run reuses the projects. Run from a built Forge checkout (dist/).
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exec } from './exec.mjs';
import {
  appendLine,
  checkFacts,
  cliHead,
  tagLastLine,
  errorCode,
  findAll,
  landPending,
  githubEquivalent,
  pickProbeFiles,
  probeLine,
  resolveKeepBoth,
} from './lib.mjs';

function listFiles(root) {
  const out = [];
  const walk = d => {
    for (const name of readdirSync(join(root, d))) {
      if (!d && (name === '.forge' || name === '.git')) continue;
      const rel = d ? `${d}/${name}` : name;
      const st = lstatSync(join(root, rel));
      if (st.isSymbolicLink()) out.push({ path: rel, symlink: true, size: 0 });
      else if (st.isDirectory()) walk(rel);
      else out.push({ path: rel, size: st.size });
    }
  };
  walk('');
  return out;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const edit = (root, path, line) =>
  writeFileSync(join(root, path), appendLine(readFileSync(join(root, path), 'utf8'), line));
const tag = (root, path, label) =>
  writeFileSync(join(root, path), tagLastLine(readFileSync(join(root, path), 'utf8'), path, label));

/** One repository's scenario. `io` = { cli, git, log, receipt } (injectable). */
export async function runRepo(cfg, repo, state, runDir, io) {
  const r = { id: repo.id, fork: repo.fork, upstream: repo.upstream, steps: {}, refusals: [], notes: [] };
  const step = (name, side, value) => ((r.steps[name] ??= {})[side] = value);
  const refuse = (where, code, detail) =>
    r.refusals.push({ where, code, detail: detail?.slice?.(0, 300) ?? null });
  const nf = async (root, verb, body, flags = []) => {
    // An agent answers the blocking overlap notice the two same-file Lanes raise by landing in order.
    if (verb === 'land') body = { operationId: randomUUID(), overlapAnswer: 'accept-order', ...body };
    let res = await io.cli(['agent', root, verb, ...flags, JSON.stringify(body)]);
    io.receipt(repo.id, { verb, flags, body, code: res.code, seconds: res.seconds, receipt: res.json });
    // IN PROGRESS (exit 3), or an asynchronous land that printed SUBMITTED and exited 0 with
    // `inProgress: true`: follow the landing with its blocking wait, bounded (8 x 540 s). Without
    // this the land timing is the submit time and a conflict never reaches the recovery step.
    for (let i = 0; verb === 'land' && landPending(res) && i < 8; i++) {
      const runId = flags.includes('--check-only')
        ? findAll(res.json, 'runId').find(v => typeof v === 'string')
        : null;
      const w = await io.cli([
        'agent',
        root,
        'wait',
        JSON.stringify(runId ? { runId } : { operationIds: [body.operationId], until: 'acceptance' }),
      ]);
      io.receipt(repo.id, {
        verb: 'wait',
        operationId: body.operationId,
        code: w.code,
        seconds: w.seconds,
        receipt: w.json,
      });
      res = { ...w, seconds: res.seconds + w.seconds, stderr: res.stderr + w.stderr };
    }
    return res;
  };
  const base = join(runDir, repo.id);
  mkdirSync(base, { recursive: true });
  const since = new Date().toISOString();

  // 1. Import (born hosted). Plain git's nearest operation: a full bare clone of the fork.
  let s = state.repos[repo.id] ?? {};
  if (!s.projectId || cfg.reimport) {
    const res = await io.importProject(repo, join(base, 'import-journal.json'));
    step('import', 'forge', {
      ok: res.phase === 'ready',
      seconds: res.seconds,
      calls: res.calls,
      files: res.files,
      bytes: res.bytes,
      report: res.report,
      error: res.error ?? null,
    });
    if (res.phase !== 'ready') return (refuse('import', 'IMPORT_FAILED', JSON.stringify(res.error)), r);
    s = state.repos[repo.id] = { projectId: res.projectId, commit: res.commit };
    io.saveState();
  } else r.notes.push(`import reused: project ${s.projectId}`);
  const bare = await io.git([
    'clone',
    '--bare',
    '--quiet',
    `https://github.com/${repo.fork}`,
    join(base, 'git-bare'),
  ]);
  step('import', 'git', { ok: bare.code === 0, seconds: bare.seconds, op: 'git clone --bare' });
  r.projectId = s.projectId;

  // 2. Clone, next to git clone.
  const clone = join(base, 'forge');
  const fc = await io.cli(['clone', s.projectId, clone, '--deployment', cfg.deployment]);
  step('clone', 'forge', { ok: fc.code === 0, seconds: fc.seconds });
  if (fc.code !== 0) return (refuse('clone', errorCode(fc.json) ?? `exit ${fc.code}`, fc.stderr), r);
  const gA = join(base, 'git-a');
  const gc = await io.git(['clone', '--quiet', `https://github.com/${repo.fork}`, gA]);
  step('clone', 'git', { ok: gc.code === 0, seconds: gc.seconds });

  // 3. Project setup: the repository's own CI command, trusted agent policy, the runner.
  const settings = (await nf(clone, 'check-settings', {})).json?.result ?? {};
  if (!settings.definitions?.some(d => d.name === cfg.check.name)) {
    const c = await io.cli([
      'x',
      clone,
      'configure-check',
      JSON.stringify({ operationId: randomUUID(), command: cfg.check }),
    ]);
    if (c.code) refuse('configure-check', errorCode(c.json) ?? `exit ${c.code}`, c.stderr);
  }
  if (settings.policy?.acceptance?.mode !== 'auto-on-pass') {
    const p = await io.cli([
      'x',
      clone,
      'set-policy',
      JSON.stringify({ operationId: randomUUID(), preset: 'trusted' }),
    ]);
    if (p.code) refuse('set-policy', errorCode(p.json) ?? `exit ${p.code}`, p.stderr);
  }
  let runner = Boolean(settings.runner);
  if (!runner) {
    const c = await io.cli([
      'x',
      clone,
      'configure-runner',
      JSON.stringify({ operationId: randomUUID(), provider: 'github-actions', ...cfg.runner }),
    ]);
    runner = c.code === 0;
    if (!runner)
      refuse('configure-runner', errorCode(c.json) ?? `exit ${c.code}`, c.json?.error?.message ?? c.stderr);
  }

  // 4. Probe files: generic choice from the tree (two directories, the main source extension).
  const probe = pickProbeFiles(listFiles(clone));
  r.probe = probe;
  if (!probe?.second) return (refuse('probe', 'ZOO_NO_PROBE_FILES', 'no two editable source files'), r);

  // 5. Four Lanes: A and B tag the same line (forced conflict), C edits another directory (clean
  // overtake), D adds a new file and only syncs (clean sync after two landings).
  const lanes = {};
  const dFile = `.forge-zoo/probe-${basename(runDir)}.txt`;
  for (const name of ['a', 'b', 'c', 'd']) {
    const res = await nf(clone, 'start', { outcome: `zoo ${name}: probe edit`, operationId: randomUUID() });
    const lane = res.json?.result;
    if (!lane?.path)
      return (refuse(`start ${name}`, errorCode(res.json) ?? `exit ${res.code}`, res.stderr), r);
    lanes[name] = { id: lane.lane?.laneId ?? basename(lane.path), path: lane.path };
    if (name === 'a') step('start', 'forge', { ok: true, seconds: res.seconds });
  }
  tag(lanes.a.path, probe.first, 'a');
  tag(lanes.b.path, probe.first, 'b');
  edit(lanes.c.path, probe.second, probeLine(probe.second, 'c'));
  writeFileSync(join(lanes.d.path, dFile), 'forge-zoo probe d\n');
  for (const name of ['a', 'b', 'c', 'd']) {
    const res = await nf(lanes[name].path, 'save', { laneId: lanes[name].id, message: `zoo ${name}` });
    if (res.code) refuse(`save ${name}`, errorCode(res.json) ?? `exit ${res.code}`, res.stderr);
    if (name === 'a') step('save', 'forge', { ok: res.code === 0, seconds: res.seconds });
  }

  // Plain git: the same three edits on clones of a scratch branch of the fork.
  const branch = `zoo/${basename(runDir)}-${repo.id}`;
  const g = (dir, ...args) => io.git(['-C', dir, ...args]);
  await g(gA, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  const gB = join(base, 'git-b'),
    gC = join(base, 'git-c'),
    gD = join(base, 'git-d');
  for (const d of [gB, gC, gD])
    await io.git(['clone', '--quiet', '--branch', branch, `https://github.com/${repo.fork}`, d]);
  const commit = async (dir, tag) =>
    g(
      dir,
      '-c',
      'user.name=zoo',
      '-c',
      'user.email=zoo@example.invalid',
      'commit',
      '--quiet',
      '-am',
      `zoo ${tag}`,
    );
  tag(gA, probe.first, 'a');
  tag(gB, probe.first, 'b');
  edit(gC, probe.second, probeLine(probe.second, 'c'));
  writeFileSync(join(gD, dFile), 'forge-zoo probe d\n');
  await g(gD, 'add', dFile);
  let t = performance.now();
  await commit(gA, 'a');
  const pushA = await g(gA, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}-a`);
  step('save', 'git', {
    ok: pushA.code === 0,
    seconds: (performance.now() - t) / 1000,
    op: 'commit + push branch',
  });
  await commit(gB, 'b');
  await commit(gC, 'c');
  await commit(gD, 'd');

  if (!runner) {
    for (const op of ['land', 'sync', 'landReuse', 'conflict', 'resolve'])
      step(op, 'forge', { ok: false, refusal: 'skipped: no runner (configure-runner refused)' });
  } else {
    // A and C submit together: A lands first and C, checked on the old main, is overtaken by a
    // disjoint landing (first-check reuse is the fast path; the landings read says what happened).
    const pA = nf(lanes.a.path, 'land', { laneId: lanes.a.id, message: 'zoo a' }, ['--save']);
    await new Promise(res => setTimeout(res, 2_000));
    const pC = nf(lanes.c.path, 'land', { laneId: lanes.c.id, message: 'zoo c' }, ['--save']);
    const [landA, landC] = await Promise.all([pA, pC]);
    step('land', 'forge', { ok: landA.code === 0, seconds: landA.seconds, ...checkFacts(landA.json) });
    if (landA.code)
      refuse(
        'land a',
        errorCode(landA.json) ?? `exit ${landA.code}`,
        landA.json?.error?.message ?? landA.stderr,
      );
    step('landReuse', 'forge', { ok: landC.code === 0, seconds: landC.seconds, ...checkFacts(landC.json) });
    if (landC.code)
      refuse(
        'land c',
        errorCode(landC.json) ?? `exit ${landC.code}`,
        landC.json?.error?.message ?? landC.stderr,
      );
    // D: clean sync over the two landings.
    const syncD = await nf(lanes.d.path, 'save', { laneId: lanes.d.id, message: 'zoo d sync' }, ['--sync']);
    step('sync', 'forge', { ok: syncD.code === 0, seconds: syncD.seconds, error: errorCode(syncD.json) });
    // B: forced conflict with A on the same line, keep-both resolution, land.
    const landB = await nf(lanes.b.path, 'land', { laneId: lanes.b.id, message: 'zoo b' }, ['--save']);
    const bFacts = checkFacts(landB.json);
    const conflicted = /CONFLICT/.test(bFacts.error ?? '') || bFacts.conflictPaths.length > 0;
    step('conflict', 'forge', {
      ok: conflicted,
      seconds: landB.seconds,
      ...bFacts,
      stderrTail: landB.stderr.slice(-400),
    });
    if (!conflicted)
      refuse(
        'land b',
        bFacts.error ?? `exit ${landB.code}`,
        landB.json?.error?.message ?? landB.stderr.slice(-400),
      );
    // Follow the receipt's recovery step exactly (for a composition conflict: sync the Candidate
    // into the Lane, which writes the markers), then resolve in the folder it names.
    t = performance.now();
    const next = findAll(landB.json, 'next').find(
      n => n && typeof n === 'object' && typeof n.action === 'string',
    );
    let recovered = landB;
    if (next) {
      const { action, ...params } = next;
      recovered = await nf(lanes.b.path, action, params);
      r.notes.push(`conflict recovery: ${action} exit ${recovered.code}`);
    }
    const folder =
      resolutionFolder(recovered, lanes.b.path, probe.first) ??
      resolutionFolder(landB, lanes.b.path, probe.first);
    if (!folder)
      refuse(
        'resolve',
        'ZOO_NO_RESOLUTION_FOLDER',
        `land b ${bFacts.error ?? landB.code}; recovery ${next?.action ?? 'none'}`,
      );
    else {
      writeFileSync(
        join(folder.path, probe.first),
        resolveKeepBoth(readFileSync(join(folder.path, probe.first), 'utf8')),
      );
      // The sync receipt's conflict names the next step (resolve, on the resolution Lane); run
      // it in the folder it names, then land that resolution Lane.
      const conflict = findAll(recovered.json, 'conflict').find(c => c?.next?.action);
      let laneId = folder.laneId;
      if (conflict) {
        const { action, ...params } = conflict.next;
        const res = await nf(conflict.root ?? folder.path, action, params);
        r.notes.push(`resolution step: ${action} exit ${res.code}`);
        if (res.code)
          refuse(
            `resolution ${action}`,
            errorCode(res.json) ?? `exit ${res.code}`,
            res.json?.error?.message ?? res.stderr,
          );
        laneId = params.laneId ?? laneId;
      }
      const landR = await nf(folder.path, 'land', { laneId, message: 'zoo b resolved' }, ['--save']);
      step('resolve', 'forge', {
        ok: landR.code === 0,
        seconds: (performance.now() - t) / 1000,
        folder: relative(base, folder.path),
        ...checkFacts(landR.json),
      });
      if (landR.code)
        refuse(
          'land b resolved',
          errorCode(landR.json) ?? `exit ${landR.code}`,
          landR.json?.error?.message ?? landR.stderr,
        );
    }
  }

  // Plain git: A pushes (no CI); C pulls the moved main and pushes; D pulls clean; B conflicts.
  t = performance.now();
  const gLand = await g(gA, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  step('land', 'git', {
    ok: gLand.code === 0,
    seconds: (performance.now() - t) / 1000,
    op: 'push to base (no CI)',
  });
  t = performance.now();
  const gPullC = await g(gC, 'pull', '--quiet', '--no-rebase', '--no-edit', 'origin', branch);
  const gPushC = await g(gC, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  step('landReuse', 'git', {
    ok: gPullC.code === 0 && gPushC.code === 0,
    seconds: (performance.now() - t) / 1000,
    op: 'pull --no-rebase + push (no CI)',
  });
  const gSync = await g(gD, 'pull', '--quiet', '--no-rebase', '--no-edit', 'origin', branch);
  step('sync', 'git', { ok: gSync.code === 0, seconds: gSync.seconds, op: 'pull --no-rebase (clean)' });
  const gConf = await g(gB, 'pull', '--quiet', '--no-rebase', '--no-edit', 'origin', branch);
  step('conflict', 'git', {
    ok: gConf.code !== 0,
    seconds: gConf.seconds,
    op: 'pull --no-rebase (conflict)',
  });
  t = performance.now();
  try {
    writeFileSync(join(gB, probe.first), resolveKeepBoth(readFileSync(join(gB, probe.first), 'utf8')));
    await g(gB, 'add', probe.first);
    await commit(gB, 'b resolved');
    const p = await g(gB, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    step('resolve', 'git', {
      ok: p.code === 0,
      seconds: (performance.now() - t) / 1000,
      op: 'resolve + commit + push',
    });
  } catch (error) {
    step('resolve', 'git', { ok: false, error: error.message });
  }
  for (const b of [branch, `${branch}-a`]) await g(gA, 'push', '--quiet', 'origin', `:refs/heads/${b}`);

  // 6. Check minutes: Forge runs of this project on the runner repository vs the measured
  // GitHub-equivalent full run (pull-request run per pushed head, merge-queue run per merge).
  r.window = { since, until: new Date().toISOString() };
  if (runner) {
    r.forgeChecks = await io.forgeChecks(cfg.runner.repository, s.projectId, since, r.window.until);
    // What Forge recorded: each landing's first-check outcome, and each run's gate and time.
    const byLane = Object.fromEntries(Object.entries(lanes).map(([n, l]) => [l.id, n]));
    r.landings = [];
    for (let cursor = null, i = 0; i < 5; i++) {
      const page = (
        await nf(clone, 'landings', { from: since, to: r.window.until, ...(cursor ? { cursor } : {}) })
      ).json?.result;
      for (const l of page?.landings ?? [])
        r.landings.push({
          lane: byLane[l.laneId] ?? 'resolution',
          firstCheck: l.firstCheck,
          mainMoved: l.mainMoved,
          checkSkipped: l.checkSkipped,
          checkRunIds: l.checkRunIds,
          recomposeCount: l.recomposeCount,
          submittedAt: l.submittedAt,
          committedAt: l.committedAt,
        });
      if (!(cursor = page?.nextCursor)) break;
    }
    r.runs = [];
    for (const runId of [...new Set(r.landings.flatMap(l => l.checkRunIds ?? []))]) {
      const run = (await nf(clone, 'status', { runId })).json?.result;
      r.runs.push({
        runId,
        gate: run?.gate ?? null,
        executionSeconds: run?.execution?.seconds ?? null,
        shards: run?.plan?.shardCount ?? null,
        lockfileDigestEmpty: run?.plan?.lockfile === EMPTY_SHA256,
        at: run?.at ?? null,
        endedAt: run?.endedAt ?? null,
        exitCode: run?.exitCode ?? null,
      });
    }
    r.metrics =
      (await nf(clone, 'metrics', { from: since, to: r.window.until })).json?.result?.totals?.fallbacks ??
      null;
  }
  if (!cfg.noGithubRun) r.githubFullRun = await io.githubFullRun(repo);
  r.githubEquivalent = githubEquivalent({
    fullRunSeconds: r.githubFullRun?.jobSeconds,
    prPushes: 4,
    merges: 3,
  });
  // Abandon what did not land so the next run starts without stale overlap notices.
  for (const [name, lane] of Object.entries(lanes)) {
    r.notes.push(`lane ${name} ${lane.id}`);
    const st = (await nf(clone, 'status', { laneId: lane.id })).json?.result;
    if (!st?.landing)
      await io.cli([
        'x',
        clone,
        'abandon',
        JSON.stringify({ laneId: lane.id, reason: 'zoo run cleanup', operationId: randomUUID() }),
      ]);
  }
  return r;
}

/** The folder a conflict receipt names for resolution: any existing directory string in the
 * receipt or its stderr that holds markers in the conflicted file, else the Lane itself. */
export function resolutionFolder(res, lanePath, file) {
  const strings = [
    ...findAll(res.json, 'root'),
    ...findAll(res.json, 'path'),
    ...findAll(res.json, 'workIn'),
    ...(String(res.stderr).match(/\/[^\s"']+/g) ?? []),
  ].filter(v => typeof v === 'string');
  for (const p of [...new Set([...strings, lanePath])]) {
    try {
      const text = readFileSync(join(p, file), 'utf8');
      if (/^<{7}/m.test(text)) {
        const laneId =
          findAll(res.json, 'laneId').find(id => typeof id === 'string' && p.includes(id)) ?? basename(p);
        return { path: p, laneId };
      }
    } catch {}
  }
  return null;
}

async function main(argv) {
  const root = argv[0];
  if (!root || root.startsWith('--')) {
    console.error('usage: run.mjs ZOO_ROOT [--repos a,b] [--reimport] [--no-github-run]');
    return 2;
  }
  const flag = f => argv.includes(f);
  const only = argv.includes('--repos') ? argv[argv.indexOf('--repos') + 1].split(',') : null;
  const cfg = {
    ...JSON.parse(readFileSync(join(root, 'zoo.json'), 'utf8')),
    reimport: flag('--reimport'),
    noGithubRun: flag('--no-github-run'),
  };
  const statePath = join(root, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { repos: {} };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const runDir = join(root, 'runs', stamp);
  mkdirSync(runDir, { recursive: true });
  const { makeIo } = await import('./io.mjs');
  const io = makeIo({ cfg, root, runDir, state, statePath });
  const repos = cfg.repos.filter(r => !only || only.includes(r.id));
  const readCli = () => {
    try {
      const file = join(dirname(cfg.forgeCheckout), 'release-number.json');
      return cliHead(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const cliBefore = readCli();
  const results = await Promise.all(
    repos.map(repo =>
      io.metered(repo, () =>
        runRepo(cfg, repo, state, runDir, io).catch(error => ({ id: repo.id, crash: error.stack })),
      ),
    ),
  );
  // The CLI follows main, so a run can straddle a release: name the CLI build before and after.
  const cliCommits = [...new Set([cliBefore, readCli()].filter(Boolean))];
  const out = { stamp, cliCommits, deployment: cfg.deployment, results };
  writeFileSync(join(runDir, 'RESULT.json'), JSON.stringify(out, null, 1) + '\n');
  if (!flag('--keep-checkouts'))
    for (const repo of repos) rmSync(join(runDir, repo.id), { recursive: true, force: true });
  console.log(
    JSON.stringify({
      runDir,
      repos: results.map(r => ({
        id: r.id,
        refusals: r.refusals?.map(x => `${x.where}:${x.code}`),
        crash: r.crash ? true : undefined,
      })),
    }),
  );
  return results.some(r => r.crash) ? 1 : 0;
}

const entry = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : '';
if (import.meta.url === pathToFileURL(entry).href) process.exitCode = await main(process.argv.slice(2));
