// SPDX-License-Identifier: Apache-2.0
// Pure pieces of scripts/bench-landing.mjs: progress parsing, phase timing,
// statistics, scenario files, the GitHub workflow and report rendering.

export const SCENARIOS = ['docs', 'code', 'multi'];

// Finish progress lines are `phase: [operation=…] [run=…] details elapsed=Ns [totalAge=Ns]`
// (src/work-progress.ts). JSON lines with a `phase` field are accepted too.
const PROGRESS = /^([a-z][a-z0-9 ]*?): (.*?)\s*elapsed=(\d+)s(?: totalAge=(\d+)s)?\s*$/;
export function parseProgressLine(line) {
  const text = String(line).trim();
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text);
      if (typeof value?.phase !== 'string') return null;
      return {
        phase: value.phase,
        elapsedS: Number.isFinite(value.elapsedS) ? value.elapsedS : 0,
        operation: value.operationId ?? null,
        run: value.runId ?? null,
        details: '',
      };
    } catch {
      return null;
    }
  }
  const match = PROGRESS.exec(text);
  if (!match) return null;
  let details = match[2];
  const take = key => {
    const found = new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(details);
    if (found) details = details.replace(found[0], '').trim();
    return found?.[1] ?? null;
  };
  const operation = take('operation'),
    run = take('run');
  return {
    phase: match[1],
    elapsedS: Number(match[3]),
    ...(match[4] === undefined ? {} : { totalAgeS: Number(match[4]) }),
    operation,
    run,
    details,
  };
}

export function phaseCategory(phase) {
  if (['waiting for lock', 'queued for check', 'waiting to land'].includes(phase)) return 'queueWait';
  if (phase === 'preparing finish' || phase === 'preparing check') return 'prepare';
  if (phase === 'running check') return 'check';
  if (phase === 'landing') return 'landing';
  if (phase === 'finish retry') return 'retry';
  return 'other';
}

/** events: [{atMs, line}] stamped on arrival. A phase starts when its first line
 * arrives (Forge prints on phase entry, then every 5 s) and ends when the next phase
 * starts; the last ends at endMs. Printed `elapsed` is not used: it is not reset on
 * every phase change. Time before the first line is `prepare` (checkpoint, sync,
 * compose). Returns milliseconds per category. */
export function finishPhases(events, startMs, endMs) {
  const totals = { prepare: 0, queueWait: 0, check: 0, landing: 0, retry: 0, other: 0 };
  let category = 'prepare',
    cursor = startMs;
  for (const { atMs, line } of [...events].sort((a, b) => a.atMs - b.atMs)) {
    const parsed = parseProgressLine(line);
    if (!parsed) continue;
    const next = phaseCategory(parsed.phase),
      at = Math.min(Math.max(atMs, cursor), endMs);
    if (next === category) continue;
    totals[category] += at - cursor;
    category = next;
    cursor = at;
  }
  totals[category] += Math.max(0, endMs - cursor);
  return totals;
}

/** Durations recorded by the check runner itself (same machine clock). */
export function runRecordTimes(run) {
  const at = value => (typeof value === 'string' ? Date.parse(value) : NaN);
  const queued = at(run?.queuedAt),
    started = at(run?.startedAt),
    ended = at(run?.endedAt);
  return {
    runQueueMs: Number.isFinite(queued) && Number.isFinite(started) ? started - queued : null,
    runCheckMs: Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null,
  };
}

/** GitHub check rows from `gh pr checks --json name,state,startedAt,completedAt`. */
export function githubCheckTimes(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const time = value => (value && !value.startsWith('0001-') ? Date.parse(value) : NaN);
  const started = list.map(row => time(row.startedAt)).filter(Number.isFinite),
    completed = list.map(row => time(row.completedAt)).filter(Number.isFinite);
  const pending = list.some(
    row => !['SUCCESS', 'FAILURE', 'CANCELLED', 'SKIPPED', 'NEUTRAL'].includes(row.state),
  );
  return {
    registered: list.length > 0,
    done: list.length > 0 && !pending,
    passed:
      list.length > 0 && !pending && list.every(row => ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(row.state)),
    checkMs: started.length && completed.length ? Math.max(...completed) - Math.min(...started) : null,
  };
}

