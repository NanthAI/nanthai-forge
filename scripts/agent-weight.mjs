// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const webOnlyPackages = ['react', 'react-dom', 'react-markdown', 'remark-gfm'];
export function webImport(id, root) {
  const path = relative(root, id.split('?')[0]).split(sep).join('/');
  return (
    path.startsWith('web/') ||
    /\.(?:css|svg|png|jpe?g|woff2?)$/.test(path) ||
    webOnlyPackages.some(
      name => id === name || id.startsWith(`${name}/`) || id.includes(`/node_modules/${name}/`),
    )
  );
}
export function agentBoundary(root) {
  root = realpathSync(root);
  return {
    name: 'forge-agent-weight-boundary',
    enforce: 'pre',
    resolveId(source) {
      if (webOnlyPackages.some(name => source === name || source.startsWith(`${name}/`)))
        this.error(`Agent entry imports web-only package ${source}`);
    },
    load(id) {
      if (webImport(id, root)) this.error(`Agent entry imports web code: ${relative(root, id)}`);
    },
  };
}
/** Logical bytes (not filesystem blocks): independent of compression, clonefile and platform metadata. */
export function installedWeight(prefix) {
  let bytes = 0;
  const packages = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        bytes += lstatSync(path).size;
        if (
          entry.name === 'package.json' &&
          /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(path.split(sep).join('/'))
        ) {
          const pkg = JSON.parse(readFileSync(path, 'utf8'));
          packages.push(`${pkg.name}@${pkg.version}`);
        }
      }
    }
  }
  walk(join(prefix, 'node_modules'));
  return { bytes, packages: [...new Set(packages)].sort() };
}
export const baselineHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ledgerPath = root => join(root, 'tests/agent-weight-ledger');
const reasonRequired =
  'Agent weight baseline needs a hashed reason and Issue; review the new measurements before landing.';
const hasReason = record =>
  /\b[0-9a-f]{8}\b/.test(record?.issue) &&
  typeof record?.reason === 'string' &&
  record.reason.trim().length >= 20;

function baselinePins(baseline) {
  const pins = {};
  function visit(value, path) {
    // Both inventories are sorted. Pin each action so independent entries can merge.
    if (path.at(-1) === 'agentActions' && Array.isArray(value))
      value = Object.fromEntries(value.map(action => [action, true]));
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, field] of Object.entries(value)) visit(field, [...path, key]);
    } else pins[JSON.stringify(path)] = baselineHash(value);
  }
  visit(baseline, []);
  return pins;
}

function changedPins(base, next) {
  return new Map(
    [...new Set([...Object.keys(base), ...Object.keys(next)])]
      .filter(path => base[path] !== next[path])
      .map(path => [path, next[path]]),
  );
}

function recordedMerge(baseline, directory) {
  const merged = baselinePins(baseline);
  const groups = new Map();
  for (const name of readdirSync(directory)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const entry = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    if (!hasReason(entry) || !entry.base || !entry.basePins || !entry.pins) continue;
    const key = `${entry.base}:${baselineHash(entry.basePins)}`;
    if (!groups.has(key)) groups.set(key, { base: entry.basePins, branches: [] });
    groups.get(key).branches.push(entry.pins);
  }
  for (const { base, branches } of groups.values()) {
    if (branches.length < 2) continue;
    const combined = changedPins(base, merged);
    if (combined.size < 2) continue;
    const uncovered = new Set(combined.keys());
    for (const branch of branches) {
      const edits = changedPins(base, branch);
      if (edits.size >= combined.size) continue;
      if ([...edits].every(([path, hash]) => combined.has(path) && combined.get(path) === hash))
        for (const path of edits.keys()) uncovered.delete(path);
    }
    if (!uncovered.size) return true;
  }
  return false;
}

export function recordWeightEvidence(root, baseline, reason, base) {
  const issue = /\b[0-9a-f]{8}\b/.exec(reason)?.[0];
  if (!hasReason({ issue, reason })) throw new Error(reasonRequired);
  const directory = ledgerPath(root);
  mkdirSync(directory, { recursive: true });
  const name = `${baselineHash(baseline)}.json`;
  // Validate the actual parent while we have its full bytes. Keep its pins so a
  // previously merged baseline can be a parent without needing its own ledger file.
  if (base !== undefined) assertWeightEvidence(base, directory);
  const parent = base === undefined ? {} : { base: baselineHash(base), basePins: baselinePins(base) };
  writeFileSync(
    join(directory, name),
    `${JSON.stringify({ issue, reason, pins: baselinePins(baseline), ...parent }, null, 2)}\n`,
  );
  return name;
}

export const readWeightInput = root =>
  JSON.parse(readFileSync(join(root, 'tests/agent-weight-baseline.json'), 'utf8'));
function assertWeightEvidence(baseline, directory) {
  try {
    const reason = JSON.parse(readFileSync(join(directory, `${baselineHash(baseline)}.json`), 'utf8'));
    if (!hasReason(reason)) throw new Error(reasonRequired);
  } catch (error) {
    // A clean composition can have a hash no individual writer saw. Accept only a union of
    // complete recorded changes to one recorded base. Missing/partial edits still fail.
    if (error.code !== 'ENOENT' || !recordedMerge(baseline, directory)) throw error;
  }
}
export function readWeightBaseline(root) {
  const baseline = readWeightInput(root);
  assertWeightEvidence(baseline, ledgerPath(root));
  return baseline;
}
export function weightFindings(actual, baseline) {
  const findings = [];
  for (const [name, limit] of Object.entries(baseline.ceilings)) {
    const value = actual[name];
    if (!Number.isFinite(limit) || limit < 0 || !Number.isFinite(value) || value < 0 || value > limit)
      findings.push(
        `${name}: ${value ?? 'missing'}, ceiling ${limit}; remove the added weight or record measurements and a reviewed reason on the Issue.`,
      );
  }
  return findings;
}

export function assertCommandWeight(name, actual) {
  const root = new URL('..', import.meta.url);
  const baseline = readWeightBaseline(fileURLToPath(root));
  if (!baseline.commands[name]) throw new Error(`No recorded command weight for ${name}`);
  const findings = weightFindings(actual, { ceilings: baseline.commands[name] });
  if (findings.length) throw new Error(`${name}: ${findings.join('\n')}`);
}

/** A changed agent surface must carry a measurement assessment in the reviewed baseline. */
export function agentSurfaceFindings(report, baseline) {
  const findings = [];
  for (const key of ['boundary', 'agentActions'])
    if (JSON.stringify(report[key]) !== JSON.stringify(baseline[key]))
      findings.push(
        `${key} changed: assess startup, installation and command calls/DB reads, add its synthetic fixture, and record a reviewed baseline reason.`,
      );
  return findings;
}
