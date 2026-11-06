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

export const OXC_USAGE = `Usage: node scripts/oxc.mjs lint | format | format:check
  lint          oxlint over src, web/src, convex and netlify/functions (--deny-warnings)
  format        rewrite every formatted source file in the tree with oxfmt (writes files)
  format:check  report files oxfmt would change; writes nothing
  --help, -h    print this help and exit 0
Any other argument prints this usage to stderr and exits 2 before reading or writing any file.
`;

/** Parses argv after the script name: never touches a file, so --help and bad flags are safe. */
export function parseOxcArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (args.length !== 1 || !['lint', 'format', 'format:check'].includes(args[0]))
    return { error: args.length ? `Unexpected argument: ${args.join(' ')}` : 'Missing subcommand.' };
  return { mode: args[0] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseOxcArgs(process.argv.slice(2));
  if (parsed.help) process.stdout.write(OXC_USAGE);
  else if (parsed.error) {
    process.stderr.write(`${parsed.error}\n${OXC_USAGE}`);
    process.exitCode = 2;
  } else process.exitCode = runOxc(parsed.mode);
}
