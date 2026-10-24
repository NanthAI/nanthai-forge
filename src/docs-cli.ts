// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { invariant } from './errors.js';

const packageRoot = new URL('../', import.meta.url);
function documents(directory = 'docs'): string[] {
  return readdirSync(new URL(`${directory}/`, packageRoot), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? documents(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}
/** Prints only named files from the installed documentation inventory; no project required. */
export function docsCli(args: string[]): undefined {
  invariant(args.length <= 1, 'BAD_ARGUMENT', 'Use nforge docs [name].');
  const paths = ['README.md', 'skills/forge-agent/SKILL.md', ...documents()].sort();
  const aliases: Record<string, string> = {
    agent: 'skills/forge-agent/SKILL.md',
    quickstart: 'docs/quickstart.md',
  };
  const name = args[0];
  if (!name || name === '--help' || name === 'help') {
    process.stdout.write(
      `nforge docs [name] — print packaged documentation (offline).\nStart: nforge docs quickstart\nAgent skill: nforge docs agent\n\n${paths.join('\n')}\n`,
    );
    return;
  }
  const selected = aliases[name] ?? paths.find(path => path === name || path === `docs/${name}.md`);
  invariant(
    selected && paths.includes(selected),
    'BAD_ARGUMENT',
    'Unknown packaged document. Run nforge docs to list names.',
  );
  process.stdout.write(readFileSync(fileURLToPath(new URL(selected, packageRoot)), 'utf8'));
  return;
}
