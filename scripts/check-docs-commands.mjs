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
const SETUP_GUIDE = 'docs/guides/set-up-your-project.md';

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
    const [, first, second, third] = words;
    if (first && !placeholder.test(first) && !first.startsWith('-')) {
      if (first === 'agent' || first === 'x') {
        // `nforge agent ROOT ACTION`; ROOT is `.`, a path or a placeholder.
        if (third && /^[a-z][\w-]*$/.test(third) && !known.actions.has(third))
          out.push(`${path}: "${command}" names action ${third}, which does not exist`);
      } else if (/^[a-z][\w-]*$/.test(first) && !known.commands.has(first)) {
        out.push(`${path}: "${command}" names command ${first}, which does not exist`);
      } else if (second && /^[a-z][\w-]*$/.test(second)) {
        const subcommands = known.subcommands?.[first];
        if (subcommands && !subcommands.has(second))
          out.push(`${path}: "${command}" names subcommand ${first} ${second}, which does not exist`);
        if (
          first === 'secret' &&
          second === 'machine' &&
          third &&
          /^[a-z][\w-]*$/.test(third) &&
          known.subcommands?.machine &&
          !known.subcommands.machine.has(third)
        )
          out.push(`${path}: "${command}" names subcommand secret machine ${third}, which does not exist`);
      }
    }
    const ownedFlags = path === SETUP_GUIDE && known.setupFlags?.[first];
    for (const flag of flags)
      if (ownedFlags && !ownedFlags.has(flag))
        out.push(`${path}: "${command}" uses flag ${flag}, which ${first} does not accept`);
      else if (!known.flags.has(flag))
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

// Setup examples need the option on the command they invoke. Ignore prose/usage strings and
// read the exact flag literals from hand-written parsers or the options of parseArgs.
function literalFlags(source) {
  return new Set([...source.matchAll(/['"](--[a-z][a-z0-9-]*)['"]/g)].map(match => match[1]));
}

function optionFlags(source) {
  const options = /parseArgs\(\{[\s\S]*?options: \{([\s\S]*?)\n\s*\},/.exec(source)?.[1] ?? '';
  return new Set(
    [...options.matchAll(/^\s*'?([a-z][a-z0-9-]*)'?: \{ type:/gm)].map(match => `--${match[1]}`),
  );
}

export async function docsCommandsFindings(root) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const reads = read('src/hosted-agent-reads.ts');
  const block = reads.slice(reads.indexOf('export const hostedClientReadSchemas = {'));
  const clientReads = [...block.slice(0, block.indexOf('} as const')).matchAll(/^\s*'?([a-z][\w-]*)'?:/gm)];
  const secretUsage = read('src/sealed-cli.ts').split('export function sealedAgent')[0];
  const githubUsage = /nforge github ([a-z-]+(?:\|[a-z-]+)+) PROJECT/.exec(read('src/github-connect-cli.ts'));
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
    subcommands: {
      auth: new Set([...read('src/auth-cli.ts').matchAll(/nforge auth ([a-z-]+)/g)].map(m => m[1])),
      github: new Set(githubUsage?.[1].split('|')),
      secret: new Set([...secretUsage.matchAll(/nforge secret ([a-z-]+)/g)].map(m => m[1])),
      machine: new Set([...secretUsage.matchAll(/nforge secret machine ([a-z-]+)/g)].map(m => m[1])),
    },
    setupFlags: {
      login: literalFlags(read('src/auth-cli.ts')),
      host: literalFlags(read('src/host-command.ts')),
      import: optionFlags(read('src/github-import-cli.ts')),
      clone: literalFlags(read('src/hosted-clone-cli.ts')),
      github: optionFlags(read('src/github-connect-cli.ts')),
      secret: literalFlags(read('src/sealed-cli.ts')),
      run: literalFlags(read('src/secret-run-cli.ts')),
      x: literalFlags(read('src/agent-cli.ts')),
      agent: literalFlags(read('src/agent-cli.ts')),
    },
  };
  return DOC_ROOTS.flatMap(r => pages(r, root)).flatMap(p => docsCommandFindings(p, read(p), known));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(new URL('..', import.meta.url).pathname);
  const findings = await docsCommandsFindings(root);
  console.log(findings.join('\n') || 'no stale commands');
  if (findings.length) process.exitCode = 1;
}
