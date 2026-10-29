// SPDX-License-Identifier: Apache-2.0
import { scanSourcePaths } from './source-paths.js';
import type { IgnoreMatch, IgnoreSource } from './source-ignore.js';

type IgnoredPath = {
  path: string;
  source: IgnoreSource | 'builtin';
  rule: string;
  file?: string;
  line?: number;
};
export type IgnoredStatus = {
  counts: Record<IgnoreSource | 'builtin', number>;
  scope: 'local-paths-pruned-directories';
  paths?: IgnoredPath[];
};
/** Local filesystem only. No source content, Work mutation or hosted request. */
export function readIgnoredStatus(root: string, detail = false, retained: string[] = []): IgnoredStatus {
  const counts = { '.gitignore': 0, '.forgeignore': 0, builtin: 0 },
    paths: IgnoredPath[] = [];
  scanSourcePaths(root, {
    retained,
    capture: false,
    onExcluded: item => {
      const match: IgnoreMatch | undefined = item.ignore;
      const source = match?.source ?? 'builtin';
      counts[source]++;
      if (detail) paths.push({ path: item.path, ...(match ?? { source, rule: item.reason }) });
    },
  });
  return { counts, scope: 'local-paths-pruned-directories', ...(detail ? { paths } : {}) };
}
export function formatIgnoredStatus(value: IgnoredStatus) {
  const c = value.counts;
  return [
    `Ignored: ${c['.gitignore']} .gitignore · ${c['.forgeignore']} .forgeignore · ${c.builtin} built-in`,
    ...(value.paths ?? []).map(
      item =>
        `  ${JSON.stringify(item.path)} · ${item.file ? `${JSON.stringify(item.file)}:${item.line}` : 'built-in'} · ${JSON.stringify(item.rule)}`,
    ),
  ];
}
