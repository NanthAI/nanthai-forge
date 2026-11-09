// SPDX-License-Identifier: Apache-2.0
// Brief lint: `node scripts/check-brief.mjs BRIEF.md` (or `-` for stdin) before delegating work.
// Exit 1 and name each missing field. Output never echoes brief text, which may be private.
// A brief may satisfy a field by pointing at the standard builder block (docs/agents/briefings.md)
// or at a common-rules file it names; local .md files the brief names are read one level deep.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { envPrintFindings } from './check-env-print.mjs';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const POINTER = /briefings\.md#standard-builder-block|standard\s+(?:builder|safety)[^\n]{0,40}\bblock/i;
// Canonical rule files define the fields; naming them never counts as a brief's own rules file.
const CANONICAL = new Set(['briefings.md', 'brief-template.md', 'agents.md', 'claude.md']);
const MAX_RULES_BYTES = 256 * 1024;

const labeled = (text, labels) => {
  const line = new RegExp(`^\\s*(?:[-*]\\s*)?\\**(?:${labels})\\b[^:\\n]*:\\**[ \\t]*(\\S[^\\n]*)$`, 'gim');
  // A value that is only a template placeholder (`<...>`) is unfilled.
  return [...text.matchAll(line)].some(([, value]) => !/^`?<[^>]*>`?\.?$/.test(value.trim()));
};

