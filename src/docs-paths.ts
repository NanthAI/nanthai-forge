// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { globPattern } from './autonomy-policy.js';
import { markdownPath, TESTED_DOCS_MAX, TESTED_DOCS_RULE, type TestedDocs } from './tested-docs.js';

/** Opt-in, per check definition (like GitHub's `paths-ignore`): repository-relative
 * globs of files that no test or build reads. A project without it gets today's safe
 * behaviour: the whole command always runs and every Markdown overlap rechecks. */
export const DOCS_PATHS_MAX = 32;
export const docsPathsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .refine(glob => {
        try {
          globPattern(glob);
          return !glob.startsWith('/') && !glob.split('/').includes('..');
        } catch {
          return false;
        }
      }, 'Select repository-relative globs such as docs/** or **/*.md.'),
  )
  .min(1)
  .max(DOCS_PATHS_MAX);

const compiled = new Map<string, RegExp[]>();
function patterns(globs: readonly string[]): RegExp[] {
  const key = JSON.stringify(globs);
  let found = compiled.get(key);
  if (!found) {
    found = globs.map(globPattern);
    if (compiled.size > 16) compiled.clear();
    compiled.set(key, found);
  }
  return found;
}
export const isDocsPath = (globs: readonly string[], path: string) =>
  patterns(globs).some(pattern => pattern.test(path));
/** Every changed path is a declared docs path. Nothing changed is never docs-only. */
export const docsOnlyChange = (globs: readonly string[] | undefined, paths: readonly string[]) =>
  !!globs?.length && paths.length > 0 && paths.every(path => isDocsPath(globs, path));

/** The pinned tested-docs list for a check that declared docs paths and has no Forge
 * selector: every Markdown file outside the declared docs paths counts as read. Absent
 * (every Markdown is tested) when nothing was declared or the list is over its cap. */
export function declaredTestedDocs(
  globs: readonly string[] | undefined,
  paths: Iterable<string>,
): TestedDocs | undefined {
  if (!globs?.length) return undefined;
  const tested = [...paths].filter(path => markdownPath(path) && !isDocsPath(globs, path)).sort();
  return tested.length > TESTED_DOCS_MAX ? undefined : { rule: TESTED_DOCS_RULE, paths: tested };
}
