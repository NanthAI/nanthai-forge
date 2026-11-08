// SPDX-License-Identifier: Apache-2.0
// Refusal visibility (Issue 7c2e69e1): every fast-path fallback records a stable reason,
// counted per stage in metrics, with Forge limitations flagged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FALLBACK_REASONS,
  contractGateFallback,
  countFallbacks,
  fallbackKind,
  selectionFallback,
} from '../dist/fallback-reasons.js';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { formatMetrics, metricsHeadline, formatMetricsHeadline } from '../dist/self-metrics-format.js';
import { scopedRecheckSelection } from '../dist/scoped-recheck.js';
import { cellFallbacks } from '../scripts/bench-t3code/fallbacks.mjs';
import { fixture, period, at } from './self-metrics-hosted-fixture.mjs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/** String literals of one exported union type. */
const union = (text, name) => {
  const body = text.match(new RegExp(`export type ${name} =([^;]+);`));
  assert(body, name);
  return [...body[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]);
};

test('every reuse and proof refusal the code can record has an explicit kind (build-failing guard)', () => {
  const codes = new Set([
    ...union(source('src/hosted-cross-head-analysis.ts'), 'FirstCheckRecheck'),
    ...union(source('convex/projectHostedReuseStore.ts'), 'ReuseIneligible'),
    // Literal reasons passed straight to the install, and the receipt's own defaults.
    ...[
      ...source('convex/projectHostedFinishControl.ts').matchAll(/installFinishCompose\([^)]*'([a-z-]+)'\)/g),
    ].map(match => match[1]),
    ...[...source('src/hosted-acceptance.ts').matchAll(/\? '([a-z-]+)' : '([a-z-]+)'\)/g)].flatMap(m => [
      m[1],
      m[2],
    ]),
  ]);
  assert(codes.has('unsupported-mode') && codes.has('analysis-expired') && codes.has('cohort'));
  for (const code of codes) {
    assert(code in FALLBACK_REASONS['main-race'], `unclassified main-race reason ${code}`);
    assert(code in FALLBACK_REASONS['first-check'], `unclassified first-check reason ${code}`);
  }
});

test('every full-gate reason gateFor writes maps to a named contract-gate code', () => {
  const reasons = [
    ...source('src/contract-gate-policy.ts').matchAll(/reason = (?:[^;]*\? )?'([^']+)'(?: : '([^']+)')?;/g),
  ].flatMap(m => [m[1], m[2]].filter(Boolean));
  assert(reasons.includes('Contract gate is off') && reasons.includes('Main is red'), reasons.join('|'));
  for (const reason of reasons) {
    const code = contractGateFallback({ mode: 'full', reason });
    if (['Contract gate is off', 'Full gate'].includes(reason)) assert.equal(code, undefined, reason);
    else assert(code && code !== 'contract-other', `${reason} -> ${code}`);
  }
  // A demoting trust level carries its own text; audit, probe and contract runs are not fallbacks.
  assert.equal(
    contractGateFallback({ mode: 'full', reason: 'Actor trust is supervised on src/**' }),
    'contract-trust',
  );
  assert.equal(contractGateFallback({ mode: 'audit', reason: 'Main audit' }), undefined);
  assert.equal(contractGateFallback({ mode: 'contract', reason: 'Trusted actor' }), undefined);
  assert.equal(contractGateFallback(undefined), undefined);
});

test('kinds: symlink/submodule and undeclared docs are limitations; conflicts, risk and policy are genuine', () => {
  for (const code of ['unsupported-mode', 'source-unavailable', 'composition-not-exact', 'not-eligible'])
    assert.equal(fallbackKind('main-race', code), 'limitation', code);
  for (const code of ['path-overlap', 'global-risk', 'text-conflict', 'main-red', 'reuse-policy'])
    assert.equal(fallbackKind('first-check', code), 'genuine', code);
  assert.equal(fallbackKind('selection', 'docs-paths-undeclared'), 'limitation');
  assert.equal(fallbackKind('selection', 'scoped-root-config'), 'genuine');
  // Forge fell back without saying why: counted, and flagged.
  assert.equal(fallbackKind('selection', 'something-new'), 'limitation');
});

