// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { allHelpTopics, hostedAgentHelp, hostedAgentHelpMarkdown } from './hosted-agent-help.js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assembleDocument, documentHeadingId, isDocumentFragment } from './doc-fragments.js';
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
      `nforge docs [name] — print packaged documentation (offline).\nStart: nforge docs quickstart\nSetup: nforge docs guides/set-up-your-project (append #section to read one section)\nAgent skill: nforge docs agent\nHosted contract: nforge docs agents/hosted\n\n${paths.join('\n')}\n`,
    );
    return;
  }
  const [document, section] = name.split('#', 2);
  const selected =
    aliases[document!] ?? paths.find(path => path === document || path === `docs/${document}.md`);
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
  const source = assembleDocument(selected, read(selected), { list, read });
  if (section === undefined) {
    process.stdout.write(source);
    return;
  }
  const headings = [...source.matchAll(/^```[^\n]*\n[\s\S]*?^```[^\n]*|^(#{1,6}) (.+)$/gm)].filter(
    match => match[1],
  );
  const counts = new Map<string, number>();
  const start = headings.findIndex(heading => {
    const id = documentHeadingId(heading[2]!.replace(/[`*]/g, ''));
    const count = counts.get(id) ?? 0;
    counts.set(id, count + 1);
    return (count ? `${id}-${count}` : id) === section;
  });
  invariant(
    start >= 0,
    'BAD_ARGUMENT',
    'Unknown documentation section. Read the whole document for its headings.',
  );
  const heading = headings[start]!;
  const end = headings.slice(start + 1).find(next => next[1]!.length <= heading[1]!.length);
  process.stdout.write(source.slice(heading.index, end?.index).trimEnd() + '\n');
  return;
}
