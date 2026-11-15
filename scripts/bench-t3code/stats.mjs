#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Offline, public-safe, deterministic JSON and Markdown from retained benchmark cells.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readSeries, readB15dReport } from './stats-data.mjs';
import { aggregate, compareGroups, metrics } from './stats-math.mjs';
import { render } from './stats-render.mjs';

function leadChanges(current, previous) {
  const changes = [];
  for (const c of current) {
    const p = previous.find(p => p.kind === c.kind && p.N === c.N && p.arm === c.arm);
    if (!p) continue;
    for (const scope of ['perCell', 'perLanding'])
      for (const metric of Object.keys(metrics)) {
        const a = p[scope][metric],
          b = c[scope][metric];
        if (
          a.median.percent == null &&
          b.median.percent == null &&
          a.mean.percent == null &&
          b.mean.percent == null
        )
          continue;
        const delta = (x, y) => (x != null && y != null ? y - x : null);
        changes.push({
          kind: c.kind,
          N: c.N,
          arm: c.arm,
          scope,
          metric,
          oldMedian: a.median.percent,
          newMedian: b.median.percent,
          medianPoints: delta(a.median.percent, b.median.percent),
          oldMean: a.mean.percent,
          newMean: b.mean.percent,
          meanPoints: delta(a.mean.percent, b.mean.percent),
        });
      }
  }
  return changes;
}

export function buildReport(inputs, { primary = inputs[0]?.name, classifier = {} } = {}) {
  const series = inputs.map(input => {
    const groups = aggregate(input.cells);
    return { ...input, groups, gains: compareGroups(groups) };
  });
  const selected = series.find(s => s.name === primary);
  if (!selected) throw Error('Primary series not found');
  return {
    schema: 1,
    primary,
    classifier,
    definitions: Object.fromEntries(
      Object.entries(metrics).map(([key, [label, unit, direction]]) => [
        key,
        { label, unit, direction: direction ?? 'lower' },
      ]),
    ),
    series,
    history: series
      .filter(s => s !== selected)
      .map(s => ({
        reference: s.name,
        comparisons: compareGroups(selected.groups, s.groups, false),
        leadChanges: leadChanges(selected.gains, s.gains),
      })),
  };
}

function options(args) {
  const out = {
    series: new Map(),
    out: 'docs/research/p6-exit-bench-results',
    reworkModule: new URL('./rework.mjs', import.meta.url).pathname,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i],
      value = args[++i];
    if (!value) throw Error(`Missing value for ${flag}`);
    if (flag === '--series') {
      const at = value.indexOf('='),
        name = value.slice(0, at),
        path = value.slice(at + 1);
      if (at < 1 || !/^[a-zA-Z0-9_-]+$/.test(name) || !path)
        throw Error('Use --series PUBLIC_NAME=DIRECTORY');
      const roots = out.series.get(name) ?? [];
      roots.push(resolve(path));
      out.series.set(name, roots);
    } else if (flag === '--out') out.out = value;
    else if (flag === '--primary') out.primary = value;
    else if (flag === '--rework-module') out.reworkModule = resolve(value);
    else if (flag === '--classifier-state') {
      if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Classifier State must be a full digest');
      out.classifierState = value;
    } else if (flag === '--b15d-report') out.b15dReport = value;
    else throw Error(`Unknown option ${flag}`);
  }
  if (!out.series.size)
    throw Error(
      'Usage: stats.mjs --series NAME=DIRECTORY [--series NAME=DIRECTORY] [--primary NAME] [--rework-module MODULE] [--classifier-state STATE] [--b15d-report REPORT] [--out PREFIX]',
    );
  return out;
}

export async function main(args) {
  const o = options(args);
  const { runRework } = await import(pathToFileURL(o.reworkModule).href);
  const inputs = [...o.series].map(([name, roots]) => ({ name, ...readSeries(roots, runRework) }));
  if (o.b15dReport) {
    if (o.series.has('b15d')) throw Error('Supply raw B1.5d inputs or its report, not both');
    inputs.push({ name: 'b15d', ...readB15dReport(o.b15dReport) });
  }
  const digests = Object.fromEntries(
    ['rework.mjs', 'phases.mjs', 'command-text.mjs', 'transcripts.mjs'].map(name => [
      name,
      createHash('sha256')
        .update(readFileSync(name === 'rework.mjs' ? o.reworkModule : join(dirname(o.reworkModule), name)))
        .digest('hex'),
    ]),
  );
  const report = buildReport(inputs, {
    primary: o.primary ?? inputs[0].name,
    classifier: { state: o.classifierState ?? null, digests },
  });
  mkdirSync(dirname(resolve(o.out)), { recursive: true });
  writeFileSync(`${o.out}.json`, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(`${o.out}.md`, render(report, { jsonName: encodeURIComponent(basename(o.out)) + '.json' }));
  console.log(
    JSON.stringify({
      series: report.series.map(s => ({
        name: s.name,
        included: s.cells.length,
        voided: s.voided.length,
        excluded: s.excluded.length,
      })),
      serviceCalls: 0,
    }),
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2));
