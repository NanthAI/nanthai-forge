// SPDX-License-Identifier: Apache-2.0
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight';
export type SourceToken = { text: string; className: string };
export const plainLines = (text: string): SourceToken[][] =>
  text.split('\n').map(text => [{ text, className: '' }]);
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'k' },
  { tag: [tags.string, tags.regexp], class: 's' },
  { tag: [tags.number, tags.bool, tags.null], class: 'n' },
  { tag: tags.comment, class: 'c' },
  { tag: [tags.typeName, tags.namespace], class: 't' },
  { tag: [tags.variableName, tags.propertyName, tags.function(tags.variableName)], class: 'f' },
  { tag: [tags.punctuation, tags.operator], class: 'p' },
]);
/** Called in the highlight worker. Grammars load only for the requested language. */
export async function highlightSource(file: string, text: string): Promise<SourceToken[][]> {
  if (text.length > 1_000_000) return plainLines(text);
  const extension = file.split('.').at(-1)?.toLowerCase();
  const parser =
    extension && ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(extension)
      ? (await import('@lezer/javascript')).parser.configure({
          dialect:
            `${['ts', 'tsx', 'mts', 'cts'].includes(extension) ? 'ts' : ''} ${['jsx', 'tsx'].includes(extension) ? 'jsx' : ''}`.trim(),
        })
      : extension === 'py'
        ? (await import('@lezer/python')).parser
        : extension === 'java'
          ? (await import('@lezer/java')).parser
          : extension === 'rs'
            ? (await import('@lezer/rust')).parser
            : null;
  if (!parser) return plainLines(text);
  const lines: SourceToken[][] = [[]];
  highlightCode(
    text,
    parser.parse(text),
    highlighter,
    (text, className) => lines.at(-1)!.push({ text, className }),
    () => lines.push([]),
  );
  return lines;
}
