// SPDX-License-Identifier: Apache-2.0
// Pure helpers of the zoo conformance suite (Issue 70a9bd2f): the catalog, the files a fork needs,
// per-path verdicts, timings against git, the result-to-commit gap, workspace prep and the baseline
// comparison. No repository-specific branches: every rule reads the catalog or the RESULT shape.

/** The shapes the suite must cover, each matched against the catalog's shape labels. */
export const REQUIRED_SHAPES = Object.freeze({
  lfs: /\blfs\b/i,
  'large binaries': /large binaries|multi-mib binaries/i,
  'long history': /\d[\d,]* commits/i,
  'case-only renames': /case-only renames/i,
  'file modes': /file modes/i,
  crlf: /\bcrlf\b/i,
  'non-utf-8 paths': /non-utf-8/i,
  submodules: /submodule/i,
  symlinks: /symlinks/i,
  monorepo: /workspace|monorepo|multi-module|cargo \+ uv/i,
});

/** Problems with a catalog, empty when valid. */
export function validateCatalog(catalog) {
  const problems = [];
  const repos = catalog?.repos ?? [];
  if (repos.length < 20 || repos.length > 30)
    problems.push(`the suite holds 20-30 repositories, found ${repos.length}`);
  const ids = new Set();
  for (const r of repos) {
    if (!/^[a-z][a-z0-9-]*$/.test(r.id ?? '')) problems.push(`bad id ${JSON.stringify(r.id)}`);
    if (ids.has(r.id)) problems.push(`duplicate id ${r.id}`);
    ids.add(r.id);
    if (r.fork !== `NanthAI/bench-zoo-${r.id}`)
      problems.push(`${r.id}: fork must be NanthAI/bench-zoo-${r.id}`);
    if (!r.upstream === !r.synthetic) problems.push(`${r.id}: exactly one of upstream and synthetic`);
    if (!r.synthetic && !r.ci?.length) problems.push(`${r.id}: ci lines are required`);
    if (!r.shapes?.length) problems.push(`${r.id}: shapes are required`);
  }
  const shapes = repos.flatMap(r => r.shapes ?? []).join('\n');
  for (const [name, pattern] of Object.entries(REQUIRED_SHAPES))
    if (!pattern.test(shapes)) problems.push(`no repository covers the shape: ${name}`);
  return problems;
}

/** The `.forge-zoo/ci.sh` text of a repository (its upstream CI command, or the shape check). */
export function ciScript(entry, recipes) {
  const lines = entry.synthetic ? recipes[entry.synthetic].ci : entry.ci;
  return `#!/usr/bin/env bash\n# Zoo check for ${entry.id} (scripts/bench-zoo/catalog.json).\nset -euo pipefail\n${lines.join('\n')}\n`;
}

/** The GitHub-equivalent full run of a check: the same command on ubuntu-latest, after the same
 * declared toolchain steps (`setup` is `declaredSetupSteps` of the declaration, or ''). */
export function zooWorkflow(setup) {
  return `name: zoo-ci
# GitHub-equivalent full run of the Forge check (bench-zoo): the same command on ubuntu-latest.
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  zoo-ci:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
        with:
          submodules: recursive
          persist-credentials: false
${setup}      - run: bash .forge-zoo/ci.sh
`;
}

/** The repository entry run.mjs consumes (its `check` carries only the differences from the base). */
export function runEntry(entry) {
  const check = {
    ...(entry.toolchains ? { actionsToolchains: entry.toolchains } : {}),
    ...(entry.cache ? { actionsCache: entry.cache } : {}),
  };
  return {
    id: entry.id,
    upstream: entry.upstream ?? entry.fork,
    fork: entry.fork,
    ref: entry.ref,
    ...(Object.keys(check).length ? { check } : {}),
  };
}

/** The paths the suite judges, in scenario order, with the result step that decides each. */
export const PATHS = Object.freeze([
  'import',
  'clone',
  'fidelity',
  'save',
  'sync',
  'land',
  'landReuse',
  'conflict',
  'resolve',
]);

/** pass / fail / skip for each path of one repository's RESULT entry. A land passes only when the
 * check passed and the change reached main (the CLI can exit 0 with a terminal CHECK_FAILED). */
