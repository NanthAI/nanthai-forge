#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The zoo conformance suite (Issue 70a9bd2f): one command per step over scripts/bench-zoo/catalog.json.
//   node scripts/bench-zoo/suite.mjs provision ZOO_ROOT [--repos a,b]   forks/creates the public NanthAI repos, writes zoo.json
//   node scripts/bench-zoo/suite.mjs verify    ZOO_ROOT [--repos a,b]   plain GitHub full run of every check (no Forge)
//   node scripts/bench-zoo/suite.mjs run       ZOO_ROOT [--repos a,b] [--concurrency N] [--baseline FILE] [--save-baseline FILE]
//   node scripts/bench-zoo/suite.mjs report    ZOO_ROOT [--stamp S] [--baseline FILE] [--save-baseline FILE]
//   node scripts/bench-zoo/suite.mjs teardown  ZOO_ROOT [--repos a,b] [--projects-only]   deletes the Forge projects, then the NanthAI repos
// ZOO_ROOT/zoo.json holds the machine-local keys (deployment, deploymentName, forgeCheckout, meterCwd); the
// repositories, checks and runner come from the catalog. `run` is run.mjs followed by `report`; with
// --baseline it exits 1 when a path that passed there fails now, or a Forge operation is much slower.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exec } from './exec.mjs';
import { recipes } from './shapes.mjs';
import { provisionOne } from './provision.mjs';
import { teardown } from './teardown.mjs';
import {
  baselineOf,
  compareToBaseline,
  runEntry,
  suiteMarkdown,
  summarize,
  validateCatalog,
} from './suite-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(HERE, 'catalog.json');

const flag = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

function loadCatalog(argv) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const problems = validateCatalog(catalog);
  if (problems.length) throw Error(`catalog.json: ${problems.join('; ')}`);
  const only = flag(argv, '--repos')?.split(',');
  const unknown = (only ?? []).filter(id => !catalog.repos.some(r => r.id === id));
  if (unknown.length) throw Error(`unknown repositories: ${unknown.join(', ')}`);
  return { catalog, repos: catalog.repos.filter(r => !only || only.includes(r.id)) };
}

function writeZooJson(root, catalog, repos) {
  const path = join(root, 'zoo.json');
  const local = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  for (const key of ['deployment', 'deploymentName', 'forgeCheckout', 'meterCwd'])
    if (!local[key]) throw Error(`${path} must hold the machine-local key ${key}`);
  const known = new Set(repos.map(r => r.id));
  const kept = (local.repos ?? []).filter(r => !known.has(r.id));
  const next = {
    ...local,
    check: catalog.check,
    runner: catalog.runner,
    githubWorkflow: catalog.githubWorkflow,
    repos: [...kept, ...repos.map(runEntry)],
  };
  writeFileSync(path, JSON.stringify(next, null, 1) + '\n');
  return next;
}

/** The newest result per repository across the run folders (or just `stamp`). */
export function latestResults(root, stamp) {
  const dir = join(root, 'runs');
  const stamps = stamp
    ? [stamp]
    : readdirSync(dir)
        .filter(n => /^\d{8}T\d{6}$/.test(n))
        .sort();
  const byId = new Map();
  const imports = new Map();
  for (const s of stamps) {
    const file = join(dir, s, 'RESULT.json');
    // An interrupted run has no RESULT.json, only the repositories that ended (ID.result.json).
    const run = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : {
          cliCommits: [],
          results: readdirSync(join(dir, s))
            .filter(n => n.endsWith('.result.json'))
            .map(n => JSON.parse(readFileSync(join(dir, s, n), 'utf8'))),
        };
    for (const r of run.results) {
      // The full run reuses the project a `--prepare-only` pass imported (so the meter could see it):
      // the import timing stays with the pass that did it, whichever run that was.
      if (r.steps?.import?.forge && r.projectId) imports.set(r.projectId, r.steps.import);
      const steps =
        !r.steps?.import?.forge && imports.has(r.projectId)
          ? { ...r.steps, import: imports.get(r.projectId) }
          : r.steps;
      byId.set(r.id, { ...r, steps, stamp: s, cliCommits: run.cliCommits });
    }
  }
  return [...byId.values()];
}

function report(root, argv, catalog) {
  const stamp = flag(argv, '--stamp');
  const results = latestResults(root, stamp).filter(r => catalog.repos.some(c => c.id === r.id));
  const rows = results.map(r =>
    summarize(
      r,
      catalog.repos.find(c => c.id === r.id),
    ),
  );
  const meta = {
    stamp: stamp ?? [...new Set(results.map(r => r.stamp))].join(', '),
    cliCommits: [...new Set(results.flatMap(r => r.cliCommits ?? []))],
  };
  const markdown = suiteMarkdown(rows, meta);
  writeFileSync(join(root, 'SUITE.md'), markdown);
  writeFileSync(join(root, 'SUITE.json'), JSON.stringify({ meta, rows }, null, 1) + '\n');
  const save = flag(argv, '--save-baseline');
  if (save) writeFileSync(save, JSON.stringify(baselineOf(rows, meta), null, 1) + '\n');
  process.stdout.write(markdown);
  const against = flag(argv, '--baseline');
  if (!against) return 0;
  const regressions = compareToBaseline(rows, JSON.parse(readFileSync(against, 'utf8')));
  console.log(
    regressions.length
      ? `\nREGRESSIONS (${regressions.length}):\n${regressions.map(x => JSON.stringify(x)).join('\n')}`
      : '\nNo regression against the baseline.',
  );
  return regressions.length ? 1 : 0;
}