test('the runner names why the command could not be narrowed or skipped', () => {
  const base = { standard: false, gate: undefined, docsPaths: undefined, mainPaths: null };
  const full = { scope: 'full' };
  // Any ecosystem: an opaque command runs whole for a Markdown-only change without docsPaths.
  assert.equal(
    selectionFallback({ ...base, paths: ['README.md', 'docs/a.md'], selected: full }),
    'docs-paths-undeclared',
  );
  assert.equal(
    selectionFallback({ ...base, docsPaths: ['docs/**'], paths: ['README.md'], selected: full }),
    undefined,
  );
  assert.equal(selectionFallback({ ...base, paths: ['main.go'], selected: full }), undefined);
  assert.equal(
    selectionFallback({ ...base, paths: ['README.md'], gate: { mode: 'audit' }, selected: full }),
    undefined,
  );
  // The contract gate's selection went full.
  assert.equal(
    selectionFallback({
      ...base,
      standard: true,
      paths: ['src/a.ts'],
      gate: { mode: 'contract' },
      selected: full,
    }),
    'contract-full',
  );
  // A scoped recheck without its checked base's main delta.
  const scoped = { mode: 'scoped', reason: `scoped-recheck:${'a'.repeat(64)}` };
  assert.equal(
    selectionFallback({ ...base, standard: true, paths: ['src/a.ts'], gate: scoped, selected: full }),
    'scoped-base-unavailable',
  );
  assert.equal(
    selectionFallback({
      ...base,
      standard: true,
      paths: ['src/a.ts'],
      gate: scoped,
      selected: { scope: 'scoped' },
    }),
    undefined,
  );
  // Intent union tests under another command need the project's runner (any ecosystem).
  for (const status of [
    'unavailable',
    () => {
      throw new Error('unreadable package.json');
    },
  ])
    assert.equal(
      selectionFallback({
        ...base,
        paths: ['src/a.py'],
        selected: full,
        testRunner: typeof status === 'function' ? status : () => status,
      }),
      'test-runner-unavailable',
    );
  assert.equal(
    selectionFallback({ ...base, paths: ['src/a.py'], selected: full, testRunner: () => 'available' }),
    undefined,
  );
  // An explicit selector code wins; an unknown one is ignored.
  assert.equal(
    selectionFallback({
      ...base,
      paths: ['src/a.py'],
      selected: { scope: 'full', fallback: 'test-runner-unavailable' },
    }),
    'test-runner-unavailable',
  );
  assert.equal(
    selectionFallback({ ...base, paths: ['src/a.py'], selected: { scope: 'full', fallback: 'made-up' } }),
    undefined,
  );
  // The scoped recheck selector says which kind of full it needed.
  const files = new Map([['package.json', '{}']]);
  assert.equal(
    scopedRecheckSelection({ lanePaths: ['package.json'], mainPaths: ['src/a.ts'], files }).fallback,
    'scoped-root-config',
  );
});

test('counts sort limitations first and name them in one warning line', () => {
  const counted = countFallbacks([
    { stage: 'main-race', reason: 'path-overlap' },
    { stage: 'main-race', reason: 'path-overlap' },
    { stage: 'first-check', reason: 'unsupported-mode' },
  ]);
  assert.deepEqual(
    counted.byReason.map(row => [row.stage, row.reason, row.kind, row.count]),
    [
      ['first-check', 'unsupported-mode', 'limitation', 1],
      ['main-race', 'path-overlap', 'genuine', 2],
    ],
  );
  assert.equal(counted.limitations, 1);
  assert.match(counted.warning, /first-check unsupported-mode ×1/);
  assert.doesNotMatch(counted.warning, /path-overlap/);
  assert.equal(countFallbacks([{ stage: 'main-race', reason: 'path-overlap' }]).warning, null);
});

/** One admitted landing that rechecked (unsupported-mode), one main race (path-overlap,
 * unscoped), one run that ran an opaque command whole for docs, one contributor run. */
