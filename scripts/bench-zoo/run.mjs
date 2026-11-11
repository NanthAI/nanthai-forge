#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Cross-ecosystem zoo run (Issue 85d26a8b): for every repository in ZOO_ROOT/zoo.json, the same
// generic scenario on Forge and on plain git + GitHub, with timings side by side.
//   node scripts/bench-zoo/run.mjs ZOO_ROOT [--repos go,rust] [--concurrency N] [--reimport] [--no-github-run] [--prepare-only]
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
import { exec, waitForDisk } from './exec.mjs';
import { compareTrees, platformLimits, walkTree } from './fidelity.mjs';
import {
  appendLine,
  checkFacts,
  cliHead,
  controlCodeSource,
  preflightFacts,
  tagLastLine,
  errorCode,
  findAll,
  landPending,
  githubEquivalent,
  pickProbeFiles,
  probeLine,
  resolveKeepBoth,
  submodulePaths,
  thrownRefusal,
} from './lib.mjs';

function listFiles(root) {
  const out = [];
  const walk = d => {
    for (const name of readdirSync(join(root, d))) {
      if (!d && (name === '.forge' || name === '.git')) continue;
      const rel = d ? `${d}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(root, rel));
      } catch {
        continue; // a name that is not valid UTF-8 cannot be addressed here and is never a probe
      }
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

/** Follow the original source operation before the scenario can advance. The CLI's wait
 * replays its retained request and reconciles an unknown reply without a second mutation. */
export async function sourceCommand(io, id, root, verb, body, flags = []) {
  const source = ['start', 'save', 'sync', 'resolve', 'open', 'land'].includes(verb);
  if (source) body = { operationId: randomUUID(), ...body };
  let res = await io.cli(['agent', root, verb, ...flags, JSON.stringify(body)]);
  io.receipt(id, { verb, flags, body, code: res.code, seconds: res.seconds, receipt: res.json });
  for (let i = 0; source && landPending(res) && i < 8; i++) {
    const runId = flags.includes('--check-only')
      ? findAll(res.json, 'runId').find(v => typeof v === 'string')
      : null;
    const w = await io.cli([
      'agent',
      root,
      'wait',
      JSON.stringify(
        runId
          ? { runId }
          : {
              operationIds: [body.operationId],
              ...(verb === 'land' ? { until: 'acceptance' } : {}),
            },
      ),
    ]);
    io.receipt(id, {
      verb: 'wait',
      operationId: body.operationId,
      code: w.code,
      seconds: w.seconds,
      receipt: w.json,
    });
    res = { ...w, seconds: res.seconds + w.seconds, stderr: res.stderr + w.stderr };
  }
  if (source && landPending(res))
    throw Object.assign(Error(`ZOO_SOURCE_PENDING ${verb} ${body.operationId}`), {
      pendingSource: { verb, operationId: body.operationId, body, flags },
    });
  return res;
}

/** One repository's scenario. `io` = { cli, git, log, receipt } (injectable). */
export async function runRepo(cfg, repo, state, runDir, io) {
  const r = { id: repo.id, fork: repo.fork, upstream: repo.upstream, steps: {}, refusals: [], notes: [] };
  const step = (name, side, value) => ((r.steps[name] ??= {})[side] = value);
  const refuse = (where, code, detail) =>
    r.refusals.push({ where, code, detail: detail?.slice?.(0, 300) ?? null });
  const nf = async (root, verb, body, flags = [], afterPreflight = false) => {
    // (Hosted overlap notices and their `overlapAnswer` are gone, Issue 853fcde3: nothing to answer.)
    const res = await sourceCommand(io, repo.id, root, verb, body, flags);
    // The named recovery of a PREFLIGHT_REQUIRED refusal (a change to test files must run them
    // first): run the Lane's preflight once, bounded, then submit again. Both are recorded.
    if (verb === 'land' && res.code && errorCode(res.json) === 'PREFLIGHT_REQUIRED' && !afterPreflight) {
      refuse(`${verb} ${body.laneId?.slice(0, 8)}`, 'PREFLIGHT_REQUIRED', res.json?.error?.message);
      const pf = await nf(root, 'preflight', { laneId: body.laneId, budgetSeconds: 120 });
      r.notes.push(`preflight-required recovery on ${body.laneId?.slice(0, 8)}: preflight exit ${pf.code}`);
      const { operationId: _previous, ...again } = body;
      return nf(root, verb, again, flags, true);
    }
    return res;
  };
  // A repository may declare its own check (toolchain steps, cache presets) and runner; the rest
  // of the scenario is identical for every repository.
  const check = { ...cfg.check, ...repo.check };
  const runnerCfg = { ...cfg.runner, ...repo.runner };
  const base = join(runDir, repo.id);
  mkdirSync(base, { recursive: true });
  const since = new Date().toISOString();

  // 1. Import (born hosted). Plain git's nearest operation: a full bare clone of the fork.
  let s = state.repos[repo.id] ?? {};
  if (!s.projectId || cfg.reimport) {
    let retained = state.pendingImports?.[repo.id];
    if (retained && cfg.reimport && existsSync(retained.journalPath)) {
      const status = JSON.parse(readFileSync(retained.journalPath, 'utf8')).status;
      if (status && (status.error || ['ready', 'failed', 'cancelled'].includes(status.phase)))
        retained = null;
    }
    const journalPath = retained?.journalPath ?? join(base, 'import-journal.json');
    if (retained && !existsSync(journalPath)) {
      mkdirSync(dirname(journalPath), { recursive: true });
      writeFileSync(journalPath, JSON.stringify(retained, null, 1) + '\n');
    }
    // A refused import throws its named code; record it as the import's refusal, not a crash.
    const res = await io
      .importProject(repo, journalPath, {
        onJournal: journal => {
          (state.pendingImports ??= {})[repo.id] = { journalPath, ...journal };
          io.saveState(); // Persist the original identity before its first backend request.
        },
      })
      .catch(error => {
        const refusal = thrownRefusal(error);
        if (!refusal) throw error;
        return { phase: 'refused', error: refusal };
      });
    const imported = res.phase === 'ready' && Boolean(res.projectId);
    step('import', 'forge', {
      ok: imported,
      seconds: res.seconds,
      wallSeconds: res.wallSeconds,
      setupVoids: res.setupVoids,
      transportVoids: res.transportVoids,
      resumedImport: res.resumedImport,
      calls: res.calls,
      files: res.files,
      bytes: res.bytes,
      report: res.report,
      error: res.error ?? null,
    });
    if (!imported) {
      r.keepCheckouts = true; // The import journal owns the exact retry identity, even on refusal.
      return (refuse('import', res.error?.code ?? 'IMPORT_FAILED', JSON.stringify(res.error)), r);
    }
    s = state.repos[repo.id] = { projectId: res.projectId, commit: res.commit };
    if (state.pendingImports) {
      delete state.pendingImports[repo.id];
      if (!Object.keys(state.pendingImports).length) delete state.pendingImports;
    }
    io.saveState();
  } else r.notes.push(`import reused: project ${s.projectId}`);
  r.sourceCommit = s.commit ?? null;
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
  // Submodules are materialized in the Forge clone, so the plain-git side checks them out too.
  const gc = await io.git([
    'clone',
    '--quiet',
    '--recurse-submodules',
    `https://github.com/${repo.fork}`,
    gA,
  ]);
  step('clone', 'git', { ok: gc.code === 0, seconds: gc.seconds });

  // 2b. Tree fidelity: the Forge clone against plain git's checkout of the same fork on this machine
  // (path, kind, size, symlink target). What git itself cannot hold here is a platform limit, listed apart.
  if (gc.code === 0) {
    const tree = compareTrees(walkTree(gA), walkTree(clone));
    const ls = await io.git(['-C', join(base, 'git-bare'), 'ls-tree', '-r', '-z', 'HEAD']);
    const limits = platformLimits(ls.stdout, walkTree(gA));
    const bad = Object.entries(tree.counts).filter(([, n]) => n);
    r.fidelity = {
      ...tree,
      platformLimits: limits.slice(0, 5),
      platformLimitCount: limits.length,
      summary:
        bad
          .map(([k, n]) => `${k} ${n}${tree.examples[k][0] ? ` (${tree.examples[k][0]})` : ''}`)
          .join(', ') || null,
    };
  }

  // 3. Project setup: the repository's own CI command, trusted agent policy, the runner.
  const settings = (await nf(clone, 'check-settings', {})).json?.result ?? {};
  if (!settings.definitions?.some(d => d.name === check.name)) {
    const c = await io.cli([
      'x',
      clone,
      'configure-check',
      JSON.stringify({ operationId: randomUUID(), command: check }),
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
      JSON.stringify({ operationId: randomUUID(), provider: 'github-actions', ...runnerCfg }),
    ]);
    runner = c.code === 0;
    if (!runner)
      refuse('configure-runner', errorCode(c.json) ?? `exit ${c.code}`, c.json?.error?.message ?? c.stderr);
  }
  // Runner grants (Issue 77fa4412): record that the runner was configured with a grant only (no
  // operator binding is read here; the settings carry the grant) and what blocks landing, if anything.
  const after = (await nf(clone, 'check-settings', {})).json?.result ?? {};
  r.runnerSettings = {
    configuredNow: !settings.runner && runner,
    runnerGrant: after.runnerGrant ?? null,
    agentLandsOnPass: after.agentLandsOnPass ?? null,
    blockers: after.blockers ?? null,
    declaredToolchains: check.actionsToolchains?.map(t => t.tool) ?? [],
  };

  // `--prepare-only`: stop once the project, check and runner are set up (a measurement hold
  // delays landings; setup does not land).
  if (cfg.prepareOnly) return (r.notes.push('prepare-only: stopped before the Lanes'), r);

  // 4. Probe files: generic choice from the tree (two directories, the main source extension).
  let modules = [];
  try {
    modules = submodulePaths(readFileSync(join(clone, '.gitmodules'), 'utf8'));
  } catch {}
  const probe = pickProbeFiles(
    listFiles(clone).filter(f => !modules.some(m => f.path === m || f.path.startsWith(`${m}/`))),
  );
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

  // Affected-test selection (the land receipt of an asynchronous land carries none): lane A's
  // preflight, bounded; what it selected and why, never tuned.
  {
    const pf = await nf(lanes.a.path, 'preflight', { laneId: lanes.a.id, budgetSeconds: 90 });
    r.preflight = {
      code: pf.code,
      seconds: pf.seconds,
      error: errorCode(pf.json),
      ...(preflightFacts(pf.json) ?? {}),
    };
  }

  // Plain git: the same three edits on clones of a scratch branch of the fork.
  const branch = `zoo/${basename(runDir)}-${repo.id}`;
  const g = (dir, ...args) => io.git(['-C', dir, ...args]);
  await g(gA, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  const gB = join(base, 'git-b'),
    gC = join(base, 'git-c'),
    gD = join(base, 'git-d');
  for (const d of [gB, gC, gD])
    await io.git([
      'clone',
      '--quiet',
      '--recurse-submodules',
      '--branch',
      branch,
      `https://github.com/${repo.fork}`,
      d,
    ]);
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
        if (res.code) {
          refuse(
            `resolution ${action}`,
            errorCode(res.json) ?? `exit ${res.code}`,
            res.json?.error?.message ?? res.stderr,
          );
          r.keepCheckouts = true;
          step('resolve', 'forge', {
            ok: false,
            seconds: (performance.now() - t) / 1000,
            error: errorCode(res.json) ?? `exit ${res.code}`,
          });
          return r;
        }
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

/** Runs `fn` over `items` with at most `size` in flight; results keep the order of `items`. */
export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size || 1, items.length)) }, worker));
  return out;
}

