// SPDX-License-Identifier: Apache-2.0
// Which GitHub Actions workflows a project already has, and whether each can decide a landing (Item 0c9207b8). Pure:
// it reads the first page of each workflow file's text, which the Code place's bounded source read returns, and never
// runs or evaluates anything in it. It looks only at the `on:` key; a file it cannot read plainly is shown as "could
// not tell", never as passing or failing. Forge's candidate branches are `forge/candidates/…` (src/ci-status.ts).

export const WORKFLOW_DIR = '.github/workflows';
/** At most this many workflow files are opened to read their triggers; more are listed by name only. */
export const WORKFLOWS_READ = 6;
const CANDIDATES = 'forge/candidates/**';

export type Trigger =
  /** Runs on a push to a branch: with one trigger line it checks Forge's branches. */
  | { kind: 'push'; covers: boolean; change: TriggerChange | null; paths: boolean }
  | { kind: 'tags' | 'pull_request' | 'schedule' | 'manual' | 'other' | 'unknown' };

/** The one line that makes a push trigger cover Forge's branches: line `line` as it reads now (`before`) becomes
 * `after`; with `before` null, `after` is a new line added below line `line`. */
export type TriggerChange = { line: number; before: string | null; after: string };

const isWorkflow = (path: string) =>
  path.startsWith(`${WORKFLOW_DIR}/`) &&
  !path.slice(WORKFLOW_DIR.length + 1).includes('/') &&
  /\.ya?ml$/.test(path);
export const workflowPaths = (paths: readonly string[]) => paths.filter(isWorkflow).sort();

const indentOf = (line: string) => line.length - line.trimStart().length;
const meaningful = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#');
const names = (inline: string) =>
  inline
    .replace(/^[[{]|[\]}]$/g, '')
    .split(',')
    .map(part =>
      part
        .split(':')[0]!
        .trim()
        .replace(/^['"]|['"]$/g, ''),
    )
    .filter(Boolean);

/** The `on:` events and, for `push`, its child keys, with each line's number (from 1). */
function onBlock(text: string) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^(on|"on"|'on'|true)\s*:/.test(line));
  if (start < 0) return null;
  const inline = lines[start]!.replace(/^[^:]*:/, '')
    .replace(/\s#.*$/, '')
    .trim();
  if (inline) return { events: new Map(names(inline).map(name => [name, [] as Child[]])), lines };
  const events = new Map<string, Child[]>();
  let eventIndent = -1;
  let current: Child[] | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!meaningful(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    if (eventIndent < 0) eventIndent = indent;
    const key = line
      .trim()
      .split(':')[0]!
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (indent === eventIndent) events.set(key, (current = []));
    else if (current) current.push({ key, indent, line: i + 1, text: line });
  }
  return { events, lines };
}
type Child = { key: string; indent: number; line: number; text: string };

/** The change for a `branches:` list under `push:`, written inline (`[a, b]`) or as `- item` lines; other shapes get
 * the generic trigger. */
function branchChange(children: Child[]): TriggerChange | null {
  const top = Math.min(...children.map(child => child.indent));
  const branches = children.find(child => child.indent === top && child.key === 'branches');
  if (!branches) return null;
  const inline = branches.text.match(/^(\s*branches\s*:\s*\[)(.*)(\]\s*(#.*)?)$/);
  if (inline) {
    const items = inline[2]!.trim() ? `${inline[2]!.trimEnd()}, ` : '';
    return {
      line: branches.line,
      before: branches.text,
      after: `${inline[1]}${items}'${CANDIDATES}'${inline[3]}`,
    };
  }
  const items = children.filter(child => child.line > branches.line && child.indent > top);
  const run: Child[] = [];
  for (const item of items) {
    if (!item.text.trimStart().startsWith('-') || item.line !== (run.at(-1)?.line ?? branches.line) + 1)
      break;
    run.push(item);
  }
  const last = run.at(-1);
  if (!last) return null;
  return { line: last.line, before: null, after: `${' '.repeat(last.indent)}- '${CANDIDATES}'` };
}

/** What one workflow file runs on, from its text. */
export function workflowTrigger(text: string): Trigger {
  const block = onBlock(text);
  if (!block) return { kind: 'unknown' };
  const push = block.events.get('push');
  if (push) {
    const top = push.length ? Math.min(...push.map(child => child.indent)) : 0;
    const keys = new Set(push.filter(child => child.indent === top).map(child => child.key));
    if (keys.has('tags') && !keys.has('branches') && !keys.has('branches-ignore')) return { kind: 'tags' };
    const covers = text.includes('forge/candidates');
    // A paths filter: a landing that touches none of those paths starts no run, so it is never checked.
    const paths = keys.has('paths') || keys.has('paths-ignore');
    // No branch filter at all: every pushed branch runs it already.
    if (!keys.has('branches')) return { kind: 'push', covers: true, change: null, paths };
    return { kind: 'push', covers, change: covers ? null : branchChange(push), paths };
  }
  if (block.events.has('pull_request') || block.events.has('pull_request_target'))
    return { kind: 'pull_request' };
  if (block.events.has('schedule')) return { kind: 'schedule' };
  if (block.events.has('workflow_dispatch')) return { kind: 'manual' };
  return { kind: 'other' };
}

/** Why a workflow cannot decide a landing, in a few words; null when it can. */
export function cannotDecide(trigger: Trigger): string | null {
  switch (trigger.kind) {
    case 'push':
      return null;
    case 'tags':
      return 'Runs on tags only, so it cannot check a landing.';
    case 'pull_request':
      return 'Runs on pull requests only. It needs a push trigger to check a landing.';
    case 'schedule':
      return 'Runs on a schedule only, so it cannot check a landing.';
    case 'manual':
      return 'Runs on request. It needs a push trigger to check a landing through the mirror.';
    case 'other':
      return 'Has no push trigger, so it cannot check a landing.';
    case 'unknown':
      return null;
  }
}

export type FoundWorkflow = { path: string; trigger: Trigger | null };

/** The workflow to preselect: one named ci, else the first that can decide, else none. */
export function preferred(found: readonly FoundWorkflow[]) {
  const decides = found.filter(entry => entry.trigger?.kind === 'push');
  return (
    decides.find(entry => /\/ci\.ya?ml$/.test(entry.path)) ??
    decides[0] ??
    found.find(entry => !entry.trigger || entry.trigger.kind === 'unknown')
  )?.path;
}
