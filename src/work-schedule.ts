// SPDX-License-Identifier: Apache-2.0
/** A suggested schedule for open Issues (Issue aa9fb5b1, part 3): which can run in parallel and which
 * should stack, from the repository files each Issue names. Advice only: nothing here starts, orders
 * or blocks work, and an Issue that names no file is reported as unknown, never as independent (a
 * missing name does not prove independence). Pure and runtime-neutral, so the agent planning read and
 * the web board give the same answer from the same headers, with no extra read. */

/** Files kept per Issue; the rest of a long list adds little to the grouping. */
export const NAMED_PATHS_MAX = 16;
// A repository path, for any language: one or more folders, a slash and a file name with an
// extension, or a root file written in backticks (`forge.json`). Prose such as "Node.js" is not a
// path, and URLs never match: a token starts after whitespace, a quote or a bracket.
const FILE = '[\\w@-][\\w.@-]*\\.[A-Za-z][A-Za-z0-9]{0,7}';
const PATH = new RegExp(
  `(?:^|[\\s\`'"(\\[])((?:\\./)?(?:[\\w.@-]+/)+${FILE})(?=$|[\\s\`'"),.:;!?\\]])|\`(${FILE})\``,
  'g',
);

/** Repository paths named in an Issue's title and body, in first-mention order, deduplicated. */
export function namedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH)) {
    const path = (match[1] ?? match[2]!).replace(/^\.\//, '');
    if (path.startsWith('.') && !path.startsWith('.github/')) continue;
    found.add(path);
    if (found.size === NAMED_PATHS_MAX) break;
  }
  return [...found];
}

/** `{paths}` for a stored header when the text names any file; nothing otherwise. */
export function namedPathsField(text: string): { paths?: string[] } {
  const paths = namedPaths(text);
  return paths.length ? { paths } : {};
}
/** The files an Issue names: the header's stored list (a long body), else its title and body. */
export const issuePaths = (item: { title: string; body?: string; paths?: unknown }) =>
  Array.isArray(item.paths) && item.paths.every(path => typeof path === 'string')
    ? (item.paths as string[]).slice(0, NAMED_PATHS_MAX)
    : namedPaths(`${item.title}\n${item.body ?? ''}`);

export type ScheduleIssue = {
  id: string;
  title: string;
  /** open or in-progress; other statuses are left out. */
  status: string;
  at?: string;
  /** Files the Issue names (namedPaths of its title and body). */
  paths: readonly string[];
};
export type ScheduleStack = {
  /** Run in this order: started Issues first, then the oldest. */
  order: string[];
  /** Files at least two of them name (at most 5 shown, `more` past them). */
  files: string[];
  more: number;
  reason: string;
};
export type Schedule = {
  /** Issues that name files no other open Issue names: they can run at the same time. */
  parallel: string[];
  stacks: ScheduleStack[];
  /** Issues that name no file Forge can compare; start them knowing that. */
  unknown: string[];
};

/** How the suggestion was made, shown with it so nobody reads it as a proof. */
export const SCHEDULE_RULE =
  'Advice from the files each Issue names (Markdown docs excepted: landing merges them); an Issue that names none is unknown, not independent. Nothing is started or blocked.';
const started = (issue: ScheduleIssue) => issue.status === 'in-progress';

/** Groups open Issues by the files they name. `merges(path)` is true for a file landing merges by
 * itself (Markdown docs, a forge.json merge list); those never make Issues stack. */
export function suggestSchedule(
  issues: readonly ScheduleIssue[],
  merges: (path: string) => boolean = () => false,
): Schedule {
  const open = issues.filter(issue => issue.status === 'open' || started(issue));
  const byFile = new Map<string, ScheduleIssue[]>();
  for (const issue of open)
    for (const path of new Set(issue.paths))
      if (!merges(path)) byFile.set(path, [...(byFile.get(path) ?? []), issue]);
  // Union-find over Issues that name a shared file.
  const parent = new Map(open.map(issue => [issue.id, issue.id]));
  const root = (id: string): string => {
    const next = parent.get(id)!;
    if (next === id) return id;
    const top = root(next);
    parent.set(id, top);
    return top;
  };
  for (const group of byFile.values())
    for (const issue of group.slice(1)) parent.set(root(issue.id), root(group[0]!.id));
  const components = new Map<string, ScheduleIssue[]>();
  for (const issue of open)
    components.set(root(issue.id), [...(components.get(root(issue.id)) ?? []), issue]);
  const schedule: Schedule = { parallel: [], stacks: [], unknown: [] };
  const counted = (issue: ScheduleIssue) => issue.paths.some(path => !merges(path));
  for (const members of components.values()) {
    if (members.length === 1) {
      const [only] = members;
      (counted(only!) ? schedule.parallel : schedule.unknown).push(only!.id);
      continue;
    }
    const ids = new Set(members.map(issue => issue.id));
    const shared = [...byFile]
      .filter(([, group]) => group.length > 1 && group.every(issue => ids.has(issue.id)))
      .map(([path]) => path)
      .sort();
    const order = [...members]
      .sort(
        (a, b) =>
          Number(started(b)) - Number(started(a)) ||
          (a.at ?? '').localeCompare(b.at ?? '') ||
          a.id.localeCompare(b.id),
      )
      .map(issue => issue.id);
    const files = shared.slice(0, 5);
    schedule.stacks.push({
      order,
      files,
      more: shared.length - files.length,
      reason: `${members.length === 2 ? 'Both' : `${members.length} Issues`} name ${files.join(', ')}${shared.length > files.length ? ` and ${shared.length - files.length} more` : ''}; run them one after another so the later one starts from the earlier one's landing.`,
    });
  }
  schedule.stacks.sort((a, b) => b.order.length - a.order.length || a.order[0]!.localeCompare(b.order[0]!));
  return schedule;
}
