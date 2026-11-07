// SPDX-License-Identifier: Apache-2.0
// B1.5d grading attribution (S5): which test cases belong to which task. A task owns the cases
// its upstream PR added or changed in its test files (PR version vs its parent). When several
// tasks change one file, the oracle runs the latest version and each case goes to the last
// task (in merge order) that changed it, so one task's case never fails another task.
// Cases no task owns are the existing suite.
import { execFileSync } from 'node:child_process';

const START = /\b(?:it|test)((?:\.[A-Za-z]+)*)\s*\(/g;

/** Index after the string/template starting at i (quote at i). */
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === q) return j + 1;
  }
  return src.length;
}

/** Index of the paren closing the one at open, skipping strings and comments. */
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') i = skipString(src, i) - 1;
    else if (c === '/' && src[i + 1] === '/')
      i = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (c === '/' && src[i + 1] === '*')
      i = src.indexOf('*/', i + 2) === -1 ? src.length : src.indexOf('*/', i + 2) + 1;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return src.length;
}

/** title -> normalized source of each `it(...)`/`test(...)` (incl. it.effect and friends). */
export function testCases(source) {
  const cases = new Map();
  if (!source) return cases;
  for (const m of source.matchAll(START)) {
    let open = m.index + m[0].length - 1;
    // it.each(table)("title $x", fn): the case call follows the table call.
    if (/\.each$/.test(m[1])) {
      open = closeParen(source, open) + 1;
      while (/\s/.test(source[open] ?? '')) open++;
      if (source[open] !== '(') continue;
    }
    let quoteAt = open + 1;
    while (/\s/.test(source[quoteAt] ?? '')) quoteAt++;
    if (!['"', "'", '`'].includes(source[quoteAt])) continue;
    const title = source.slice(quoteAt + 1, skipString(source, quoteAt) - 1).replace(/\\(.)/g, '$1');
    const body = source.slice(m.index, closeParen(source, open) + 1).replace(/\s+/g, ' ');
    // Duplicate titles in different describe blocks: keep every body.
    cases.set(title, cases.has(title) ? `${cases.get(title)}\n${body}` : body);
  }
  return cases;
}

/** Does a reported case name (describe chain + title) match a source title? `each` titles
 * carry $field / %s placeholders. */
export function titleMatches(fullName, title) {
  const pattern = title
    .split(/(\$[\w.]+|%[sdifjoO#])/)
    .map((part, i) => (i % 2 ? '.+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`(^|\\s)${pattern}$`).test(fullName);
}

/** Titles a version changed against its parent version (added or body changed). */
export function changedTitles(before, after) {
  const prev = testCases(before);
  return [...testCases(after)].filter(([title, body]) => prev.get(title) !== body).map(([title]) => title);
}

/** { files: { path: { title: taskId } }, latest: { path: commit } } for the task set.
 * `show(commit, path)` returns file text or null (injectable for tests). */
export function attribute(tasks, show) {
  const files = {},
    latest = {};
  for (const task of [...tasks].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt)))
    for (const path of task.oracle.testFiles) {
      latest[path] = task.mergeCommit;
      files[path] ??= {};
      for (const title of changedTitles(show(`${task.mergeCommit}^1`, path), show(task.mergeCommit, path)))
        files[path][title] = task.id;
    }
  // Keep only cases present in the version the oracle runs.
  for (const [path, owners] of Object.entries(files)) {
    const present = testCases(show(latest[path], path));
    for (const title of Object.keys(owners)) if (!present.has(title)) delete owners[title];
  }
  return { files, latest };
}

/** git show from the meta repository (blobless clone: blobs come from its promisor remote). */
export const gitShow = meta => (commit, path) => {
  try {
    return execFileSync('git', ['-C', meta, 'show', `${commit}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};
