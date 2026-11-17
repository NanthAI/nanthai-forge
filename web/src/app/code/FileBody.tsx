// SPDX-License-Identifier: Apache-2.0
// One file at an exact State, read in 16,000-character pages: line numbers that are links (#L42), the existing
// highlighter (its worker; nothing parses on the page), binary and submodule files said in words, and the next part
// on request. Long lines scroll inside the file, never the page.
import { useEffect, useMemo, useState } from 'react';
import { requestHighlight } from '../../highlight-client';
import type { SourceToken } from '../../source-highlight';
import type { Source } from './use-source';
import { plural, selectedLine } from './code-words';

// The highlighter's token names, drawn with the design system's code colours.
const tone: Record<string, string> = { k: 'kw', s: 'str', f: 'fn', c: 'cm', t: 'fn' };

function useHash() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);
  return hash;
}

export function FileBody({ file, onMore }: { file: NonNullable<Source['file']>; onMore: () => void }) {
  const text = useMemo(() => file.pages.map(page => page.text).join(''), [file.pages]);
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  const [tokens, setTokens] = useState<{ text: string; lines: SourceToken[][] } | null>(null);
  const hash = useHash();
  const line = selectedLine(hash);
  useEffect(() => {
    let current = true;
    void requestHighlight(file.path, text).then(result => current && setTokens({ text, lines: result }));
    return () => void (current = false);
  }, [file.path, text]);
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
                {drawn?.[index]
                  ? drawn[index]!.map((token, i) =>
                      tone[token.className] ? (
                        <span key={i} className={tone[token.className]}>
                          {token.text}
                        </span>
                      ) : (
                        token.text
                      ),
                    )
                  : source}
              </span>
            </div>
          );
        })}
      </div>
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