export function pathVerdicts(r, entry = {}) {
  const forge = op => r.steps?.[op]?.forge;
  const verdict = (ok, why) => (ok ? { v: 'pass' } : { v: 'fail', why: why ?? null });
  const out = {};
  for (const op of PATHS) {
    if (op === 'fidelity') {
      const f = r.fidelity;
      out[op] = !f ? { v: 'skip' } : verdict(f.ok, f.summary);
      continue;
    }
    const s = forge(op);
    // A hazard repository (paths a case-insensitive or UTF-8-only volume cannot hold) passes its
    // import or clone by a structured, named refusal: lossy silent success is the failure.
    const refusal =
      entry.hazard && (op === 'import' || op === 'clone')
        ? (r.refusals ?? []).find(
            x => x.where === op && /^[A-Z][A-Z_]+$/.test(x.code) && x.code !== 'IMPORT_FAILED',
          )
        : null;
    if (refusal) {
      out[op] = { v: 'refused', why: refusal.code };
      continue;
    }
    if (!s) {
      out[op] = { v: 'skip' };
      continue;
    }
    const landed = op === 'land' || op === 'landReuse' || op === 'resolve';
    const ok = Boolean(s.ok) && !(landed && s.error);
    const why = s.error ?? s.refusal ?? null;
    out[op] = verdict(ok, typeof why === 'object' && why ? (why.code ?? JSON.stringify(why)) : why);
  }
  if (r.crash) out.crash = { v: 'fail', why: String(r.crash).split('\n')[0] };
  return out;
}

/** Forge and plain-git seconds per operation (ratio = Forge / git when both ran). */
export function timings(r) {
  const out = {};
  for (const [op, sides] of Object.entries(r.steps ?? {})) {
    const f = sides.forge?.seconds;
    const g = sides.git?.seconds;
    out[op] = {
      forge: Number.isFinite(f) ? f : null,
      git: Number.isFinite(g) ? g : null,
      ratio: Number.isFinite(f) && Number.isFinite(g) && g > 0 ? f / g : null,
    };
  }
  return out;
}

const seconds = (a, b) => {
  const s = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(s) ? s : null;
};
export const median = values => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Result-to-commit gap: seconds from the end of a landing's last check run to its commit on main. */
export function commitGaps(r) {
  const ended = new Map((r.runs ?? []).map(run => [run.runId, run.endedAt]));
  const gaps = [];
  for (const l of r.landings ?? []) {
    const ends = (l.checkRunIds ?? []).map(id => ended.get(id)).filter(Boolean);
    if (!ends.length || !l.committedAt) continue;
    const last = ends.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b));
    const gap = seconds(last, l.committedAt);
    if (gap !== null) gaps.push({ lane: l.lane, seconds: gap });
  }
  return gaps;
}

/** Workspace prep: Lane start and clone seconds, and the hosted job's setup overhead (job seconds
 * beyond the check command's own execution). Null where the run did not record it. */
export function workspacePrep(r) {
  const f = r.forgeChecks;
  const exec = (r.runs ?? []).map(x => x.executionSeconds).filter(Number.isFinite);
  const perJob = f?.jobs ? f.jobSeconds / f.jobs : null;
  return {
    startSeconds: r.steps?.start?.forge?.seconds ?? null,
    cloneSeconds: r.steps?.clone?.forge?.seconds ?? null,
    jobOverheadSeconds:
      perJob !== null && exec.length
        ? Math.max(0, perJob - exec.reduce((a, b) => a + b, 0) / exec.length)
        : null,
  };
}

/** Everything the report and the baseline keep for one repository. */
export function summarize(r, entry = {}) {
  const paths = pathVerdicts(r, entry);
  const gaps = commitGaps(r);
  return {
    id: r.id,
    paths,
    // A refused hazard ends the scenario there: the paths after it are not reached and not failed.
    pass:
      (paths.import?.v === 'refused'
        ? ['import']
        : paths.clone?.v === 'refused'
          ? ['import', 'clone']
          : PATHS
      ).every(op => ['pass', 'refused'].includes(paths[op].v)) && !paths.crash,
    seconds: timings(r),
    gapSeconds: median(gaps.map(g => g.seconds)),
    gaps,
    prep: workspacePrep(r),
    costUsd: r.meter?.valid ? Object.values(r.meter.costBreakdownUsd ?? {}).reduce((a, b) => a + b, 0) : null,
    refusals: (r.refusals ?? []).map(x => `${x.where}: ${x.code}`),
  };
}

const f1 = v => (v === null || v === undefined ? '–' : (Math.round(v * 10) / 10).toString());
const mark = v => ({ pass: '✓', fail: '✗', skip: '·', refused: '⊘' })[v] ?? '?';

