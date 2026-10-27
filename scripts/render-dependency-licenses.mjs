// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function renderDependencyLicenses(lock) {
  const rows = Object.entries(lock.packages)
    .filter(([path]) => path)
    .map(
      ([path, item]) =>
        `| ${path.replaceAll('|', '\\|')} | ${item.version} | ${item.license ?? 'Undeclared'} | ${item.dev ? 'development' : 'runtime'}${item.optional ? ', optional' : ''} |`,
    );
  return `# Pinned npm dependency license inventory\n\nGenerated from package-lock.json with node scripts/render-dependency-licenses.mjs. All ${rows.length} locked dependency instances are listed, including platform-specific optional packages. These are upstream manifest declarations, not a review of every bundled third-party source or trademark permission. Preserve upstream package notices.\n\nThe separately downloaded self-host backend is covered by its pinned [FSL-1.1-Apache-2.0 license](https://github.com/get-convex/convex-backend/blob/precompiled-2026-09-28-5c7cb5b/LICENSE.md), not the npm client license. Its bundled native dependencies are outside this npm inventory; [native license coverage](native-dependency-licenses.md) records the inspected pins and remaining gaps. Forge's own boundaries are in [the licensing map](../LICENSE.md).\n\n| Locked path | Version | Declared license | Use |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  writeFileSync(
    resolve(root, 'docs/dependency-licenses.md'),
    renderDependencyLicenses(JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))),
  );
}
