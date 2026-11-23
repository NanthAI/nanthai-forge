// SPDX-License-Identifier: Apache-2.0
// Syntax colours for the code reader and the diffs (Item 8e847a17). The tokenizer is Pierre's @pierre/highlights, the
// engine @pierre/diffs (the highlighter T3 Code's diffs use) draws with: one WebAssembly module with every major
// language, loaded only when a file is first coloured. It runs in the highlight worker, never on the page. The file
// name picks the language with @pierre/diffs's own table; an unknown name stays plain text.
export type SourceToken = { text: string; className: string };

/** The design system's code roles (web/src/ds/review.css). A token of any other kind keeps the text colour. */
export type SyntaxRole = '' | 'kw' | 'str' | 'nu' | 'fn' | 'ty' | 'cm';

/** Above this many characters a file is drawn as plain text (the reader's existing cutoff). */
export const HIGHLIGHT_MAX_CHARACTERS = 1_000_000;
/** A line this long is one plain token, so one minified line cannot become thousands of elements. */
const LINE_MAX_CHARACTERS = 4000;

export const plainLines = (text: string): SourceToken[][] =>
  text.split('\n').map(text => [{ text, className: '' }]);

/** Pierre's token kinds, as the names its CSS-variable theme gives them (`--hls-keyword-import`), to a role. */
export function roleOf(kind: string): SyntaxRole {
  if (kind.startsWith('comment')) return 'cm';
  if (kind.startsWith('string') || kind.startsWith('link')) return 'str';
  if (kind === 'number' || kind === 'boolean' || kind.startsWith('constant')) return 'nu';
  if (
    kind.startsWith('keyword') ||
    kind.startsWith('tag') ||
    kind.startsWith('selector') ||
    kind === 'preproc'
  )
    return 'kw';
  if (kind.startsWith('function') || kind === 'constructor') return 'fn';
  if (
    kind.startsWith('type') ||
    kind.startsWith('property') ||
    kind.startsWith('attribute') ||
    kind === 'namespace' ||
    kind === 'enum' ||
    kind === 'title'
  )
    return 'ty';
  return '';
}

const variable = /^var\(--hls-([\w-]+)\)$/;
const theme = { name: 'forge', appearance: 'dark', style: {}, cssVariables: true } as const;

/** Called in the highlight worker. The grammar module loads on first use. */
export async function highlightSource(file: string, text: string): Promise<SourceToken[][]> {
  if (text.length > HIGHLIGHT_MAX_CHARACTERS) return plainLines(text);
  const { getFiletypeFromFileName } = await import('@pierre/diffs');
  // An extension that is itself a language name works too: a fenced block in Markdown is asked for as `fence.<lang>`.
  const named = getFiletypeFromFileName(file);
  const lang = named === 'text' && file.includes('.') ? file.split('.').at(-1)!.toLowerCase() : named;
  if (lang === 'text' || lang === 'txt' || lang === 'plain' || lang === 'plaintext') return plainLines(text);
  const { codeToTokens, isSupportedLanguage } = await import('@pierre/highlights');
  if (!isSupportedLanguage(lang)) return plainLines(text);
  const result = codeToTokens(text, { lang, theme, tokenizeMaxLineLength: LINE_MAX_CHARACTERS });
  return result.tokens.map(line => {
    const merged: SourceToken[] = [];
    for (const token of line) {
      const className = roleOf(variable.exec(token.color ?? '')?.[1] ?? '');
      const last = merged.at(-1);
      if (last && last.className === className) last.text += token.content;
      else merged.push({ text: token.content, className });
    }
    return merged.length ? merged : [{ text: '', className: '' }];
  });
}
