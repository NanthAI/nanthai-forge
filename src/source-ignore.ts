// SPDX-License-Identifier: Apache-2.0
import ignore from 'ignore';
import { join } from 'node:path';
import { readSource } from './files.js';

export const ignoreNames = ['.gitignore', '.forgeignore'] as const;
export type IgnoreSource = (typeof ignoreNames)[number];
export type IgnoreMatch = { source: IgnoreSource; rule: string; file: string; line: number };
type Layer = { directory: string; matcher: ReturnType<typeof ignore>; forge?: ReturnType<typeof ignore> };

/** Each directory layers Forge rules after Git rules. Call only for traversed,
 * real directories: an ignored parent cannot be re-included by a child rule. */
export function ignoreLayer(directory: string, read: (name: IgnoreSource) => string | undefined): Layer[] {
  const matcher = ignore();
  const rules: { pattern: string; mark: string }[] = [];
  let present = false;
  let forge: ReturnType<typeof ignore> | undefined;
  for (const name of ignoreNames) {
    const text = read(name);
    if (text === undefined) continue;
    present = true;
    if (name === '.forgeignore') forge = ignore();
    text.split(/\r?\n/).forEach((pattern, index) => {
      if (!pattern || pattern.startsWith('#')) return;
      const marked = {
        pattern,
        mark: JSON.stringify({
          source: name,
          file: directory ? `${directory}/${name}` : name,
          line: index + 1,
        }),
      };
      // Adjacent identical patterns have the same effect; keep the later
      // attribution without paying twice when both ignore files share rules.
      if (rules.at(-1)?.pattern === pattern) rules[rules.length - 1] = marked;
      else rules.push(marked);
      if (name === '.forgeignore') forge!.add(marked);
    });
  }
  for (const rule of rules) matcher.add(rule);
  return present ? [{ directory, matcher, ...(forge ? { forge } : {}) }] : [];
}
export function readIgnoreLayer(root: string, directory: string, names: string[]) {
  return ignoreLayer(directory, name =>
    names.includes(name) ? readSource(root, join(directory, name), 1024 * 1024)?.toString('utf8') : undefined,
  );
}
export function ignoredBy(layers: Layer[], path: string, directory = false): IgnoreMatch | undefined {
  let match: IgnoreMatch | undefined;
  for (const layer of layers) {
    const local = layer.directory ? path.slice(layer.directory.length + 1) : path;
    const candidate = local + (directory ? '/' : '');
    const result = layer.matcher.test(candidate);
    if (result.ignored) {
      // ignore.test can retain the first positive rule until a negation.
      // Resolve Forge attribution only for excluded paths, avoiding a second
      // matcher/cache entry for every included file in the tree.
      let rule = result.rule!;
      let marked = JSON.parse(rule.mark!) as Omit<IgnoreMatch, 'rule'>;
      if (marked.source !== '.forgeignore') {
        const forge = layer.forge?.test(candidate);
        if (forge?.ignored) {
          rule = forge.rule!;
          marked = JSON.parse(rule.mark!) as Omit<IgnoreMatch, 'rule'>;
        }
      }
      match = { ...marked, rule: rule.pattern };
    }
    if (result.unignored) match = undefined;
  }
  return match;
}
