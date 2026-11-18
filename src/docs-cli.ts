// SPDX-License-Identifier: Apache-2.0
import { allHelpTopics, hostedAgentHelp, hostedAgentHelpMarkdown } from './hosted-agent-help.js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleDocument, isDocumentFragment } from './doc-fragments.js';
import { invariant } from './errors.js';

const packageRoot = new URL('../', import.meta.url);
function documents(directory = 'docs'): string[] {
  return readdirSync(new URL(`${directory}/`, packageRoot), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return documents(path);
    return entry.isFile() && entry.name.endsWith('.md') && !isDocumentFragment(path) ? [path] : [];
  });
}
/** Prints only named files from the installed documentation inventory; no project required. */
export function docsCli(args: string[]): undefined {
  invariant(args.length <= 1, 'BAD_ARGUMENT', 'Use nforge docs [name].');
  if (args[0] === 'agents/hosted') {
    process.stdout.write(`${hostedAgentHelp()}\n${allHelpTopics()}\n${hostedAgentHelpMarkdown()}\n`);
    return;
  }
  const paths = ['README.md', 'skills/forge-agent/SKILL.md', ...documents()].sort();
  const aliases: Record<string, string> = {
    agent: 'skills/forge-agent/SKILL.md',
    quickstart: 'docs/quickstart.md',
  };
  const name = args[0];
  if (!name || name === '--help' || name === 'help') {
    process.stdout.write(
      `nforge docs [name] — print packaged documentation (offline).\nStart: nforge docs quickstart\nAgent skill: nforge docs agent\nHosted contract: nforge docs agents/hosted\n\n${paths.join('\n')}\n`,
    );
    return;
  }
  const selected = aliases[name] ?? paths.find(path => path === name || path === `docs/${name}.md`);
  invariant(
    selected && paths.includes(selected),
    'BAD_ARGUMENT',
    'Unknown packaged document. Run nforge docs to list names.',
  );
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, packageRoot)), 'utf8');
  const list = (directory: string) => {
    try {
      return readdirSync(new URL(`${directory}/`, packageRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  process.stdout.write(assembleDocument(selected, read(selected), { list, read }));
  return;
}
