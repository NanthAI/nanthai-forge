// SPDX-License-Identifier: Apache-2.0
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const findings = [];
  for (const [path, modules] of Object.entries(report.moduleInventory ?? {})) {
    const reference = baseline.report?.moduleInventory?.[path];
    const added = reference ? modules.filter(name => !reference.includes(name)) : modules;
    if (added.length)
      findings.push(
        `${path}: ${reference ? 'added' : 'loaded (reference inventory unavailable)'} modules/chunks: ${added.join(', ')}`,
      );
  }
  return findings;
}