async function main(argv) {
  const root = argv[0];
  if (!root || root.startsWith('--')) {
    console.error(
      'usage: run.mjs ZOO_ROOT [--repos a,b] [--concurrency N] [--reimport] [--no-github-run] [--prepare-only]',
    );
    return 2;
  }
  const flag = f => argv.includes(f);
  const only = argv.includes('--repos') ? argv[argv.indexOf('--repos') + 1].split(',') : null;
  const cfg = {
    ...JSON.parse(readFileSync(join(root, 'zoo.json'), 'utf8')),
    reimport: flag('--reimport'),
    noGithubRun: flag('--no-github-run'),
    prepareOnly: flag('--prepare-only'),
    concurrency: Number(argv.includes('--concurrency') ? argv[argv.indexOf('--concurrency') + 1] : 2),
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
  const results = await pool(repos, cfg.concurrency, async repo => {
    // No repository starts below the disk reserve (the machine is shared); it waits for space.
    await waitForDisk(cfg.minFreeGiB ?? 22).catch(error => {
      throw Object.assign(error, { repo: repo.id });
    });
    const result = await io.metered(repo, () =>
      runRepo(cfg, repo, state, runDir, io).catch(error => ({
        id: repo.id,
        crash: error.stack,
        ...(error.pendingSource ? { pendingSource: error.pendingSource, keepCheckouts: true } : {}),
        ...(error.pendingImport ? { pendingImport: error.pendingImport, keepCheckouts: true } : {}),
      })),
    );
    // Kept per repository as soon as it ends (an interrupted run loses only the repositories still
    // running), and its checkouts removed at once so a 25-repository run never holds them all.
    writeFileSync(join(runDir, `${repo.id}.result.json`), JSON.stringify(result, null, 1) + '\n');
    if (!flag('--keep-checkouts') && !result.keepCheckouts)
      rmSync(join(runDir, repo.id), { recursive: true, force: true });
    return result;
  });
  // The CLI follows main, so a run can straddle a release: name the CLI build before and after.
  const cliCommits = [...new Set([cliBefore, readCli()].filter(Boolean))];
  const controlCode = await io.controlCode(cfg.runner.repository).catch(error => ({ error: error.message }));
  const out = { stamp, cliCommits, deployment: cfg.deployment, controlCode, results };
  writeFileSync(join(runDir, 'RESULT.json'), JSON.stringify(out, null, 1) + '\n');
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
