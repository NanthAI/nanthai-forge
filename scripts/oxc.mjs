// SPDX-License-Identifier: Apache-2.0
// Explicit files also work in native Lanes beneath an ignored .forge/ ancestor.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ignore from 'ignore';

export function oxcFiles(root, lint) {
  const config = JSON.parse(readFileSync(join(root, lint ? '.oxlintrc.json' : '.oxfmtrc.json')));
  const ignored = ignore()
    .add(readFileSync(join(root, '.gitignore'), 'utf8'))
    .add(config.ignorePatterns);
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name === '.git' || ignored.ignores(path + (entry.isDirectory() ? '/' : ''))) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) files.push(path);
    }
  }
  for (const directory of lint ? ['src', 'web/src', 'convex', 'netlify/functions'] : ['']) walk(directory);
  return files.sort();
}

export function runOxc(mode) {
  if (!['lint', 'format', 'format:check'].includes(mode))
    throw new Error('Expected lint, format or format:check.');
  const lint = mode === 'lint';
  const files = oxcFiles('.', lint);
  if (!files.length) throw new Error('No source files selected for Oxc.');
  const tool = lint ? 'oxlint' : 'oxfmt';
  const result = spawnSync(
    process.execPath,
    [
      `node_modules/${tool}/bin/${tool}`,
      '--threads',
      '4',
      ...(lint ? ['--deny-warnings'] : [mode === 'format' ? '--write' : '--check']),
      ...files,
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runOxc(process.argv[2]);