function seeded() {
  const f = fixture();
  const head = n => n.repeat(64);
  f.landing('a', at(1), at(5));
  const a = f.tables.projectHostedAcceptances.at(-1);
  a.value = JSON.stringify({
    ...JSON.parse(a.value),
    firstCheck: { landedOn: 'recheck', reason: 'unsupported-mode' },
  });
  f.landing('b', at(2), at(9));
  const b = f.tables.projectHostedAcceptances.at(-1);
  b.value = JSON.stringify({ ...JSON.parse(b.value), attemptId: 'b/child' });
  const attempt = (id, start, main, extra) => ({
    id,
    at: start,
    main: { head: main },
    check: { runId: `${id}-run` },
    actor: { kind: 'agent' },
    policy: { acceptance: { mode: 'auto-on-pass' } },
    ...extra,
  });
  f.tables.projectHostedLandingAttempts.at(-1).value = JSON.stringify(
    attempt('b', at(2), head('1'), { parentAttemptId: null }),
  );
  f.put(
    'projectHostedLandingAttempts',
    {
      projectId: 'project',
      submissionId: 'b',
      attemptId: 'b/child',
      number: 1,
      value: JSON.stringify(
        attempt('b/child', at(6), head('2'), {
          parentAttemptId: 'b',
          recheckReason: 'path-overlap',
          scopedFallback: 'scoped-no-evidence',
        }),
      ),
    },
    at(6),
  );
  const request = f.tables.projectHostedLandingRequests.at(-1);
  request.value = JSON.stringify({ ...JSON.parse(request.value), attemptId: 'b/child' });
  f.run('b-run', at(2), at(5), 120);
  f.run('b/child-run', at(6), at(8), 120);
  f.run('docs', at(3), at(4), 60, { fallback: 'docs-paths-undeclared' });
  f.run('contributor', at(3), at(4), 60, {
    gate: { mode: 'full', reason: 'Owner review, contributor or system acceptance' },
  });
  f.run('gate-off', at(3), at(4), 60, { gate: { mode: 'full', reason: 'Contract gate is off' } });
  return f;
}

test('metrics count fallbacks per stage and reason from the pages it already reads, with no write', async () => {
  const f = seeded();
  const { records } = await readHostedMetricPages(f.query, period);
  const callsBefore = f.meter.calls;
  const surface = metricsSurface(records, period);
  const value = surface.totals.fallbacks;
  assert.deepEqual(value.byReason.map(row => `${row.kind} ${row.stage} ${row.reason} ${row.count}`).sort(), [
    'genuine contract-gate contract-actor 1',
    'genuine main-race path-overlap 1',
    'limitation first-check unsupported-mode 1',
    'limitation scoped-recheck scoped-no-evidence 1',
    'limitation selection docs-paths-undeclared 1',
  ]);
  assert.equal(value.limitations, 3);
  assert.equal(value.total, 5);
  assert.equal(value.partial, false);
  // Each main-race row names why its replacement rechecked.
  const race = surface.totals.waste.rows.filter(row => row.cause === 'main-race');
  assert.deepEqual(
    race.map(row => [row.entryId, row.recheckReason]),
    [['b', 'path-overlap']],
  );
  // Flagged in the text output and in the status headline, once.
  const text = formatMetrics(surface);
  assert.match(text, /Fast-path fallbacks: 5 \(3 limitation\)/);
  assert.match(text, /⚑ limitation · first-check unsupported-mode ×1/);
  assert.match(text, /genuine · main-race path-overlap ×1/);
  const headline = formatMetricsHeadline(metricsHeadline(surface.totals));
  assert.equal(headline.filter(line => line.startsWith('Forge fast-path limitations')).length, 1);
  assert.match(headline.join('\n'), /selection docs-paths-undeclared ×1/);
  assert.equal(f.meter.writes, 0);
  assert.equal(f.meter.calls, callsBefore, 'counting adds no read');
  // The exit bench copies the counts into the Forge cell result.
  const cell = cellFallbacks({ action: 'metrics', result: JSON.parse(JSON.stringify(surface)) });
  assert.equal(cell.limitations, 3);
  assert.deepEqual(Object.keys(cell.byReason[0]).sort(), ['count', 'kind', 'reason', 'stage']);
  assert.match(cellFallbacks({ result: {} }).error, /totals\.fallbacks/);
});

test('an older deployment without the projection reports fallbacks as partial, not zero', async () => {
  const f = seeded();
  const query = async (name, args) => {
    const raw = await f.query(name, args);
    if (name !== 'projectSelfMetrics:page' || args.stream !== 'runs') return raw;
    const page = JSON.parse(raw);
    page.page = page.page.map(({ selectionFallback: _s, gateFallback: _g, ...row }) => row);
    return JSON.stringify(page);
  };
  const { records } = await readHostedMetricPages(query, period);
  const value = metricsSurface(records, period).totals.fallbacks;
  assert.equal(value.partial, true);
  assert.match(value.gaps[0], /predate the fallback-reason projection/);
});
