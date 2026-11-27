// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getFiletypeFromFileName } from '@pierre/diffs';
import type { CodeFile } from './code-data';
import { isMarkdown, plural } from './code-words';

const languageLabels: Readonly<Record<string, string>> = {
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  csv: 'CSV',
  fsharp: 'F#',
  html: 'HTML',
  javascript: 'JavaScript',
  json: 'JSON',
  jsonc: 'JSONC',
  jsonl: 'JSONL',
  jsx: 'JSX',
  mdx: 'MDX',
  scss: 'SCSS',
  sql: 'SQL',
  text: 'Plain text',
  toml: 'TOML',
  tsv: 'TSV',
  tsx: 'TSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
};

function languageOf(path: string) {
  const language = isMarkdown(path) ? 'markdown' : getFiletypeFromFileName(path);
  return Object.hasOwn(languageLabels, language)
    ? languageLabels[language]
    : language.replace(
        /(^|-)([a-z])/g,
        (_, separator: string, letter: string) => (separator ? ' ' : '') + letter.toUpperCase(),
      );
}

export function FileHeading({
  path,
  isFile,
  head,
  lines,
  done,
  where,
}: {
  path: string;
  isFile: boolean;
  head: CodeFile | null;
  lines: number | null;
  done: boolean;
  where: string;
}) {
  const file = isFile && head?.available && head.mode !== 'gitlink' ? head : null;
  const facts = [];
  if (isFile && lines !== null) facts.push(`${plural(lines, 'line')}${done ? '' : ' so far'}`);
  if (file?.page) {
    const { page, mode } = file;
    if (page.size !== undefined) facts.push(plural(page.size, 'byte'));
    facts.push(page.kind === 'binary' ? 'Binary' : mode === 'symlink' ? 'Symbolic link' : languageOf(path));
  }
  return (
    <div className="file-heading">
      <h2 className="mono cut path-cut" style={{ fontWeight: 'var(--w-medium)' }} title={path}>
        {isFile ? path.split('/').at(-1) : path || 'Choose a file'}
      </h2>
      {facts.length ? <div className="hint">{[...facts, where].join(', ')}</div> : null}
    </div>
  );
}
