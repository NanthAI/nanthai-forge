// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One file at an exact State, read in 16,000-character pages: line numbers that are links (#L42), syntax colours from
// the highlight worker (nothing is tokenized on the page), binary and submodule files said in words, and the next part
// on request. A Markdown file opens as a document with a Source toggle (Item 8e847a17). Long lines scroll inside the
// file, never the page.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Tokens } from '../../code-tokens';
import { Segment } from '../../ds';
import { requestHighlight } from '../../highlight-client';
import type { SourceToken } from '../../source-highlight';
import type { MarkdownSource } from './MarkdownFile';
import type { Source } from './use-source';
import { plural, selectedLine } from './code-words';

const MarkdownFile = lazy(() => import('./MarkdownFile'));
const isMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

function useHash() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);
  return hash;
}

export function FileBody({
  file,
  onMore,
  repo,
}: {
  file: NonNullable<Source['file']>;
  onMore: () => void;
  /** Where a Markdown file's links and images resolve; without it every file reads as source. */
  repo?: Omit<MarkdownSource, 'path'>;
}) {
  const text = useMemo(() => file.pages.map(page => page.text).join(''), [file.pages]);
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  const [tokens, setTokens] = useState<{ text: string; lines: SourceToken[][] } | null>(null);
  const hash = useHash();
  const line = selectedLine(hash);
  // A link to one line (#L42) is a link into the source.
  const [view, setView] = useState<'document' | 'source'>(() =>
    selectedLine(location.hash) ? 'source' : 'document',
  );
  const asDocument = Boolean(repo) && isMarkdown(file.path) && view === 'document' && !line;
  useEffect(() => {
    if (asDocument) return;
    let current = true;
    void requestHighlight(file.path, text).then(result => current && setTokens({ text, lines: result }));
    return () => void (current = false);
  }, [file.path, text, asDocument]);
  useEffect(() => {
    if (line) document.getElementById(`L${line}`)?.scrollIntoView({ block: 'center' });
  }, [line, lines.length]);
  const head = file.head;
  if (!head.available)
    return <p className="pad t2">{head.reason ?? 'This file is not available in this State.'}</p>;
  if (head.mode === 'gitlink')
    return (
      <p className="pad t2">
        A submodule: this State points it at another repository's commit. Its files are not stored here.
      </p>
    );
  if (head.page?.kind === 'binary')
    return (
      <p className="pad t2">A binary file of {plural(head.page.size, 'byte')}. It is not shown as text.</p>
    );
  const last = file.pages.at(-1);
  const drawn = tokens?.text === text ? tokens.lines : null;
  return (
    <>
      {repo && isMarkdown(file.path) ? (
        <div className="mdbar">
          <Segment
            label="Markdown view"
            value={asDocument ? 'document' : 'source'}
            onChange={next => {
              setView(next);
              // Choosing Rendered leaves a #L42 link, which would otherwise keep the source on screen.
              if (next === 'document' && line) {
                history.replaceState(null, '', location.pathname + location.search);
                dispatchEvent(new HashChangeEvent('hashchange'));
              }
            }}
            options={[
              { value: 'document', text: 'Rendered' },
              { value: 'source', text: 'Source' },
            ]}
          />
        </div>
      ) : null}
      {asDocument ? (
        <Suspense
          fallback={
            <p className="pad t3" aria-busy="true">
              Reading…
            </p>
          }
        >
          <MarkdownFile text={text} source={{ ...repo!, path: file.path }} />
        </Suspense>
      ) : (
        <div
          className="code codefile"
          role="region"
          aria-label={`${file.path}, ${plural(lines.length, 'line')}`}
          tabIndex={0}
        >
          {lines.map((source, index) => {
            const n = index + 1;
            return (
              <div key={n} id={`L${n}`} className={`l${line === n ? ' sel' : ''}`}>
                <a className="n" href={`#L${n}`} aria-label={`Line ${n}`}>
                  {n}
                </a>
                <span className="c">
                  <Tokens tokens={drawn?.[index]} text={source} />
                </span>
              </div>
            );
          })}
        </div>
      )}
      {last && last.nextOffset !== null ? (
        <div className="pf">
          Showing {last.nextOffset.toLocaleString()} of {last.totalCharacters.toLocaleString()} characters.{' '}
          <button type="button" className="btn sm" onClick={onMore}>
            Read the next part
          </button>
        </div>
      ) : null}
    </>
  );
}
