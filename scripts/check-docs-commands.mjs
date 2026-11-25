// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Docs command guard (Item ca64692f): a documented `nforge` command, agent action or `--flag` must still
// exist. Static: reads Markdown and source text only; runs no project code, no Convex call.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentActionNames, cliCommandNames } from './check-growth.mjs';
import { coreVerbs } from './agent-verb-forms.mjs';

// User-facing pages only; plans, phase records and research describe history or intent, not live commands.
const SKIP_DIRS = new Set([
  'research',
  'stories',
  'design',
  'ux',
  'vendor-notices',
  'marketing',
  'data-placement.d',
]);
const SKIP_FILES =
  /^(?:phase\d|backlog|roadmap|decisions|r2-storage-plan|dependency-licenses|native-dependency-licenses)/;
const DOC_ROOTS = ['README.md', 'docs', 'skills'];

function pages(path, root) {
  const full = resolve(root, path);
  if (!existsSync(full)) return [];
  if (path.endsWith('.md')) return [path];
  return readdirSync(full, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : pages(join(path, entry.name), root);
    return entry.name.endsWith('.md') && !SKIP_FILES.test(entry.name) ? [join(path, entry.name)] : [];
  });
}

const placeholder = /^(?:[A-Z_<[{.$~/'"]|\.|-)/;
/** Commands and flags written in code spans or fenced blocks of one page. */
function documentedCommands(text) {
  const spans = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap(m =>
    m[1].replace(/\\\n\s*/g, ' ').split('\n'),
  );
  const inline = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
  return [...spans, ...inline].flatMap(line =>
    [...line.matchAll(/(?:^|[\s;&|(`$])(nforge(?:\s+[^\s;&|)`]+)*)/g)].map(m => m[1]),
  );
}

export function docsCommandFindings(path, text, known) {
  const out = [];
  for (const command of new Set(documentedCommands(text))) {
    const words = command.split(/\s+/);
    const flags = words.filter(w => /^--[a-z][a-z0-9-]*/.test(w)).map(w => /^--[a-z0-9-]+/.exec(w)[0]);
    const [, first, , third] = words;
    if (first && !placeholder.test(first) && !first.startsWith('-')) {
      if (first === 'agent' || first === 'x') {
        // `nforge agent ROOT ACTION`; ROOT is `.`, a path or a placeholder.
        if (third && /^[a-z][\w-]*$/.test(third) && !known.actions.has(third))
          out.push(`${path}: "${command}" names action ${third}, which does not exist`);
      } else if (/^[a-z][\w-]*$/.test(first) && !known.commands.has(first)) {
        out.push(`${path}: "${command}" names command ${first}, which does not exist`);
      }
    }
    for (const flag of flags)
      if (!known.flags.has(flag))
        out.push(`${path}: "${command}" uses flag ${flag}, which no source defines`);
  }
  return out;
}

function sourceText(root) {
  const walk = dir =>
    readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '_generated' ? [] : walk(p);
      return /\.(?:ts|mts|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [p] : [];
    });
  return ['src', 'scripts']
    .flatMap(walk)
    .map(p => readFileSync(resolve(root, p), 'utf8'))
    .join('\n');
}

export async function docsCommandsFindings(root) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const reads = read('src/hosted-agent-reads.ts');
  const block = reads.slice(reads.indexOf('export const hostedClientReadSchemas = {'));
  const clientReads = [...block.slice(0, block.indexOf('} as const')).matchAll(/^\s*'?([a-z][\w-]*)'?:/gm)];
  const known = {
    actions: new Set([
      ...agentActionNames(read('src/agent-verbs.ts'), coreVerbs),
      ...clientReads.map(m => m[1]),
      // Hosted actions (check, finish, withdraw, planning, …) live in the contract's action arrays.
      ...[
        ...read('src/hosted-agent-contract.ts').matchAll(
          /export const hostedAgent\w*Actions = \[([^\]]*)\]/g,
        ),
      ]
        .flatMap(m => [...m[1].matchAll(/'([a-z][\w-]*)'/g)])
        .map(m => m[1]),
      'help',
    ]),
    // Dispatch names plus the usage lines `nforge --help` prints (update, cli, wait live elsewhere).
    commands: new Set([
      ...cliCommandNames(read('src/cli.ts')),
      ...[...read('src/cli.ts').matchAll(/^\s+nforge ([a-z][\w-]*)/gm)].map(m => m[1]),
    ]),
    flags: new Set([...sourceText(root).matchAll(/--[a-z][a-z0-9-]*/g)].map(m => m[0])),
  };
  return DOC_ROOTS.flatMap(r => pages(r, root)).flatMap(p => docsCommandFindings(p, read(p), known));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(new URL('..', import.meta.url).pathname);
  const findings = await docsCommandsFindings(root);
  console.log(findings.join('\n') || 'no stale commands');
  if (findings.length) process.exitCode = 1;
}