export const briefFields = [
  {
    name: 'issue-id',
    need: 'the full Issue UUID on an "Issue" line (a short id does not count)',
    ok: ({ brief }) =>
      brief.split('\n').some(line => /\bissue\b|planningItemId/i.test(line) && UUID.test(line)),
  },
  {
    name: 'safety-block',
    need: 'the standard builder block by pointer, or its secret-handling text inline (names `npx convex env list` as forbidden)',
    ok: ({ all }) =>
      POINTER.test(all) ||
      (/never print[^.\n]{0,60}(?:secret|environment value)/i.test(all) && /npx convex env list/.test(all)),
  },
  {
    name: 'scale-budget',
    need: 'a filled `Scale:` line (or `Scale budget:`), or a docs-only statement that runtime usage does not change',
    ok: ({ all }) =>
      labeled(all, 'scale') ||
      /docs-only(?!\s+alternative)[^\n]*(?:\b(?:do(?:es)? not|no)\b[^\n]*change|zero)/i.test(all),
  },
  {
    name: 'disk-floor',
    need: 'a disk reserve with a number, such as "keep disk reserve >= 40 GiB"',
    ok: ({ all }) =>
      /disk[^\n]{0,40}(?:reserve|floor|free)[^\n]{0,40}\d+(?:\.\d+)?\s*(?:GiB|GB|TB)\b/i.test(all) ||
      /\d+(?:\.\d+)?\s*(?:GiB|GB|TB)\b[^\n]{0,30}(?:free|reserve|floor)[^\n]{0,20}disk/i.test(all),
  },
  {
    name: 'checkpoint-cadence',
    need: 'a save/checkpoint cadence ("save about every 30 minutes") or the standard builder block pointer',
    ok: ({ all }) =>
      POINTER.test(all) ||
      /(?:save|checkpoint|handoff)[^\n]{0,80}\bevery\s*(?:~|about\s+)?\d+\s*(?:min|minutes|h|hours)\b/i.test(
        all,
      ),
  },
  {
    name: 'no-end-turn-rule',
    need: 'a rule not to end the turn while a landing or wait runs, or the standard builder block pointer',
    ok: ({ all }) =>
      POINTER.test(all) ||
      /\b(?:never|do not|don't)\s+end\s+(?:your|the)\s+turn\b/i.test(all) ||
      /\bstay\s+with\s+(?:your|own|the)\b[^\n]{0,40}\blanding/i.test(all) ||
      /\bkeep\s+(?:the|your)\s+turn\s+active\b/i.test(all),
  },
];

// Local rules files the brief names (relative to the brief, then the working directory).
export function rulesFiles(brief, briefDir = '.') {
  const found = new Set();
  for (const [token] of brief.matchAll(/[\w@~./\\-]+\.md\b/g)) {
    if (CANONICAL.has(basename(token).toLowerCase()) || token.startsWith('~')) continue;
    for (const candidate of isAbsolute(token) ? [token] : [resolve(briefDir, token), resolve(token)]) {
      if (
        existsSync(candidate) &&
        statSync(candidate).isFile() &&
        statSync(candidate).size <= MAX_RULES_BYTES
      ) {
        found.add(candidate);
        break;
      }
    }
  }
  return [...found];
}

// Hazards are instructions a brief must not give; they fail like a missing field.
export const briefHazards = [
  {
    name: 'unsafe-command',
    need: 'an instruction to run a command that prints environment values or process listings (env, printenv, npx convex env list, pgrep -fl, ps -E); say "never run" or use a name-only helper',
    // The brief and its common-rules text are both instructions to the agent.
    ok: ({ all }) => !envPrintFindings('brief.md', all).length,
  },
];

/** Names of required fields the brief lacks; `rules` is extra text from common-rules files. */
export function briefFindings(brief, rules = '') {
  const context = { brief, all: `${brief}\n${rules}` };
  return [...briefFields, ...briefHazards].filter(field => !field.ok(context)).map(field => field.name);
}

export function lintBrief(brief, briefDir = '.') {
  const rules = rulesFiles(brief, briefDir).map(path => readFileSync(path, 'utf8'));
  return briefFindings(brief, rules.join('\n'));
}

/** The brief's Issue UUID: the first UUID on an "Issue" (or planningItemId) line, as the issue-id field reads it. */
export function briefIssueId(brief) {
  for (const line of brief.split('\n'))
    if (/\bissue\b|planningItemId/i.test(line)) {
      const found = line.match(UUID);
      if (found) return found[0].toLowerCase();
    }
  return undefined;
}

/** Reads one planning item by its first 8 characters with `nforge agent . planning` (one read, no
 * reconcile). Throws an error with code NOT_FOUND when the board has no such item, UNAVAILABLE for
 * anything else (no login, no checkout, unreachable board, missing CLI). */
export function cliBoardReader(prefix) {
  const unavailable = reason => Object.assign(new Error(reason), { code: 'UNAVAILABLE' });
  const run = spawnSync(
    'nforge',
    ['agent', '.', 'planning', JSON.stringify({ id: prefix, reconcile: false })],
    {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (run.error) throw unavailable('nforge could not run');
  try {
    if (run.status === 0) {
      const id = JSON.parse(run.stdout)?.result?.item?.id;
      if (typeof id === 'string') return { id };
      throw unavailable('the board returned no item');
    }
    const code = JSON.parse(run.stderr.trim().split('\n').pop())?.error?.code;
    if (code === 'NOT_FOUND') throw Object.assign(new Error('not found'), { code });
  } catch (error) {
    if (error?.code) throw error;
  }
  throw unavailable('the planning board could not be read');
}

/** Resolve the brief's Issue against the planning board with one read of its first 8 characters.
 * `unknown`: no such item. `mismatch`: an item starts with those 8 characters but its full id differs
 * (a typo in the rest of the UUID). `unchecked`: no login or the board is unreachable; offline lint
 * still works, so this warns instead of failing. */
export async function resolveBriefIssue(brief, reader = cliBoardReader) {
  const id = briefIssueId(brief);
  if (!id) return { status: 'skipped' };
  const short = id.slice(0, 8);
  try {
    const item = await reader(short);
    return item?.id?.toLowerCase() === id
      ? { status: 'ok', short }
      : { status: 'mismatch', short, found: String(item?.id ?? '').slice(0, 8) };
  } catch (error) {
    return error?.code === 'NOT_FOUND'
      ? { status: 'unknown', short }
      : { status: 'unchecked', short, reason: String(error?.message ?? 'unreachable') };
  }
}

export async function checkBriefMain(
  args,
  { reader = cliBoardReader, out = console.log, err = console.error } = {},
) {
  const board = !args.includes('--no-board');
  const rest = args.filter(arg => arg !== '--no-board');
  const path = rest[0];
  if (!path || rest.length > 1) {
    err('usage: node scripts/check-brief.mjs [--no-board] BRIEF.md   (use - to read stdin)');
    return 2;
  }
  let brief;
  try {
    brief = readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch {
    err('check-brief: cannot read the brief');
    return 2;
  }
  const missing = new Set(lintBrief(brief, path === '-' ? '.' : dirname(resolve(path))));
  let failed = missing.size > 0;
  for (const field of briefFields) {
    if (missing.has(field.name)) err(`check-brief: missing ${field.name}: ${field.need}`);
  }
  for (const hazard of briefHazards) {
    if (missing.has(hazard.name)) err(`check-brief: ${hazard.name}: ${hazard.need}`);
  }
  if (board && !missing.has('issue-id')) {
    const issue = await resolveBriefIssue(brief, reader);
    if (issue.status === 'unknown') {
      err(
        `check-brief: unknown-issue: no planning item starts with ${issue.short}; the Issue line names an id that is not on the board.`,
      );
      failed = true;
    } else if (issue.status === 'mismatch') {
      err(
        `check-brief: issue-mismatch: the board item ${issue.short}… has a different full id than the brief's Issue UUID (check the rest of the UUID).`,
      );
      failed = true;
    } else if (issue.status === 'unchecked') {
      err(
        `check-brief: warning: Issue ${issue.short} was not checked against the planning board (${issue.reason}); linted offline only.`,
      );
    }
  }
  if (failed) {
    err('See docs/agents/brief-template.md and docs/agents/briefings.md#standard-builder-block.');
    return 1;
  }
  out('check-brief: ok');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await checkBriefMain(process.argv.slice(2));
