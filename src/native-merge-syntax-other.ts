// SPDX-License-Identifier: Apache-2.0
import type { Parser, SyntaxNode, Tree } from '@lezer/common';

/** The merge syntax gate beyond JS/TS. Python, Java and Rust use the Lezer
 * parsers already in the dependencies; JSON uses `JSON.parse`. Source only:
 * nothing in the project is imported or run. Lezer recovers from errors, so a
 * problem is the first error node; Python also checks that statements of one
 * block share one indentation, which Lezer's recovery accepts silently. */
export type OtherSyntaxProblem = { offset: number; message: string };
type Language = 'python' | 'java' | 'rust' | 'json';

const LANGUAGES: [RegExp, Language][] = [
  [/\.pyi?$/, 'python'],
  [/\.java$/, 'java'],
  [/\.rs$/, 'rust'],
  [/\.json$/, 'json'],
];
export function otherSyntaxLanguage(path: string): Language | undefined {
  return LANGUAGES.find(([pattern]) => pattern.test(path))?.[1];
}

const loaded = new Map<Language, Promise<Parser>>();
/** Each parser loads on first use for its language only. */
const parserFor = (language: Exclude<Language, 'json'>) => {
  let found = loaded.get(language);
  if (!found) {
    found =
      language === 'python'
        ? import('@lezer/python').then(module => module.parser)
        : language === 'java'
          ? import('@lezer/java').then(module => module.parser)
          : import('@lezer/rust').then(module => module.parser);
    loaded.set(language, found);
  }
  return found;
};

function firstError(tree: Tree): number | null {
  let found: number | null = null;
  tree.iterate({
    enter: node => {
      if (found !== null) return false;
      if (node.type.isError) found = node.from;
      return undefined;
    },
  });
  return found;
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
/** The leading whitespace of a node that begins its line, or null when other
 * code precedes it on that line (`a; b`, `if x: y`). */
function leading(text: string, node: SyntaxNode): string | null {
  const before = text.slice(lineStart(text, node.from), node.from);
  return /^[ \t]*$/.test(before) ? before : null;
}
const indentOf = (text: string, offset: number) => /^[ \t]*/.exec(text.slice(lineStart(text, offset)))![0];
const skipped = (node: SyntaxNode) => node.name === ':' || node.name === 'Comment';

/** Python rejects a statement whose indentation matches no open block
 * ("unindent does not match", "unexpected indent"); Lezer files it under the
 * nearest block instead. Statements that begin a line in one block share the
 * exact same indentation (mixing tabs and spaces is a TabError in Python 3),
 * deeper than the line that opened the block; module statements start at column 0. */
function pythonIndentProblem(text: string, tree: Tree): OtherSyntaxProblem | null {
  const top = tree.topNode;
  for (let child = top.firstChild; child; child = child.nextSibling)
    if (!skipped(child) && leading(text, child))
      return { offset: child.from, message: 'indentation matches no enclosing block' };
  let found: OtherSyntaxProblem | null = null;
  tree.iterate({
    enter: ref => {
      if (found) return false;
      if (ref.name !== 'Body') return undefined;
      const body = ref.node,
        owner = indentOf(text, body.parent?.from ?? body.from);
      let block: string | null = null;
      for (let child = body.firstChild; child && !found; child = child.nextSibling) {
        if (skipped(child)) continue;
        const indent = leading(text, child);
        if (indent === null) continue;
        if (block === null) {
          if (indent.length <= owner.length || !indent.startsWith(owner))
            found = { offset: child.from, message: 'expected an indented block' };
          block = indent;
        } else if (indent !== block)
          found = {
            offset: child.from,
            message:
              indent.length > block.length ? 'unexpected indent' : 'indentation matches no enclosing block',
          };
      }
      return undefined;
    },
  });
  return found;
}

/** The first problem in a Python, Java, Rust or JSON file, or null when it
 * parses. JSON reports offset 0 when the engine gives no position. */
export async function firstOtherSyntaxProblem(
  path: string,
  text: string,
): Promise<OtherSyntaxProblem | null> {
  const language = otherSyntaxLanguage(path);
  if (!language) return null;
  if (language === 'json') {
    try {
      JSON.parse(text);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error),
        position = /position (\d+)/.exec(message);
      return { offset: position ? Number(position[1]) : 0, message };
    }
  }
  const tree = (await parserFor(language)).parse(text),
    error = firstError(tree);
  if (error !== null) return { offset: error, message: 'syntax error' };
  return language === 'python' ? pythonIndentProblem(text, tree) : null;
}
