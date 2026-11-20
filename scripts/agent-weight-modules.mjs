// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { weightFindings } from './agent-weight.mjs';

/** Portable identities: no private install roots, and content-hash churn is not a new chunk. */
export function moduleInventory(urls, root) {
  return [
    ...new Set(
      urls
        .filter(url => url.startsWith('file:'))
        .map(url => {
          const file = fileURLToPath(url);
          const portable = file.replaceAll('\\', '/');
          const modules = portable.lastIndexOf('/node_modules/');
          const name =
            modules < 0
              ? relative(root, file).replaceAll('\\', '/')
              : 'node_modules/' + portable.slice(modules + 14);
          return name.replace(
            /^(dist\/|node_modules\/@nanthai\/forge\/dist\/)((?:cli-bundle|agent-edit-hook)-.+)-[A-Za-z0-9_-]{8}\.js$/,
            '$1$2-HASH.js',
          );
        }),
    ),
  ].sort();
}

export function moduleFindings(report, baseline) {
  const added = new Map(),
    unknown = [];
  for (const [path, modules] of Object.entries(report.moduleInventory ?? {})) {
    const reference = baseline.report?.moduleInventory?.[path];
    if (!reference) {
      if (modules.length)
        unknown.push(
          `${path}: loaded (reference inventory unavailable) modules/chunks: ${modules.join(', ')}`,
        );
      continue;
    }
    for (const name of modules)
      if (!reference.includes(name)) added.set(name, [...(added.get(name) ?? []), path]);
  }
  // Each added module is named once, with every command that loads it, so a receipt excerpt keeps the whole
  // list even when one new import reaches all of them (ad80e037).
  const byPaths = new Map();
  for (const [name, paths] of added)
    byPaths.set(paths.join(', '), [...(byPaths.get(paths.join(', ')) ?? []), name]);
  return [
    ...[...byPaths].map(([paths, names]) => `${paths}: added modules/chunks: ${names.join(', ')}`),
    ...unknown,
  ];
}

/** Samples from the same startup preload in package smoke and the preflight probes. */
export function startupSample({ stderr, stdout }, modulesFile) {
  const line = /FORGE_STARTUP (\{.*\})/.exec(stderr ?? '')?.[1];
  if (!line) throw new Error('Startup fixture returned incomplete evidence.');
  const sample = JSON.parse(line);
  if (sample.code !== 0) throw new Error('Startup probe failed.');
  return { ...sample, moduleUrls: JSON.parse(readFileSync(modulesFile, 'utf8')), stdout };
}

/** Package ceilings whose verdict depends on counts or bytes. A local probe may have partial evidence. */
export function agentCeilingFindings(actual, baseline, { partial = false } = {}) {
  const ceilings = Object.fromEntries(
    Object.entries(baseline.ceilings).filter(
      ([name]) => !name.endsWith('Ms') && (!partial || name in actual),
    ),
  );
  return weightFindings(actual, { ceilings });
}