export async function main(argv, { run = exec } = {}) {
  const [verb, root] = argv;
  if (!verb || !root || root.startsWith('--')) {
    console.error('usage: suite.mjs provision|verify|run|report|teardown ZOO_ROOT [--repos a,b] ...');
    return 2;
  }
  const { catalog, repos } = loadCatalog(argv);
  const shapes = recipes();
  if (verb === 'report') return report(root, argv, catalog);
  if (verb === 'teardown') {
    const done = await teardown(root, repos, { projectsOnly: argv.includes('--projects-only') });
    console.log(JSON.stringify(done, null, 1));
    return done.some(d => /NOT/.test(d.project + d.repo)) ? 1 : 0;
  }
  if (verb === 'provision') {
    const cfg = JSON.parse(readFileSync(join(root, 'zoo.json'), 'utf8'));
    for (const entry of repos) {
      await provisionOne(cfg, entry, shapes, run);
      console.log(`provisioned ${entry.id} (${entry.fork})`);
    }
    writeZooJson(root, catalog, repos);
    return 0;
  }
  if (verb === 'verify') {
    const cfg = writeZooJson(root, catalog, repos);
    const { makeIo } = await import('./io.mjs');
    const io = makeIo({ cfg, root, runDir: root, state: { repos: {} }, statePath: join(root, 'state.json') });
    const { pool } = await import('./run.mjs');
    const entries = repos.map(runEntry);
    const results = await pool(entries, Number(flag(argv, '--concurrency') ?? 4), async repo => ({
      id: repo.id,
      ...(await io.githubFullRun(repo)),
    }));
    for (const r of results) console.log(`${r.id}: ${r.conclusion} (${r.jobSeconds ?? '–'} s job time)`);
    return results.every(r => r.conclusion === 'success') ? 0 : 1;
  }
  if (verb === 'run') {
    writeZooJson(root, catalog, repos);
    // The meter attributes usage to a project, so projects must exist first: import and configure the
    // missing ones in a `--prepare-only` pass (import is outside the meter), then run the scenario.
    const state = existsSync(join(root, 'state.json'))
      ? JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))
      : { repos: {} };
    const reimport = argv.includes('--reimport');
    const unprepared = repos.filter(r => reimport || !state.repos[r.id]?.projectId).map(r => r.id);
    const settledHazards = new Set();
    if (unprepared.length) {
      const prep = await run(
        process.execPath,
        [
          join(HERE, 'run.mjs'),
          root,
          '--repos',
          unprepared.join(','),
          '--prepare-only',
          ...(reimport ? ['--reimport'] : []),
          '--concurrency',
          flag(argv, '--concurrency') ?? '2',
        ],
        { timeoutMs: 3600_000 },
      );
      process.stderr.write(prep.stderr.slice(-1000));
      const prepared = prep.json?.repos ?? [];
      for (const r of prepared)
        if (
          repos.find(e => e.id === r.id)?.hazard &&
          r.refusals?.length &&
          r.refusals.every(code =>
            ['import:GITHUB_SOURCE_UNSUPPORTED', 'clone:INVALID_NATIVE_SOURCE'].includes(code),
          )
        )
          settledHazards.add(r.id);
      const ready = existsSync(join(root, 'state.json'))
        ? JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).repos
        : {};
      if (
        prep.code !== 0 ||
        unprepared.some(
          id =>
            !prepared.some(r => r.id === id && !r.crash && (!r.refusals?.length || settledHazards.has(id))) ||
            (!settledHazards.has(id) && !ready[id]?.projectId),
        )
      ) {
        process.stderr.write(`Preparation unfinished; retain results and replay journals in ${root}.\n`);
        return Number.isInteger(prep.code) && prep.code > 0 ? prep.code : 1;
      }
    }
    const scenarioRepos = repos.filter(r => !settledHazards.has(r.id));
    const pass = [
      '--repos',
      scenarioRepos.map(r => r.id).join(','),
      ...['--concurrency', '--no-github-run', '--keep-checkouts'].flatMap(f =>
        argv.includes(f) ? (f === '--concurrency' ? [f, flag(argv, f)] : [f]) : [],
      ),
    ];
    if (scenarioRepos.length) {
      const res = await run(process.execPath, [join(HERE, 'run.mjs'), root, ...pass], {
        timeoutMs: 8 * 3600_000,
      });
      process.stderr.write(res.stderr.slice(-2000));
      if (res.code > 1) return res.code;
    }
    return report(
      root,
      argv.filter(a => a !== '--repos'),
      catalog,
    );
  }
  console.error(`unknown verb ${verb}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