// Nearest-rank percentile over finite values.
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
export function summarize(samples) {
  const groups = new Map();
  for (const sample of samples) {
    if (sample.status !== 'ok') continue;
    for (const [phase, ms] of Object.entries(sample.phases)) {
      if (!Number.isFinite(ms)) continue;
      const key = `${sample.side}\u0000${sample.scenario}\u0000${phase}\u0000${sample.pair ?? ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ms);
    }
  }
  return [...groups].map(([key, values]) => {
    const [side, scenario, phase, pair] = key.split('\u0000');
    return {
      ...(pair ? { pair } : {}),
      side,
      scenario,
      phase,
      n: values.length,
      medianMs: percentile(values, 50),
      p90Ms: percentile(values, 90),
    };
  });
}

// The docs inventory check rejects new files under docs/, so the docs scenario
// rewrites one marker line at the end of an existing document.
export const DOCS_PROBE = 'docs/development.md';
const MARKER = /\s*<!-- forge-bench: [^>]* -->\s*$/;
export function withDocsMarker(previous, token) {
  return `${previous.replace(MARKER, '').trimEnd()}\n\n<!-- forge-bench: ${token} -->\n`;
}

/** Returns path -> (previous content or null) -> new content. */
export function scenarioEdits(scenario, token, member) {
  if (member !== undefined) {
    const edits = scenarioEdits('code', token);
    return Object.fromEntries(
      Object.entries(edits).map(([path, edit]) => [
        path.replaceAll('bench-probe', `bench-probe-burst-${member}`),
        () => edit().replaceAll('bench-probe', `bench-probe-burst-${member}`),
      ]),
    );
  }
  if (scenario === 'docs') return { [DOCS_PROBE]: previous => withDocsMarker(previous ?? '', token) };
  return Object.fromEntries(
    Object.entries(scenarioFiles(scenario, token)).map(([path, text]) => [path, () => text]),
  );
}

function scenarioFiles(scenario, token) {
  const probe = name =>
    `// SPDX-License-Identifier: Apache-2.0\n// Benchmark probe; safe to delete.\nexport const ${name} = '${token}';\n`;
  const test = (names, file) =>
    `// SPDX-License-Identifier: Apache-2.0\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\n${names
      .map(([n, f]) => `import { ${n} } from '../dist/${f}.js';\n`)
      .join('')}\ntest('${file} carries the run token', () => {\n${names
      .map(([n]) => `  assert.equal(${n}, '${token}');\n`)
      .join('')}});\n`;
  if (scenario === 'code')
    return {
      'src/bench-probe.ts': probe('BENCH_PROBE'),
      'tests/bench-probe.test.mjs': test([['BENCH_PROBE', 'bench-probe']], 'bench-probe'),
    };
  if (scenario === 'multi') {
    const names = [1, 2, 3, 4].map(i => [`BENCH_PROBE_${i}`, `bench-probe-${i}`]);
    return {
      ...Object.fromEntries(names.map(([n, f]) => [`src/${f}.ts`, probe(n)])),
      'tests/bench-probe-multi.test.mjs': test(names, 'bench-probe-multi'),
    };
  }
  throw new Error(`Unknown scenario ${scenario}`);
}

// Same selection as Forge's standard check: forge-check.mjs with FORGE_CHECK_SCOPED=1 and
// the PR's base/head pins as the comparison.
export { githubWorkflow } from './bench-landing-workflow.mjs';
import { githubWorkflow } from './bench-landing-workflow.mjs';
export const GITHUB_WORKFLOW = githubWorkflow();

export const repoName = (date, pair) =>
  `forge-bench-${date.toISOString().slice(0, 10).replaceAll('-', '')}${pair ? `-${pair.toLowerCase()}` : ''}`;

const seconds = ms => (ms === null ? '—' : (ms / 1000).toFixed(1));
export function renderMarkdown(report) {
  const rows = summarize(report.samples);
  const env = report.environment;
  const lines = [
    `# Landing benchmark: Forge vs Git+GitHub`,
    '',
    `Run ${report.startedAt}. ${report.dryRun ? '**Dry run: nothing was executed.**' : ''}`.trim(),
    '',
    `- Machine: ${env.cpus} cores, ${env.memoryGiB} GiB, ${env.platform}; load avg at start ${env.loadStart.join(' / ')}`,
    `- Forge: ${report.setup.forge?.mode ?? 'skipped'}; runner ${env.forgeRunner}`,
    `- GitHub: ${report.setup.github?.repo ?? 'skipped'} (${env.githubVisibility}); runner ${env.githubRunner}; configured shards ${env.shards ?? 1}`,
    '',
    '| Side | Scenario | Phase | n | median s | p90 s |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      r =>
        `| ${r.side} | ${r.scenario} | ${r.phase} | ${r.n} | ${seconds(r.medianMs)} | ${seconds(r.p90Ms)} |`,
    ),
  ];
  for (const pair of [...new Set(report.samples.map(s => s.pair).filter(Boolean))]) {
    lines.push(
      '',
      `## ${pair}`,
      '',
      '| Side | Scenario | Phase | n | median s | p90 s |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows
        .filter(r => r.pair === pair)
        .map(
          r =>
            `| ${r.side} | ${r.scenario} | ${r.phase} | ${r.n} | ${seconds(r.medianMs)} | ${seconds(r.p90Ms)} |`,
        ),
    );
  }
  lines.push(
    '',
    'Burst and cost observations:',
    ...report.samples
      .filter(s => s.burst || s.cost)
      .map(
        s =>
          `- ${s.pair ?? ''} ${s.side} ${s.scenario} #${s.run}: ${JSON.stringify({ burst: s.burst, cost: s.cost })}`,
      ),
  );
  for (const pair of [...new Set(report.samples.map(s => s.pair).filter(Boolean))]) {
    const metrics = new Map();
    for (const sample of report.samples.filter(s => s.pair === pair && s.status === 'ok' && s.burst)) {
      for (const [metric, value] of Object.entries(sample.burst)) {
        if (!Number.isFinite(value)) continue;
        const key = `${sample.side} | ${sample.scenario} | ${metric}`;
        if (!metrics.has(key)) metrics.set(key, []);
        metrics.get(key).push(value);
      }
    }
    if (metrics.size)
      lines.push(
        '',
        `### ${pair} burst sets (ms, landings/hour, or counts)`,
        '',
        '| Side | Scenario | Metric | n | median | p90 |',
        '| --- | --- | --- | --- | --- | --- |',
        ...[...metrics].map(
          ([key, values]) =>
            `| ${key} | ${values.length} | ${percentile(values, 50)} | ${percentile(values, 90)} |`,
        ),
      );
  }
  const failed = report.samples.filter(sample => sample.status !== 'ok');
  if (failed.length)
    lines.push(
      '',
      'Failed samples (excluded):',
      ...failed.map(s => `- ${s.side} ${s.scenario} #${s.run}: ${s.error}`),
    );
  return `${lines.join('\n')}\n`;
}

/** A bounded `finish` can return `waiting to land` (terminal:false) while the change is
 * still queued behind a check. That is not a failure: replay the original request plus
 * its `resolved` pins (reconciles without repeating the check) until the Lane is
 * landed or rejected. `call(body)` runs one finish; `sleep`/`now` are injectable. */
export async function finishUntilLanded(
  call,
  body,
  {
    sleep = ms => new Promise(r => setTimeout(r, ms)),
    now = Date.now,
    limitMs = 45 * 60_000,
    pollMs = 2000,
  } = {},
) {
  const end = now() + limitMs;
  let replays = 0,
    result = await call(body);
  while (result.status === 'waiting to land') {
    if (now() >= end) throw new Error(`finish still waiting to land after ${Math.round(limitMs / 1000)}s`);
    await sleep(pollMs);
    replays++;
    result = await call({ ...body, ...(result.resolved ?? {}) });
  }
  return { result, replays };
}