/** The Markdown report of a suite run: pass/fail per path, timings next to git, gap, prep, cost. */
export function suiteMarkdown(rows, meta = {}) {
  const lines = [
    `# Zoo suite${meta.stamp ? ` ${meta.stamp}` : ''}`,
    '',
    `${rows.filter(r => r.pass).length} of ${rows.length} repositories pass every path. ✓ pass, ✗ fail, ⊘ refused by name (expected for a hazard), · not reached.`,
    '',
    `| Repo | ${PATHS.join(' | ')} |`,
    `| --- | ${PATHS.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.id} | ${PATHS.map(op => mark(r.paths[op]?.v)).join(' | ')} |`),
    '',
    '## Seconds next to plain git (median over repositories that ran both)',
    '',
    '| Operation | Forge s | git s | Forge ÷ git | repos |',
    '| --- | --- | --- | --- | --- |',
  ];
  const ops = ['import', 'clone', 'start', 'save', 'sync', 'conflict', 'resolve', 'land', 'landReuse'];
  for (const op of ops) {
    const cells = rows.map(r => r.seconds[op]).filter(Boolean);
    if (!cells.length) continue;
    const pairs = cells.filter(c => c.forge !== null && c.git !== null);
    lines.push(
      `| ${op} | ${f1(median(cells.map(c => c.forge)))} | ${f1(median(cells.map(c => c.git)))} | ${f1(median(pairs.map(c => c.ratio)))} | ${cells.length} |`,
    );
  }
  const gaps = rows.flatMap(r => r.gaps.map(g => g.seconds));
  lines.push(
    '',
    '## Result-to-commit gap and workspace prep (seconds)',
    '',
    `Gap from a check's end to its commit on main: median ${f1(median(gaps))}, worst ${f1(gaps.length ? Math.max(...gaps) : null)} over ${gaps.length} landings.`,
    '',
    '| Repo | start | clone | hosted job overhead | gap (median) |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      r =>
        `| ${r.id} | ${f1(r.prep.startSeconds)} | ${f1(r.prep.cloneSeconds)} | ${f1(r.prep.jobOverheadSeconds)} | ${f1(r.gapSeconds)} |`,
    ),
  );
  const failures = rows.flatMap(r =>
    PATHS.filter(op => r.paths[op]?.v === 'fail').map(
      op => `- ${r.id} ${op}: ${r.paths[op].why ?? 'failed'}`,
    ),
  );
  if (failures.length) lines.push('', '## Failures', '', ...failures);
  const cost = rows.map(r => r.costUsd).filter(Number.isFinite);
  lines.push(
    '',
    `Dev Convex cost of the run: $${cost.reduce((a, b) => a + b, 0).toFixed(3)} over ${cost.length} metered repositories.`,
  );
  return lines.join('\n') + '\n';
}

/** The compact baseline kept for regression runs. */
export const baselineOf = (rows, meta = {}) => ({
  version: 1,
  ...meta,
  repos: Object.fromEntries(
    rows.map(r => [
      r.id,
      {
        paths: Object.fromEntries(PATHS.map(op => [op, r.paths[op]?.v ?? 'skip'])),
        seconds: Object.fromEntries(Object.entries(r.seconds).map(([op, s]) => [op, s.forge])),
        gapSeconds: r.gapSeconds,
      },
    ]),
  ),
});

/** What got worse against a baseline: a path that passed and now does not, or a Forge operation that
 * took more than `factor` times its baseline (and 5 s more). New repositories are not judged. */
export function compareToBaseline(rows, baseline, { factor = 1.5 } = {}) {
  const regressions = [];
  for (const r of rows) {
    const was = baseline.repos?.[r.id];
    if (!was) continue;
    for (const op of PATHS)
      if (
        ['pass', 'refused'].includes(was.paths[op]) &&
        r.paths[op]?.v !== was.paths[op] &&
        !(was.paths[op] === 'refused' && r.paths[op]?.v === 'pass')
      )
        regressions.push({ id: r.id, op, kind: 'path', was: was.paths[op], now: r.paths[op]?.v ?? 'skip' });
    for (const [op, before] of Object.entries(was.seconds ?? {})) {
      const now = r.seconds[op]?.forge;
      if (
        Number.isFinite(before) &&
        Number.isFinite(now) &&
        now > before * factor + 5 &&
        was.paths[op] !== 'fail'
      )
        regressions.push({ id: r.id, op, kind: 'seconds', was: before, now });
    }
  }
  return regressions;
}
