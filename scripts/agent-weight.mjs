// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
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
export function readWeightBaseline(root) {
  const baseline = JSON.parse(readFileSync(join(root, 'tests/agent-weight-baseline.json'), 'utf8'));
  const reason = JSON.parse(
    readFileSync(join(root, 'tests/agent-weight-ledger', `${baselineHash(baseline)}.json`), 'utf8'),
  );
  if (
    !/\b[0-9a-f]{8}\b/.test(reason.issue) ||
    typeof reason.reason !== 'string' ||
    reason.reason.trim().length < 20
  )
    throw new Error(
      'Agent weight baseline needs a hashed reason and Issue; review the new measurements before landing.',
    );
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
